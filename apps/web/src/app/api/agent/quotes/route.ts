import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { membership } from "@/server/chain";
import { db, schema } from "@/server/db";
import { DuffelError, getOffer } from "@/server/duffel";
import { env } from "@/server/env";
import { errorResponse, json } from "@/server/http";
import { formatAmount, pricePackage } from "@/server/pricing";
import { agentPrice, withAgentPayment } from "@/server/x402";

const body = z.object({
  offerId: z.string().startsWith("off_"),
  payWith: z.enum(["EURC", "USDC", "XLM"]).default("EURC"),
  eventId: z.number().int().positive().optional(),
  // The traveler's wallet, to apply their Estela Pass discount (read on-chain).
  traveler: z.string().regex(/^G[A-Z2-7]{55}$/).optional(),
});

/**
 * Exact price of a flight (+ ticket) package as Estela would charge it, 0.005 USDC per
 * call via x402. Booking itself goes through the escrow (/api/bookings/package).
 */
export const POST = withAgentPayment(
  async (req: NextRequest) => {
    const parsed = body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: "offerId is required" }, { status: 400 });
    const q = parsed.data;
    try {
      const offer = await getOffer(q.offerId);
      if (q.payWith !== "XLM" && offer.totalCurrency !== (q.payWith === "EURC" ? "EUR" : "USD")) {
        return json({ error: `this flight is priced in ${offer.totalCurrency}` }, { status: 400 });
      }
      let ticket: { price: bigint; commissionBps: number } | undefined;
      if (q.eventId !== undefined) {
        const [row] = await db()
          .select({ price: schema.events.ticketPrice, currency: schema.events.currency, bps: schema.organizers.commissionBps })
          .from(schema.events)
          .innerJoin(schema.organizers, eq(schema.events.organizerId, schema.organizers.id))
          .where(eq(schema.events.id, q.eventId));
        if (!row?.price) return json({ error: "event not found or has no tickets" }, { status: 404 });
        if (row.currency !== q.payWith) return json({ error: `the ticket is sold in ${row.currency}` }, { status: 400 });
        ticket = { price: BigInt(row.price), commissionBps: row.bps };
      }
      const discountBps = q.traveler ? (await membership(q.traveler)).discountBps : 0;
      const price = pricePackage({
        flightTotal: offer.totalAmount,
        serviceFee: env().FLIGHT_SERVICE_FEE,
        passengers: 1,
        ticket,
        discountBps,
        rate: q.payWith === "XLM" ? env().DEMO_XLM_PER_FIAT : "1",
      });
      return json({
        offerId: offer.id,
        airline: offer.airline,
        expiresAt: offer.expiresAt,
        currency: q.payWith,
        total: formatAmount(price.amount),
        breakdown: {
          flight: `${offer.totalAmount} ${offer.totalCurrency}`,
          serviceFee: `${env().FLIGHT_SERVICE_FEE} ${offer.totalCurrency}`,
          ticket: ticket ? formatAmount(ticket.price) : null,
          memberDiscount: formatAmount(price.discount),
        },
        book: "POST /api/bookings/package (sign in with SEP-10, then sign the returned fund transaction)",
      });
    } catch (err) {
      if (err instanceof DuffelError) return json({ error: "offer not available: search again" }, { status: 410 });
      return errorResponse(err);
    }
  },
  agentPrice("$0.005", "Estela: exact package quote (flight + service fee + optional event ticket − member discount)"),
);
