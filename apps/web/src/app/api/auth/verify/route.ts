import { NextResponse } from "next/server";
import { z } from "zod";
import { sep10Config } from "@/server/auth/current-user";
import { AuthError, verifyChallenge } from "@/server/auth/sep10";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession } from "@/server/auth/session";
import { db, schema } from "@/server/db";
import { env } from "@/server/env";

const body = z.object({ transaction: z.string() });

/** Step 2 of login: checks the signed challenge and opens a session cookie. */
export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Falta la transacción firmada." }, { status: 400 });
  }

  let account: string;
  let txHash: string;
  try {
    ({ account, txHash } = verifyChallenge(sep10Config(), parsed.data.transaction));
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }

  const database = db();
  // Each signed challenge buys exactly one session.
  const fresh = await database
    .insert(schema.authChallenges)
    .values({ txHash, account })
    .onConflictDoNothing()
    .returning({ txHash: schema.authChallenges.txHash });
  if (fresh.length === 0) {
    return NextResponse.json({ error: "Este acceso ya se usó. Vuelve a iniciar sesión." }, { status: 401 });
  }

  const [user] = await database
    .insert(schema.users)
    .values({ wallet: account })
    .onConflictDoUpdate({ target: schema.users.wallet, set: { wallet: account } })
    .returning();

  const token = await signSession(env().SESSION_SECRET, {
    userId: user.id,
    wallet: user.wallet,
    role: user.role,
  });
  const res = NextResponse.json({ id: user.id, wallet: user.wallet, role: user.role });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
}
