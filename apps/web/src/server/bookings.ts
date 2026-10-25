import "server-only";
import { randomBytes } from "node:crypto";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import type { Session } from "./auth/session";
import * as chain from "./chain";
import { db, schema } from "./db";
import { formatAmount, priceTicket, ticketDeadlines } from "./pricing";

const { bookings, events, organizers, quotes, tickets } = schema;

export class BookingError extends Error {
  constructor(message: string, readonly status = 400, readonly code?: string) {
    super(message);
  }
}

type RefundPolicy = { fullRefundUntilHours?: number } | null;

/** Refuses up front a payment the traveler's wallet can't cover, before touching the escrow. */
export async function assertCanPay(wallet: string, currency: chain.Currency, amount: bigint) {
  const balance = await chain.balanceOf(wallet, currency);
  if (balance < amount) {
    throw new BookingError(
      `Saldo insuficiente: necesitas ${formatAmount(amount)} ${currency} y tienes ${formatAmount(balance)} ${currency}.`,
      402,
    );
  }
}

/**
 * Refuses a booking whose release would fail: the treasury and the organizer must be
 * able to receive the token (a USDC/EURC trustline), or the traveler's money would
 * be stuck in the escrow until refunded.
 */
export async function assertCanSettle(currency: chain.Currency, payee?: string | null) {
  const [treasuryOk, payeeOk] = await Promise.all([
    chain.treasuryAddress().then((t) => chain.canReceive(t, currency)),
    payee ? chain.canReceive(payee, currency) : Promise.resolve(true),
  ]);
  if (!treasuryOk) throw new BookingError(`Por ahora no podemos cobrar en ${currency}. Elige otra moneda.`, 503);
  if (!payeeOk) throw new BookingError(`El organizador todavía no puede cobrar en ${currency}. Elige otra moneda.`, 503);
}

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
  if (!row || row.event.status !== "published") throw new BookingError("No encontramos ese evento.", 404);
  const { event, organizer } = row;
  if (!event.ticketPrice) throw new BookingError("Este evento no vende tickets.");
  if (event.startsAt <= new Date()) throw new BookingError("Este evento ya empezó.");

  const resumed = await resumeOwnBooking(session, eventId, BigInt(event.ticketPrice));
  if (resumed) return resumed;

  if (event.capacity !== null) {
    const [{ sold }] = await database
      .select({ sold: count() })
      .from(bookings)
      .where(and(eq(bookings.eventId, eventId), inArray(bookings.status, ["escrow_created", "funded", "confirmed"])));
    if (sold >= event.capacity) throw new BookingError("Entradas agotadas.", 409);
  }

  await assertCanSettle(event.currency, organizer.payoutWallet);
  const { discountBps } = await chain.membership(session.wallet);
  const price = priceTicket(BigInt(event.ticketPrice), organizer.commissionBps, discountBps);
  await assertCanPay(session.wallet, event.currency, price.amount);
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
    return { bookingId: booking.id, price, payBefore: deadlines.payBefore, fundXdr, alreadyPaid: false };
  } catch (err) {
    await database.update(bookings).set({ status: "failed", updatedAt: new Date() }).where(eq(bookings.id, booking.id));
    throw err;
  }
}

/**
 * One live booking per traveler and event. A confirmed one blocks a second purchase;
 * an unpaid one still inside its pay window is handed back (so cancelling the Pollar
 * prompt and retrying doesn't create another); one already paid on-chain only needs
 * confirming. Unpaid bookings past their window are marked expired.
 */
async function resumeOwnBooking(session: Session, eventId: number, ticketPrice: bigint) {
  const database = db();
  const [mine] = await database
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.userId, session.userId),
        eq(bookings.eventId, eventId),
        inArray(bookings.status, ["escrow_created", "funded", "confirmed"]),
      ),
    )
    .orderBy(desc(bookings.id))
    .limit(1);
  if (!mine) return null;
  if (mine.status === "confirmed") throw new BookingError("Ya tienes un ticket para este evento.", 409);

  const amount = BigInt(mine.amount);
  const payeeAmount = BigInt(mine.payeeAmount);
  const price = { amount, payeeAmount, commission: amount - payeeAmount, discount: ticketPrice - amount };
  const base = { bookingId: mine.id, price, payBefore: mine.payBefore };

  const onChain = await chain.getBooking(BigInt(mine.id));
  if (onChain?.status.tag === "Funded" || onChain?.status.tag === "Released") {
    return { ...base, fundXdr: null, alreadyPaid: true };
  }
  if (onChain?.status.tag === "Pending" && mine.payBefore > new Date()) {
    return { ...base, fundXdr: await chain.buildFundTx(BigInt(mine.id), session.wallet), alreadyPaid: false };
  }
  await database.update(bookings).set({ status: "expired", updatedAt: new Date() }).where(eq(bookings.id, mine.id));
  return null;
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
  if (!booking) throw new BookingError("No encontramos esa reserva.", 404);

  if (booking.status !== "confirmed") {
    const onChain = await chain.getBooking(BigInt(bookingId));
    const status = onChain?.status.tag;
    if (status === "Pending") throw new BookingError("Todavía no recibimos tu pago. Espera unos segundos.", 409, "payment_pending");
    if (status !== "Funded" && status !== "Released") {
      throw new BookingError(`No se puede confirmar esta reserva (estado en el escrow: ${status ?? "no existe"}).`, 409);
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
