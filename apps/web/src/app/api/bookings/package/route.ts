import { z } from "zod";
import { currentSession } from "@/server/auth/current-user";
import { errorResponse, json, unauthorized } from "@/server/http";
import { startPackageBooking } from "@/server/packages";

const body = z.object({
  offerId: z.string().startsWith("off_"),
  payWith: z.enum(["EURC", "USDC", "XLM"]),
  eventId: z.number().int().positive().optional(),
  passenger: z.object({
    title: z.enum(["mr", "ms", "mrs", "miss"]),
    gender: z.enum(["m", "f"]),
    givenName: z.string().trim().min(1).max(60),
    familyName: z.string().trim().min(1).max(60),
    bornOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    email: z.string().email(),
    // E.164, as airlines require: +34600000000
    phoneNumber: z.string().regex(/^\+[1-9]\d{6,14}$/),
  }),
});

/** Starts a flight (+ ticket) package; returns the fund transaction for Pollar. */
export async function POST(req: Request) {
  const session = await currentSession();
  if (!session) return unauthorized();
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join(".") ?? "body";
    return json({ error: `invalid ${field}` }, { status: 400 });
  }
  try {
    return json(await startPackageBooking(session, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
