import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Session } from "./auth/session";
import { BookingError } from "./bookings";
import * as chain from "./chain";
import { db, schema } from "./db";
import * as duffel from "./duffel";
import { env } from "./env";
import { pricePackage, toUnits } from "./pricing";

const { bookings, events, organizers, quotes, tickets } = schema;

export type PayWith = "EURC" | "USDC" | "XLM";

/** What the traveler gives us for the airline (sent to Duffel only at confirmation). */
export type PassengerInput = Omit<duffel.Passenger, "id">;

type PackageItems = {
  offerId: string;
  flightTotal: string;
  flightCurrency: string;
  passengers: duffel.Passenger[];
  rate: string;
  airline: string;
  order?: { orderId: string; bookingReference: string };
};

const PAY_WINDOW_MS = 15 * 60 * 1000;
const CONFIRM_MS = 60 * 60 * 1000;

/** Settlement token and conversion rate for an offer priced in `fiat`. */
function settlement(fiat: string, payWith: PayWith): string {
  if (payWith === "XLM") return env().DEMO_XLM_PER_FIAT;
  const expected = payWith === "EURC" ? "EUR" : "USD";
  if (fiat !== expected) throw new BookingError(`this flight is priced in ${fiat}; pay with ${fiat === "EUR" ? "EURC" : "USDC"}`);
  return "1";
}

/**
 * Starts a flight package (optionally with a partner event's ticket): re-prices the
 * offer, registers the booking in the escrow and returns the fund transaction for
 * Pollar. The flight itself is only bought once the money is in the escrow.
 */
export async function startPackageBooking(
  session: Session,
  input: { offerId: string; passenger: PassengerInput; payWith: PayWith; eventId?: number },
) {
  const database = db();
  const offer = await duffel.getOffer(input.offerId).catch(() => {
    throw new BookingError("this flight offer is no longer available: search again", 410);
  });
  if (offer.passengerIds.length !== 1) throw new BookingError("packages are for one passenger for now");
  const offerExpires = new Date(offer.expiresAt).getTime();
  if (offerExpires < Date.now() + 2 * 60_000) {
    throw new BookingError("this flight offer is about to expire: search again", 410);
  }

  let ticket: { price: bigint; commissionBps: number } | undefined;
  let payee: string | undefined;
  if (input.eventId !== undefined) {
    const [row] = await database
      .select({ event: events, organizer: organizers })
      .from(events)
      .innerJoin(organizers, eq(events.organizerId, organizers.id))
      .where(eq(events.id, input.eventId));
    if (!row || row.event.status !== "published" || !row.event.ticketPrice) {
      throw new BookingError("event not found", 404);
    }
    if (row.event.currency !== input.payWith) {
      throw new BookingError(`this event's ticket is sold in ${row.event.currency}`);
    }
    const [owned] = await database
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          eq(bookings.userId, session.userId),
          eq(bookings.eventId, input.eventId),
          inArray(bookings.status, ["escrow_created", "funded", "confirmed"]),
        ),
      );
    if (owned) throw new BookingError("you already have a ticket for this event: book the flight alone", 409);
    ticket = { price: BigInt(row.event.ticketPrice), commissionBps: row.organizer.commissionBps };
    payee = row.organizer.payoutWallet;
  }

  const rate = settlement(offer.totalCurrency, input.payWith);
  const { discountBps } = await chain.membership(session.wallet);
  const price = pricePackage({
    flightTotal: offer.totalAmount,
    serviceFee: env().FLIGHT_SERVICE_FEE,
    passengers: 1,
    ticket,
    discountBps,
    rate,
  });

  const now = Date.now();
  const payBefore = new Date(Math.min(now + PAY_WINDOW_MS, offerExpires - 60_000));
  const deadlines = {
    payBefore,
    // Flights are bought right after payment and aren't refundable for free.
    refundUntil: new Date(now),
    confirmBy: new Date(payBefore.getTime() + CONFIRM_MS),
  };
  const lastSegment = offer.slices.at(-1)!.segments.at(-1)!;
  const items: PackageItems = {
    offerId: offer.id,
    flightTotal: offer.totalAmount,
    flightCurrency: offer.totalCurrency,
    passengers: [{ ...input.passenger, id: offer.passengerIds[0] }],
    rate,
    airline: offer.airline,
  };
  const kind = ticket ? "package" : "travel";

  const [quote] = await database
    .insert(quotes)
    .values({
      userId: session.userId,
      eventId: input.eventId ?? null,
      kind,
      currency: input.payWith,
      items,
      cost: price.flightCost.toString(),
      price: price.amount.toString(),
      payeeAmount: price.payeeAmount.toString(),
      discountBps,
      expiresAt: payBefore,
    })
    .returning({ id: quotes.id });

  const [booking] = await database
    .insert(bookings)
    .values({
      userId: session.userId,
      quoteId: quote.id,
      eventId: input.eventId ?? null,
      kind,
      currency: input.payWith,
      tokenContract: chain.tokenContract(input.payWith),
      amount: price.amount.toString(),
      payee: payee ?? null,
      payeeAmount: price.payeeAmount.toString(),
      returnDate: lastSegment.arrivingAt.slice(0, 10),
      ...deadlines,
    })
    .returning();

  try {
    const create = await chain.createBooking({
      id: BigInt(booking.id),
      traveler: session.wallet,
      currency: input.payWith,
      amount: price.amount,
      payee,
      payeeAmount: price.payeeAmount,
      ...deadlines,
    });
    await database.update(bookings).set({ txHashes: { create }, updatedAt: new Date() }).where(eq(bookings.id, booking.id));
    const fundXdr = await chain.buildFundTx(BigInt(booking.id), session.wallet);
    return { bookingId: booking.id, price, payBefore, fundXdr, alreadyPaid: false, offer };
  } catch (err) {
    await database.update(bookings).set({ status: "failed", updatedAt: new Date() }).where(eq(bookings.id, booking.id));
    throw err;
  }
}

/**
 * After the traveler paid: buys the flight on Duffel (from Estela's balance) and
 * releases the escrow. If the flight can't be bought at the quoted price, the
 * escrow refunds the traveler in full instead. Safe to retry.
 */
export async function confirmPackageBooking(session: Session, bookingId: number, fundHash?: string) {
  const database = db();
  const [row] = await database
    .select({ booking: bookings, quote: quotes })
    .from(bookings)
    .innerJoin(quotes, eq(bookings.quoteId, quotes.id))
    .where(and(eq(bookings.id, bookingId), eq(bookings.userId, session.userId)));
  if (!row) throw new BookingError("booking not found", 404);
  const { booking, quote } = row;
  const items = quote.items as PackageItems;

  if (booking.status === "confirmed") {
    return { bookingId, status: "confirmed" as const, bookingReference: items.order?.bookingReference ?? null };
  }
  if (booking.status !== "escrow_created" && booking.status !== "funded" && booking.status !== "supplier_booking") {
    throw new BookingError(`booking is ${booking.status}`, 409);
  }

  const onChain = await chain.getBooking(BigInt(bookingId));
  const status = onChain?.status.tag;
  if (status === "Pending") throw new BookingError("the payment hasn't arrived yet", 409);
  if (status !== "Funded") throw new BookingError(`booking can't be confirmed (escrow status: ${status ?? "missing"})`, 409);

  const txHashes: Record<string, string> = { ...(booking.txHashes as Record<string, string>) };
  if (fundHash) txHashes.fund = fundHash;
  const setStatus = (s: (typeof booking)["status"], extra: Partial<typeof booking> = {}) =>
    database.update(bookings).set({ status: s, txHashes, updatedAt: new Date(), ...extra }).where(eq(bookings.id, bookingId));

  const refundAll = async (why: string, status: "refunded" | "failed") => {
    txHashes.refund = await chain.refund(BigInt(bookingId), BigInt(booking.amount), BigInt(0));
    await setStatus(status);
    throw new BookingError(`${why} Your payment was refunded in full.`, 409);
  };

  // Only buy the flight if it still costs what we quoted.
  let order: Awaited<ReturnType<typeof duffel.createOrder>>;
  if (items.order) {
    order = { ...items.order, totalAmount: items.flightTotal, totalCurrency: items.flightCurrency };
  } else {
    await setStatus("supplier_booking");
    let offer: duffel.Offer;
    try {
      offer = await duffel.getOffer(items.offerId);
    } catch {
      return refundAll("The flight offer expired before we could book it.", "refunded");
    }
    if (toUnits(offer.totalAmount) > toUnits(items.flightTotal) || offer.totalCurrency !== items.flightCurrency) {
      return refundAll(`The flight price changed (${offer.totalAmount} ${offer.totalCurrency}).`, "refunded");
    }
    try {
      order = await duffel.createOrder(offer, items.passengers);
    } catch (err) {
      console.error(err);
      return refundAll("The airline couldn't confirm the flight.", "failed");
    }
    // Record the order before releasing, so a retry never books the flight twice.
    await database
      .update(quotes)
      .set({ items: { ...items, order: { orderId: order.orderId, bookingReference: order.bookingReference } } })
      .where(eq(quotes.id, quote.id));
    await setStatus("supplier_booking", { duffelOrderId: order.orderId });
  }

  txHashes.release = await chain.release(BigInt(bookingId));
  await setStatus("confirmed");

  let ticketId: string | null = null;
  if (booking.eventId !== null) {
    const [existing] = await database.select().from(tickets).where(eq(tickets.bookingId, bookingId));
    ticketId =
      existing?.id ??
      (
        await database
          .insert(tickets)
          .values({
            bookingId,
            eventId: booking.eventId,
            userId: session.userId,
            qrSecret: randomBytes(32).toString("base64url"),
          })
          .returning({ id: tickets.id })
      )[0].id;
  }
  return { bookingId, status: "confirmed" as const, bookingReference: order.bookingReference, ticketId };
}
