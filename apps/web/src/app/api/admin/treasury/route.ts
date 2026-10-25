import { treasury } from "@/server/admin";
import { requireRole } from "@/server/auth/current-user";
import { errorResponse, json } from "@/server/http";

export async function GET() {
  if (!(await requireRole("admin"))) return json({ error: "Solo para administradores." }, { status: 403 });
  try {
    return json(await treasury());
  } catch (err) {
    return errorResponse(err);
  }
}
