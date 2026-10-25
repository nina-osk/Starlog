import "server-only";
import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import * as chain from "../chain";
import { db, schema } from "../db";

const { bookings, stamps, users } = schema;

/**
 * Mints the "trip completed" stamp (+50 XP) for every confirmed flight booking whose
 * return date has passed and that has no trip stamp yet. Safe to run repeatedly:
 * the contract also refuses a second stamp for the same booking.
 */
export async function mintTripStamps(today = new Date()) {
  const database = db();
  const due = await database
    .select({ bookingId: bookings.id, userId: users.id, wallet: users.wallet })
    .from(bookings)
    .innerJoin(users, eq(bookings.userId, users.id))
    .leftJoin(
      stamps,
      and(eq(stamps.userId, bookings.userId), eq(stamps.kind, "trip"), eq(stamps.refId, bookings.id)),
    )
    .where(
      and(
        eq(bookings.status, "confirmed"),
        inArray(bookings.kind, ["package", "travel"]),
        lt(bookings.returnDate, today.toISOString().slice(0, 10)),
        isNull(stamps.tokenId),
      ),
    );

  const minted: { bookingId: number; tokenId: number }[] = [];
  const failed: { bookingId: number; error: string }[] = [];
  for (const b of due) {
    try {
      // A previous run may have minted on-chain and then failed to record it.
      let tokenId = await chain.stampOf(b.wallet, "Trip", BigInt(b.bookingId));
      let txHash = "minted-earlier";
      if (tokenId === null) {
        txHash = await chain.mintStamp(b.wallet, "Trip", BigInt(b.bookingId));
        tokenId = await chain.stampOf(b.wallet, "Trip", BigInt(b.bookingId));
      }
      if (tokenId === null) throw new Error("stamp not found after minting");
      await database
        .insert(stamps)
        .values({ tokenId, userId: b.userId, kind: "trip", refId: b.bookingId, txHash })
        .onConflictDoNothing();
      minted.push({ bookingId: b.bookingId, tokenId });
    } catch (err) {
      failed.push({ bookingId: b.bookingId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { checked: due.length, minted, failed };
}
