import { z } from "zod";
import { currentSession } from "@/server/auth/current-user";
import { DuffelError, searchFlights } from "@/server/duffel";
import { errorResponse, json, unauthorized } from "@/server/http";

const iata = z.string().regex(/^[A-Za-z]{3}$/).transform((s) => s.toUpperCase());
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const body = z.object({
  origin: iata,
  destination: iata,
  departureDate: day,
  returnDate: day.optional(),
});

/** Flight offers (cheapest first) for the package builder. One adult for now. */
export async function POST(req: Request) {
  if (!(await currentSession())) return unauthorized();
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "Indica el aeropuerto de origen (3 letras) y la fecha." }, { status: 400 });
  try {
    return json(await searchFlights({ ...parsed.data, adults: 1 }));
  } catch (err) {
    if (err instanceof DuffelError && err.status < 500) {
      return json({ error: "No encontramos vuelos con esos datos. Revisa el aeropuerto (3 letras, p. ej. LIS) y la fecha." }, { status: 400 });
    }
    return errorResponse(err);
  }
}
