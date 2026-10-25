import { currentSession } from "@/server/auth/current-user";
import { errorResponse, json, unauthorized } from "@/server/http";
import { ticketQr } from "@/server/tickets";

/** The current rotating check-in code for one of the caller's tickets. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) return unauthorized();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "Ticket no válido." }, { status: 400 });
  try {
    return json(await ticketQr(session, id), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
