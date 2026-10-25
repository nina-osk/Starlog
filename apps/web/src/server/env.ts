import "server-only";
import { z } from "zod";

// Server-side configuration. Never import this from client components: it holds
// secrets, and "server-only" makes the build fail if that happens.
const schema = z.object({
  // Supabase Postgres connection string (transaction pooler, port 6543).
  DATABASE_URL: z.string().url(),
  // Signs the session cookie (HS256). At least 32 random characters.
  SESSION_SECRET: z.string().min(32),
  // Secret key (S...) that signs SEP-10 challenges. It needs no funds and must
  // not be the escrow admin key.
  SEP10_SIGNING_SECRET: z.string().startsWith("S"),
  // Host the challenge is issued for, e.g. "localhost:3000" or "estela.app".
  WEB_AUTH_DOMAIN: z.string().min(1),
  HOME_DOMAIN: z.string().min(1),
  STELLAR_NETWORK_PASSPHRASE: z.string().default("Test SDF Network ; September 2015"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  cached ??= schema.parse(process.env);
  return cached;
}
