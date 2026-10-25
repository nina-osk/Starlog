import "server-only";
import { randomBytes } from "node:crypto";
import { and, count, eq, inArray } from "drizzle-orm";
import type { Session } from "./auth/session";
import * as chain from "./chain";
import { db, schema } from "./db";
import { priceTicket, ticketDeadlines } from "./pricing";

const { bookings, events, organizers, quotes, tickets } = schema;

export class BookingError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

type RefundPolicy = { fullRefundUntilHours?: number } | null;

/**
 * Starts a ticket purchase for a partner event: prices it (member discount from
 * Estela's commission), registers the booking in the escrow and returns the `fund`
 * transaction for the traveler to sign with Pollar.
 */
export async function startTicketBooking(session: Session, eventId: number) {
  const database = db();
  const [row] = await database
    .select({ event: events, organizer: organizers })
    .from(events)
    .innerJoin(organizers, eq(events.organizerId, organizers.id))
    .where(eq(events.id, eventId));
  if (!row || row.event.status !== "published") throw new BookingError("event not found", 404);
  const { event, organizer } = row;
  if (!event.ticketPrice) throw new BookingError("this event has no paid tickets");
  if (event.startsAt <= new Date()) throw new BookingError("this event has already started");

  if (event.capacity !== null) {
    const [{ sold }] = await database
      .select({ sold: count() })
      .from(bookings)
      .where(and(eq(bookings.eventId, eventId), inArray(bookings.status, ["escrow_created", "funded", "confirmed"])));
    if (sold >= event.capacity) throw new BookingError("sold out", 409);
  }

  const { discountBps } = await chain.membership(session.wallet);
  const price = priceTicket(BigInt(event.ticketPrice), organizer.commissionBps, discountBps);
  const now = new Date();
  const policy = event.refundPolicy as RefundPolicy;
  const deadlines = ticketDeadlines(now, event.startsAt, policy?.fullRefundUntilHours);

  const [quote] = await database
    .insert(quotes)
    .values({
      userId: session.userId,
      eventId,
      kind: "ticket",
      currency: event.currency,
      items: { ticket: { eventId, price: event.ticketPrice } },
      cost: price.payeeAmount.toString(),
      price: price.amount.toString(),
      payeeAmount: price.payeeAmount.toString(),
      discountBps,
      expiresAt: deadlines.payBefore,
    })
    .returning({ id: quotes.id });

  const [booking] = await database
    .insert(bookings)
    .values({
      userId: session.userId,
      quoteId: quote.id,
      eventId,
      kind: "ticket",
      currency: event.currency,
      tokenContract: chain.tokenContract(event.currency),
      amount: price.amount.toString(),
      payee: organizer.payoutWallet,
      payeeAmount: price.payeeAmount.toString(),
      ...deadlines,
    })
    .returning();

  try {
    const createHash = await chain.createBooking({
      id: BigInt(booking.id),
      traveler: session.wallet,
      currency: event.currency,
      amount: price.amount,
      payee: organizer.payoutWallet,
      payeeAmount: price.payeeAmount,
      ...deadlines,
    });
    await database
      .update(bookings)
      .set({ txHashes: { create: createHash }, updatedAt: new Date() })
      .where(eq(bookings.id, booking.id));
    const fundXdr = await chain.buildFundTx(BigInt(booking.id), session.wallet);
    return { bookingId: booking.id, price, payBefore: deadlines.payBefore, fundXdr };
  } catch (err) {
    await database.update(bookings).set({ status: "failed", updatedAt: new Date() }).where(eq(bookings.id, booking.id));
    throw err;
  }
}

/**
 * Called once the traveler's fund transaction went through: checks the escrow,
 * releases it (organizer paid, XP awarded) and issues the ticket. Safe to retry.
 */
export async function confirmTicketBooking(session: Session, bookingId: number, fundHash?: string) {
  const database = db();
  const [booking] = await database
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.userId, session.userId)));
  if (!booking) throw new BookingError("booking not found", 404);

  if (booking.status !== "confirmed") {
    const onChain = await chain.getBooking(BigInt(bookingId));
    const status = onChain?.status.tag;
    if (status === "Pending") throw new BookingError("the payment hasn't arrived yet", 409);
    if (status !== "Funded" && status !== "Released") {
      throw new BookingError(`booking can't be confirmed (escrow status: ${status ?? "missing"})`, 409);
    }
    const txHashes: Record<string, string> = { ...(booking.txHashes as Record<string, string>) };
    if (fundHash) txHashes.fund = fundHash;
    if (status === "Funded") txHashes.release = await chain.release(BigInt(bookingId));
    await database
      .update(bookings)
      .set({ status: "confirmed", txHashes, updatedAt: new Date() })
      .where(eq(bookings.id, bookingId));
  }

  let [ticket] = await database.select().from(tickets).where(eq(tickets.bookingId, bookingId));
  if (!ticket && booking.eventId !== null) {
    [ticket] = await database
      .insert(tickets)
      .values({
        bookingId,
        eventId: booking.eventId,
        userId: session.userId,
        qrSecret: randomBytes(32).toString("base64url"),
      })
      .returning();
  }
  return { bookingId, status: "confirmed" as const, ticketId: ticket?.id ?? null };
}
