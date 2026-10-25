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
  STELLAR_RPC_URL: z.string().url().default("https://soroban-testnet.stellar.org"),
  HORIZON_URL: z.string().url().default("https://horizon-testnet.stellar.org"),
  ESCROW_CONTRACT_ID: z.string().startsWith("C"),
  PASS_CONTRACT_ID: z.string().startsWith("C"),
  STAMPS_CONTRACT_ID: z.string().startsWith("C"),
  USDC_CONTRACT_ID: z.string().startsWith("C"),
  EURC_CONTRACT_ID: z.string().startsWith("C"),
  XLM_CONTRACT_ID: z.string().startsWith("C"),
  // Classic issuers behind the USDC/EURC contracts (Circle's testnet issuers by default).
  USDC_ISSUER: z.string().startsWith("G").default("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"),
  EURC_ISSUER: z.string().startsWith("G").default("GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO"),
  // estela-admin: the escrow admin (create_booking, release, refund).
  ESCROW_ADMIN_SECRET: z.string().startsWith("S"),
  // estela-backend: `issuer` on EstelaStamps and `awarder` on EstelaPass.
  BACKEND_SECRET: z.string().startsWith("S"),
  // Duffel API token (duffel_test_... on testnet). Flights are paid from Estela's balance.
  DUFFEL_TOKEN: z.string().startsWith("duffel_"),
  // Estela's service fee per flight passenger, in the offer's currency.
  FLIGHT_SERVICE_FEE: z.string().regex(/^\d+(\.\d+)?$/).default("10"),
  // Testnet only: XLM charged per EUR/USD when a package is paid in XLM (no oracle yet).
  DEMO_XLM_PER_FIAT: z.string().regex(/^\d+(\.\d+)?$/).default("1"),
  // x402 pay-per-request for AI agents. x402.org's facilitator serves stellar:testnet
  // with sponsored fees and no API key; mainnet: OpenZeppelin Channels.
  X402_FACILITATOR_URL: z.string().url().default("https://x402.org/facilitator"),
  X402_NETWORK: z.enum(["stellar:testnet", "stellar:pubnet"]).default("stellar:testnet"),
  // Receives the per-call USDC (needs a USDC trustline): Estela's treasury.
  X402_PAY_TO: z.string().startsWith("G"),
  // Bearer token for /api/cron/* (Vercel Cron sends it). 32+ random characters.
  CRON_SECRET: z.string().min(32),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  cached ??= schema.parse(process.env);
  return cached;
}
