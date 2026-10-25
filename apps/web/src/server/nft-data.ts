import "server-only";
import { eq } from "drizzle-orm";
import * as chain from "./chain";
import { db, schema } from "./db";
import type { Level, StampArt } from "./nft";

/** Current level and XP behind Estela Pass `tokenId`, or null if it doesn't exist. */
export async function passArt(tokenId: number) {
  const owner = await chain.passOwner(tokenId);
  if (!owner) return null;
  const { xp, level } = await chain.membership(owner);
  return { tokenId, level: level as Level, xp };
}

/** What stamp `tokenId` commemorates, or null if it doesn't exist. */
export async function stampArt(tokenId: number): Promise<StampArt | null> {
  const info = await chain.stampInfo(tokenId);
  if (!info) return null;
  const date = (d: Date) => d.toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" });

  if (info.kind === "Event") {
    const [event] = await db().select().from(schema.events).where(eq(schema.events.id, Number(info.refId)));
    return event
      ? { tokenId, kind: "Event", title: event.title, place: event.city, date: date(event.startsAt) }
      : { tokenId, kind: "Event", title: `Evento #${info.refId}`, place: "", date: "" };
  }
  // Trip stamps point at the booking; its event (if any) names the trip.
  const [row] = await db()
    .select({ title: schema.events.title, city: schema.events.city, at: schema.bookings.returnDate })
    .from(schema.bookings)
    .leftJoin(schema.events, eq(schema.bookings.eventId, schema.events.id))
    .where(eq(schema.bookings.id, Number(info.refId)));
  return {
    tokenId,
    kind: "Trip",
    title: row?.title ?? `Reserva #${info.refId}`,
    place: row?.city ?? "",
    date: row?.at ? date(new Date(row.at)) : "",
  };
}

export const tokenIdParam = (raw: string) => {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id >= 0 ? id : null;
};
