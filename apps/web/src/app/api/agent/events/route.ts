import { and, asc, eq, gt } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { errorResponse, json } from "@/server/http";

/** Free for agents: upcoming events and how to book them (discovery). */
export async function GET() {
  try {
    const { events } = schema;
    const rows = await db()
      .select({
        id: events.id,
        title: events.title,
        city: events.city,
        country: events.country,
        airport: events.airport,
        startsAt: events.startsAt,
        ticketPrice: events.ticketPrice,
        currency: events.currency,
      })
      .from(events)
      .where(and(eq(events.status, "published"), gt(events.startsAt, new Date())))
      .orderBy(asc(events.startsAt));
    return json({
      events: rows,
      paidEndpoints: {
        "POST /api/agent/flights/search": "0.01 USDC per call (x402, stellar:testnet)",
        "POST /api/agent/quotes": "0.005 USDC per call (x402, stellar:testnet)",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
