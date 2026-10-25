// Demo AI agent that pays Estela's API per call with x402 (USDC on Stellar testnet).
//   AGENT_SECRET=S... node scripts/agent-demo.mjs [origin IATA] [base URL]
// The agent account needs a USDC trustline and some test USDC (faucet.circle.com).
// It never pays network fees: the x402 facilitator sponsors them.
import { createEd25519Signer, USDC_TESTNET_ADDRESS } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { Keypair } from "@stellar/stellar-sdk";

const secret = process.env.AGENT_SECRET;
if (!secret) throw new Error("set AGENT_SECRET to the agent's S... key");
const origin = (process.argv[2] ?? "LIS").toUpperCase();
const base = process.argv[3] ?? "http://localhost:3000";
const agent = Keypair.fromSecret(secret).publicKey();

const signer = createEd25519Signer(secret, "stellar:testnet");
const client = new x402Client().register("stellar:*", new ExactStellarScheme(signer));
const payingFetch = wrapFetchWithPayment(fetch, client);

async function usdc() {
  const res = await fetch(`https://horizon-testnet.stellar.org/accounts/${agent}`);
  const line = (await res.json()).balances.find((b) => b.asset_code === "USDC");
  return Number(line?.balance ?? 0);
}

/** POST through the x402-aware fetch; reports what (if anything) was paid. */
async function paidPost(path, body) {
  const res = await payingFetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const receipt = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
  const settlement = receipt ? decodePaymentResponseHeader(receipt) : null;
  return { status: res.status, data: await res.json(), settlement };
}

console.log(`Agent ${agent.slice(0, 8)}… · USDC contract ${USDC_TESTNET_ADDRESS.slice(0, 8)}…`);
const start = await usdc();
console.log(`USDC balance: ${start}\n`);

// 1. Discovery is free.
const { events } = await (await fetch(`${base}/api/agent/events`)).json();
const event = events.find((e) => e.airport);
if (!event) throw new Error("no event with an airport to fly to");
const day = new Date(new Date(event.startsAt).getTime() - 86_400_000).toISOString().slice(0, 10);
console.log(`1) Free: found "${event.title}" in ${event.city} (${event.airport}) on ${event.startsAt.slice(0, 10)}`);

// 2. Flight search: 0.01 USDC.
const search = await paidPost("/api/agent/flights/search", { origin, destination: event.airport, departureDate: day });
if (search.status !== 200) throw new Error(`search failed: ${search.status} ${JSON.stringify(search.data)}`);
const offer = search.data.offers[0];
console.log(`2) Paid search: ${search.data.offers.length} offers ${origin}→${event.airport}; cheapest ${offer.totalAmount} ${offer.totalCurrency} (${offer.airline})`);
console.log(`   settlement tx: ${search.settlement?.transaction ?? "?"}`);

// 3. Exact quote: 0.005 USDC.
const quote = await paidPost("/api/agent/quotes", { offerId: offer.id, payWith: "EURC" });
if (quote.status !== 200) throw new Error(`quote failed: ${quote.status} ${JSON.stringify(quote.data)}`);
console.log(`3) Paid quote: total ${quote.data.total} ${quote.data.currency} = flight ${quote.data.breakdown.flight} + fee ${quote.data.breakdown.serviceFee}`);
console.log(`   settlement tx: ${quote.settlement?.transaction ?? "?"}`);

// 4. A bad request is not charged.
const bad = await paidPost("/api/agent/flights/search", { origin: "ZZZ", destination: event.airport, departureDate: day });
console.log(`4) Bad search: HTTP ${bad.status}, settlement: ${bad.settlement ? "CHARGED" : "none (not charged)"}`);

const end = await usdc();
console.log(`\nUSDC balance: ${start} → ${end} (spent ${(start - end).toFixed(7)})`);
