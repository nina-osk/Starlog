import type { NextRequest } from "next/server";
import { z } from "zod";
import { DuffelError, searchFlights } from "@/server/duffel";
import { errorResponse, json } from "@/server/http";
import { agentPrice, withAgentPayment } from "@/server/x402";

const iata = z.string().regex(/^[A-Za-z]{3}$/).transform((s) => s.toUpperCase());
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const body = z.object({ origin: iata, destination: iata, departureDate: day, returnDate: day.optional() });

/**
 * Flight offers for agents, 0.01 USDC per call via x402 (no Estela login: the payment
 * is the credential). Bad input or supplier errors aren't charged.
 */
export const POST = withAgentPayment(
  async (req: NextRequest) => {
    const parsed = body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: "origin, destination (IATA) and departureDate are required" }, { status: 400 });
    try {
      return json({ offers: await searchFlights({ ...parsed.data, adults: 1 }) });
    } catch (err) {
      if (err instanceof DuffelError && err.status < 500) return json({ error: "no flights for that search" }, { status: 400 });
      return errorResponse(err);
    }
  },
  agentPrice("$0.01", "Estela: flight offers (one adult, economy, cheapest first)"),
);
