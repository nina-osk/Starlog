import { and, desc, eq, isNull } from "drizzle-orm";
import { currentSession } from "@/server/auth/current-user";
import { db, schema } from "@/server/db";
import { errorResponse, json, unauthorized } from "@/server/http";

/** The member's stamps (as recorded at mint time), newest first. */
export async function GET() {
  const session = await currentSession();
  if (!session) return unauthorized();
  try {
    const { stamps } = schema;
    const rows = await db()
      .select({ tokenId: stamps.tokenId, kind: stamps.kind, refId: stamps.refId, createdAt: stamps.createdAt })
      .from(stamps)
      .where(and(eq(stamps.userId, session.userId), isNull(stamps.revokedAt)))
      .orderBy(desc(stamps.createdAt));
    return json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}
