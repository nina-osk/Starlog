import { timingSafeEqual } from "node:crypto";
import { env } from "@/server/env";
import { errorResponse, json } from "@/server/http";
import { mintTripStamps } from "@/server/jobs/trip-stamps";

/**
 * Daily job: trip stamps for completed trips. Vercel Cron calls it with
 * `Authorization: Bearer $CRON_SECRET` (see vercel.json); so can anyone holding it.
 */
export async function GET(req: Request) {
  const secret = env().CRON_SECRET;
  const given = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const ok = given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) return json({ error: "No autorizado." }, { status: 401 });
  try {
    return json(await mintTripStamps());
  } catch (err) {
    return errorResponse(err);
  }
}
