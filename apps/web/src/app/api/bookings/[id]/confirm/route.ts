import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { currentSession } from "@/server/auth/current-user";
import { confirmTicketBooking } from "@/server/bookings";
import { db, schema } from "@/server/db";
import { errorResponse, json, unauthorized } from "@/server/http";
import { confirmPackageBooking } from "@/server/packages";

const body = z.object({ fundHash: z.string().regex(/^[0-9a-f]{64}$/).optional() });

/**
 * After the traveler paid: tickets are released at once; packages first buy the
 * flight on Duffel. Retry-safe.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) return unauthorized();
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return json({ error: "invalid booking id" }, { status: 400 });
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return json({ error: "invalid fundHash" }, { status: 400 });
  try {
    const [booking] = await db()
      .select({ kind: schema.bookings.kind })
      .from(schema.bookings)
      .where(and(eq(schema.bookings.id, id), eq(schema.bookings.userId, session.userId)));
    if (!booking) return json({ error: "booking not found" }, { status: 404 });
    const confirm = booking.kind === "ticket" ? confirmTicketBooking : confirmPackageBooking;
    return json(await confirm(session, id, parsed.data.fundHash));
  } catch (err) {
    return errorResponse(err);
  }
}
