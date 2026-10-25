import "server-only";
import { cookies } from "next/headers";
import { env } from "../env";
import { readSession, type Role, type Session, SESSION_COOKIE } from "./session";

export async function currentSession(): Promise<Session | null> {
  const jar = await cookies();
  return readSession(env().SESSION_SECRET, jar.get(SESSION_COOKIE)?.value);
}

/** The session if its role is one of `roles`, otherwise null. */
export async function requireRole(...roles: Role[]): Promise<Session | null> {
  const session = await currentSession();
  return session && roles.includes(session.role) ? session : null;
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
