import { NextResponse } from "next/server";
import { z } from "zod";
import { sep10Config } from "@/server/auth/current-user";
import { AuthError, createChallenge } from "@/server/auth/sep10";

const body = z.object({ account: z.string() });

/** Step 1 of login: returns a SEP-10 challenge for the wallet to sign with Pollar. */
export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Falta la dirección de la wallet." }, { status: 400 });
  }
  const cfg = sep10Config();
  try {
    const transaction = createChallenge(cfg, parsed.data.account);
    // The domains let the wallet run its own SEP-10 checks before signing.
    return NextResponse.json({
      transaction,
      networkPassphrase: cfg.networkPassphrase,
      homeDomain: cfg.homeDomain,
      webAuthDomain: cfg.webAuthDomain,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
