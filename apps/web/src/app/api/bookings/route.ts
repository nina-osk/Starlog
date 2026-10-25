import { z } from "zod";
import { currentSession } from "@/server/auth/current-user";
import { startTicketBooking } from "@/server/bookings";
import { errorResponse, json, unauthorized } from "@/server/http";

const body = z.object({ eventId: z.number().int().positive() });

/** Starts a ticket purchase; returns the fund transaction to sign with Pollar. */
export async function POST(req: Request) {
  const session = await currentSession();
  if (!session) return unauthorized();
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "Falta el evento." }, { status: 400 });
  try {
    return json(await startTicketBooking(session, parsed.data.eventId), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
