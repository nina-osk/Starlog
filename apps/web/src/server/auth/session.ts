import { jwtVerify, SignJWT } from "jose";

export const SESSION_COOKIE = "estela_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export type Role = "traveler" | "organizer" | "staff" | "admin";

export type Session = {
  userId: string;
  wallet: string;
  role: Role;
};

const key = (secret: string) => new TextEncoder().encode(secret);

export async function signSession(secret: string, session: Session): Promise<string> {
  return new SignJWT({ wallet: session.wallet, role: session.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(session.userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(key(secret));
}

/** Returns the session, or null if the token is missing, tampered with or expired. */
export async function readSession(secret: string, token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ["HS256"] });
    if (!payload.sub || typeof payload.wallet !== "string" || typeof payload.role !== "string") {
      return null;
    }
    return { userId: payload.sub, wallet: payload.wallet, role: payload.role as Role };
  } catch {
    return null;
  }
}
