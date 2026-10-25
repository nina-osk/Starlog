import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Session } from "./auth/session";
import { assertCanPay, assertCanSettle, BookingError } from "./bookings";
import * as chain from "./chain";
import { db, schema } from "./db";
import * as duffel from "./duffel";
import { env } from "./env";
import { assertAdultOnFlight, PassengerError } from "./passenger";
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
  if (fiat !== expected) throw new BookingError(`Este vuelo se cobra en ${fiat}: paga con ${fiat === "EUR" ? "EURC" : "USDC"}.`);
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
    throw new BookingError("Esa oferta de vuelo ya no está disponible. Busca de nuevo.", 410);
  });
  if (offer.passengerIds.length !== 1) throw new BookingError("Por ahora los paquetes son para un solo pasajero.");
  // Airlines reject bad passenger data only when ordering, i.e. after payment; catch
  // it here so the traveler never pays for a booking that would be refunded.
  try {
    assertAdultOnFlight(input.passenger.bornOn, offer.slices[0].segments[0].departingAt);
  } catch (err) {
    if (err instanceof PassengerError) throw new BookingError(err.message);
    throw err;
  }
  const offerExpires = new Date(offer.expiresAt).getTime();
  if (offerExpires < Date.now() + 2 * 60_000) {
    throw new BookingError("Esa oferta de vuelo está por vencer. Busca de nuevo.", 410);
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
      throw new BookingError("No encontramos ese evento.", 404);
    }
    if (row.event.currency !== input.payWith) {
      throw new BookingError(`El ticket de este evento se paga en ${row.event.currency}.`);
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
    if (owned) throw new BookingError("Ya tienes un ticket para este evento: reserva solo el vuelo.", 409);
    ticket = { price: BigInt(row.event.ticketPrice), commissionBps: row.organizer.commissionBps };
    payee = row.organizer.payoutWallet;
  }

  const rate = settlement(offer.totalCurrency, input.payWith);
  await assertCanSettle(input.payWith, payee);
  const { discountBps } = await chain.membership(session.wallet);
  const price = pricePackage({
    flightTotal: offer.totalAmount,
    serviceFee: env().FLIGHT_SERVICE_FEE,
    passengers: 1,
    ticket,
    discountBps,
    rate,
  });
  await assertCanPay(session.wallet, input.payWith, price.amount);

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
  if (!row) throw new BookingError("No encontramos esa reserva.", 404);
  const { booking, quote } = row;
  const items = quote.items as PackageItems;

  if (booking.status === "confirmed") {
    return { bookingId, status: "confirmed" as const, bookingReference: items.order?.bookingReference ?? null };
  }
  if (booking.status !== "escrow_created" && booking.status !== "funded" && booking.status !== "supplier_booking") {
    throw new BookingError(`Esta reserva ya no se puede confirmar (estado: ${booking.status}).`, 409);
  }

  const onChain = await chain.getBooking(BigInt(bookingId));
  const status = onChain?.status.tag;
  if (status === "Pending") throw new BookingError("Todavía no recibimos tu pago. Espera unos segundos.", 409, "payment_pending");
  if (status !== "Funded") throw new BookingError(`No se puede confirmar esta reserva (estado en el escrow: ${status ?? "no existe"}).`, 409);

  const txHashes: Record<string, string> = { ...(booking.txHashes as Record<string, string>) };
  if (fundHash) txHashes.fund = fundHash;
  const setStatus = (s: (typeof booking)["status"], extra: Partial<typeof booking> = {}) =>
    database.update(bookings).set({ status: s, txHashes, updatedAt: new Date(), ...extra }).where(eq(bookings.id, bookingId));

  const refundAll = async (why: string, status: "refunded" | "failed") => {
    txHashes.refund = await chain.refund(BigInt(bookingId), BigInt(booking.amount), BigInt(0));
    await setStatus(status);
    throw new BookingError(`${why} Te devolvimos el pago completo.`, 409);
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
      return refundAll("La oferta del vuelo venció antes de poder reservarlo.", "refunded");
    }
    if (toUnits(offer.totalAmount) > toUnits(items.flightTotal) || offer.totalCurrency !== items.flightCurrency) {
      return refundAll(`El precio del vuelo cambió (${offer.totalAmount} ${offer.totalCurrency}).`, "refunded");
    }
    try {
      order = await duffel.createOrder(offer, items.passengers);
    } catch (err) {
      console.error(err);
      // 4xx from Duffel on ordering means the airline refused the passenger details.
      const badData = err instanceof duffel.DuffelError && err.status >= 400 && err.status < 500;
      return refundAll(
        badData
          ? "La aerolínea rechazó los datos del pasajero (revisa nombre, fecha de nacimiento, email y teléfono)."
          : "La aerolínea no pudo confirmar el vuelo.",
        "failed",
      );
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
