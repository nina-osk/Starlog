import { and, asc, eq, gt } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { errorResponse, json } from "@/server/http";

/** Published upcoming events, soonest first. */
export async function GET() {
  try {
    const { events } = schema;
    const rows = await db()
      .select({
        id: events.id,
        title: events.title,
        description: events.description,
        venue: events.venue,
        city: events.city,
        airport: events.airport,
        country: events.country,
        startsAt: events.startsAt,
        ticketPrice: events.ticketPrice,
        currency: events.currency,
        source: events.source,
        lumaUrl: events.lumaUrl,
      })
      .from(events)
      .where(and(eq(events.status, "published"), gt(events.startsAt, new Date())))
      .orderBy(asc(events.startsAt));
    return json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}
