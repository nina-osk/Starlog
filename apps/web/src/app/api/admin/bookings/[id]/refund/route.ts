import { z } from "zod";
import { adminRefund } from "@/server/admin";
import { requireRole } from "@/server/auth/current-user";
import { errorResponse, json } from "@/server/http";

const units = z.string().regex(/^\d+$/).transform((s) => BigInt(s));
const body = z.object({ toTraveler: units.optional(), toPayee: units.optional() });

/** Refunds a booking still held in the escrow. Body amounts are base units; full refund by default. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireRole("admin"))) return json({ error: "Solo para administradores." }, { status: 403 });
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return json({ error: "Reserva no válida." }, { status: 400 });
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return json({ error: "Montos no válidos." }, { status: 400 });
  try {
    return json(await adminRefund(id, parsed.data.toTraveler, parsed.data.toPayee));
  } catch (err) {
    return errorResponse(err);
  }
}
