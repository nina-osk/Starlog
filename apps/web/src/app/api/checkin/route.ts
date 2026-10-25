import { z } from "zod";
import { requireRole } from "@/server/auth/current-user";
import { errorResponse, json } from "@/server/http";
import { checkIn } from "@/server/tickets";

const body = z.object({ payload: z.string().min(1).max(200) });

/** Door check-in: verifies a ticket's QR code and mints the attendee's event stamp. */
export async function POST(req: Request) {
  const staff = await requireRole("staff", "organizer", "admin");
  if (!staff) return json({ error: "Solo el staff del evento puede hacer check-in." }, { status: 403 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "Falta el código del ticket." }, { status: 400 });
  try {
    return json(await checkIn(staff, parsed.data.payload));
  } catch (err) {
    return errorResponse(err);
  }
}
