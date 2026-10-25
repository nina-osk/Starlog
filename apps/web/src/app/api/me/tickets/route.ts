import { currentSession } from "@/server/auth/current-user";
import { errorResponse, json, unauthorized } from "@/server/http";
import { myTickets } from "@/server/tickets";

export async function GET() {
  const session = await currentSession();
  if (!session) return unauthorized();
  try {
    return json(await myTickets(session));
  } catch (err) {
    return errorResponse(err);
  }
}
