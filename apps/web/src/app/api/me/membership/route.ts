import { currentSession } from "@/server/auth/current-user";
import { membership } from "@/server/chain";
import { errorResponse, json, unauthorized } from "@/server/http";

/** The signed-in member's Estela Pass: XP, level and discount, read on-chain. */
export async function GET() {
  const session = await currentSession();
  if (!session) return unauthorized();
  try {
    return json(await membership(session.wallet));
  } catch (err) {
    return errorResponse(err);
  }
}
