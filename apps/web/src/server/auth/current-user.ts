import "server-only";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { db, schema } from "../db";
import { env } from "../env";
import { readSession, type Role, type Session, SESSION_COOKIE } from "./session";

export async function currentSession(): Promise<Session | null> {
  const jar = await cookies();
  return readSession(env().SESSION_SECRET, jar.get(SESSION_COOKIE)?.value);
}

/**
 * The session if the user's role is one of `roles`, otherwise null. The role is read
 * from the database, not the cookie, so granting or revoking it applies at once.
 */
export async function requireRole(...roles: Role[]): Promise<Session | null> {
  const session = await currentSession();
  if (!session) return null;
  const [user] = await db()
    .select({ role: schema.users.role })
    .from(schema.users)
    .where(eq(schema.users.id, session.userId));
  return user && roles.includes(user.role) ? { ...session, role: user.role } : null;
}

export function sep10Config() {
  const e = env();
  return {
    signingSecret: e.SEP10_SIGNING_SECRET,
    homeDomain: e.HOME_DOMAIN,
    webAuthDomain: e.WEB_AUTH_DOMAIN,
    networkPassphrase: e.STELLAR_NETWORK_PASSPHRASE,
  };
}
