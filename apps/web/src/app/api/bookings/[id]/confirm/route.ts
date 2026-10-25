import { z } from "zod";
import { currentSession } from "@/server/auth/current-user";
import { confirmTicketBooking } from "@/server/bookings";
import { errorResponse, json, unauthorized } from "@/server/http";

const body = z.object({ fundHash: z.string().regex(/^[0-9a-f]{64}$/).optional() });

/** After the traveler paid: releases the escrow and issues the ticket. Retry-safe. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) return unauthorized();
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return json({ error: "invalid booking id" }, { status: 400 });
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return json({ error: "invalid fundHash" }, { status: 400 });
  try {
    return json(await confirmTicketBooking(session, id, parsed.data.fundHash));
  } catch (err) {
    return errorResponse(err);
  }
}
