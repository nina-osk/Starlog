import "server-only";
import { desc, eq } from "drizzle-orm";
import { BookingError } from "./bookings";
import * as chain from "./chain";
import { db, schema } from "./db";
import { env } from "./env";

const { bookings, events, quotes, users } = schema;

/** Latest bookings with who booked them and what they bought. */
export async function listBookings(limit = 100) {
  const rows = await db()
    .select({
      id: bookings.id,
      kind: bookings.kind,
      status: bookings.status,
      currency: bookings.currency,
      amount: bookings.amount,
      payeeAmount: bookings.payeeAmount,
      duffelOrderId: bookings.duffelOrderId,
      createdAt: bookings.createdAt,
      payBefore: bookings.payBefore,
      wallet: users.wallet,
      event: events.title,
      items: quotes.items,
    })
    .from(bookings)
    .innerJoin(users, eq(bookings.userId, users.id))
    .innerJoin(quotes, eq(bookings.quoteId, quotes.id))
    .leftJoin(events, eq(bookings.eventId, events.id))
    .orderBy(desc(bookings.id))
    .limit(limit);
  // Only the flight reference leaves the server: passenger details stay private.
  return rows.map(({ items, ...b }) => ({
    ...b,
    bookingReference: (items as { order?: { bookingReference?: string } }).order?.bookingReference ?? null,
  }));
}

/**
 * Admin refund while the money is still in the escrow (Funded): `toTraveler` back to
 * the traveler, `toPayee` to the organizer, the rest to the treasury. Defaults to a
 * full refund. Released bookings must be refunded off-chain from the treasury.
 */
export async function adminRefund(bookingId: number, toTraveler?: bigint, toPayee = BigInt(0)) {
  const database = db();
  const [booking] = await database.select().from(bookings).where(eq(bookings.id, bookingId));
  if (!booking) throw new BookingError("No encontramos esa reserva.", 404);
  const onChain = await chain.getBooking(BigInt(bookingId));
  const status = onChain?.status.tag;
  if (status === "Released") {
    throw new BookingError("Esta reserva ya se liberó: el reembolso hay que hacerlo desde la treasury, fuera del escrow.", 409);
  }
  if (status !== "Funded") throw new BookingError(`No hay nada que reembolsar (estado en el escrow: ${status ?? "no existe"}).`, 409);

  const amount = BigInt(booking.amount);
  const back = toTraveler ?? amount;
  if (back < BigInt(0) || toPayee < BigInt(0) || back + toPayee > amount) {
    throw new BookingError("Los montos del reembolso superan lo pagado.");
  }
  const hash = await chain.refund(BigInt(bookingId), back, toPayee);
  await database
    .update(bookings)
    .set({
      status: "refunded",
      txHashes: { ...(booking.txHashes as Record<string, string>), refund: hash },
      updatedAt: new Date(),
    })
    .where(eq(bookings.id, bookingId));
  return { bookingId, refundHash: hash, toTraveler: back, toPayee };
}

type HorizonBalance = { asset_type: string; asset_code?: string; asset_issuer?: string; balance: string };

/** Treasury balances on-chain (what has been released to Estela and not yet off-ramped). */
export async function treasury() {
  const address = await chain.treasuryAddress();
  const res = await fetch(`${env().HORIZON_URL}/accounts/${address}`, { cache: "no-store" });
  if (!res.ok) throw new chain.ChainError(`Horizon: HTTP ${res.status}`);
  const account: { balances: HorizonBalance[] } = await res.json();
  return {
    address,
    balances: account.balances.map((b) => ({
      asset: b.asset_type === "native" ? "XLM" : (b.asset_code ?? "?"),
      issuer: b.asset_issuer ?? null,
      balance: b.balance,
    })),
  };
}
