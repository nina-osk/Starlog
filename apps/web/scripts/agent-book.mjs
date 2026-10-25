// Demo AI agent that books a trip to an event end to end:
//   1. finds the event (free) and searches + quotes flights paying per call with x402 (USDC),
//   2. signs in to Estela with SEP-10 using its own key,
//   3. books flight + event ticket and pays the escrow itself (not x402: the escrow
//      keeps the refund guarantees), then confirms and gets the airline reference.
//   AGENT_SECRET=S... node scripts/agent-book.mjs [origin IATA] [base URL]
import { Keypair, rpc, TransactionBuilder } from "@stellar/stellar-sdk";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";

const secret = process.env.AGENT_SECRET;
if (!secret) throw new Error("set AGENT_SECRET to the agent's S... key");
const origin = (process.argv[2] ?? "LIS").toUpperCase();
const base = process.argv[3] ?? "http://localhost:3000";
const keypair = Keypair.fromSecret(secret);
const agent = keypair.publicKey();
const PASSPHRASE = "Test SDF Network ; September 2015";
const soroban = new rpc.Server("https://soroban-testnet.stellar.org");

const payingFetch = wrapFetchWithPayment(
  fetch,
  new x402Client().register("stellar:*", new ExactStellarScheme(createEd25519Signer(secret, "stellar:testnet"))),
);

let cookie = "";
async function api(path, body, { pay = false } = {}) {
  const res = await (pay ? payingFetch : fetch)(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${data.error ?? ""}`);
  return data;
}

/** Signs a transaction the server built for us (SEP-10 challenge or escrow fund). */
function sign(xdr, passphrase = PASSPHRASE) {
  const tx = TransactionBuilder.fromXDR(xdr, passphrase);
  tx.sign(keypair);
  return tx;
}

async function balances() {
  const acc = await (await fetch(`https://horizon-testnet.stellar.org/accounts/${agent}`)).json();
  const get = (code) => Number(acc.balances.find((b) => (code === "XLM" ? b.asset_type === "native" : b.asset_code === code))?.balance ?? 0);
  return { usdc: get("USDC"), xlm: get("XLM") };
}

console.log(`Agent ${agent.slice(0, 8)}…`);
const before = await balances();

// 1. Discover, search and quote (x402 pay-per-call).
const { events } = await api("/api/agent/events");
const event = events.find((e) => e.airport && e.ticketPrice);
const day = new Date(new Date(event.startsAt).getTime() - 86_400_000).toISOString().slice(0, 10);
console.log(`1) Event: "${event.title}" (${event.airport}), ticket ${Number(event.ticketPrice) / 1e7} ${event.currency}`);
const { offers } = await api("/api/agent/flights/search", { origin, destination: event.airport, departureDate: day }, { pay: true });
const offer = offers[0];
const quote = await api("/api/agent/quotes", { offerId: offer.id, payWith: event.currency, eventId: event.id, traveler: agent }, { pay: true });
console.log(`   Paid search + quote (x402): ${offer.airline} ${offer.totalAmount} ${offer.totalCurrency} → package ${quote.total} ${quote.currency}`);

// 2. Sign in with the agent's own key (SEP-10).
const challenge = await api("/api/auth/challenge", { account: agent });
const session = await api("/api/auth/verify", { transaction: sign(challenge.transaction, challenge.networkPassphrase).toXDR() });
console.log(`2) Signed in to Estela as ${session.wallet.slice(0, 8)}… (role ${session.role})`);

// 3. Book through the escrow, pay it ourselves, confirm.
let booking;
try {
  booking = await api("/api/bookings/package", {
    offerId: offer.id,
    payWith: event.currency,
    eventId: event.id,
    passenger: {
      title: "ms", gender: "f", givenName: "Agente", familyName: "Demo",
      bornOn: "1992-03-08", email: "agente.demo@example.com", phoneNumber: "+34600000009",
    },
  });
} catch (err) {
  if (!String(err.message).includes("ticket")) throw err;
  // Already holds a ticket for this event (demo re-run): book the flight alone.
  booking = await api("/api/bookings/package", {
    offerId: offer.id, payWith: event.currency,
    passenger: { title: "ms", gender: "f", givenName: "Agente", familyName: "Demo", bornOn: "1992-03-08", email: "agente.demo@example.com", phoneNumber: "+34600000009" },
  });
}
console.log(`3) Booking #${booking.bookingId}: ${Number(booking.price.amount) / 1e7} ${event.currency} into the escrow`);
const sent = await soroban.sendTransaction(sign(booking.fundXdr));
const funded = await soroban.pollTransaction(sent.hash);
console.log(`   Escrow funded by the agent: ${funded.status} (tx ${sent.hash.slice(0, 12)}…)`);

let confirmed;
for (let i = 0; i < 6; i++) {
  try {
    confirmed = await api(`/api/bookings/${booking.bookingId}/confirm`, { fundHash: sent.hash });
    break;
  } catch (err) {
    if (!String(err.message).includes("Todavía no recibimos")) throw err;
    await new Promise((r) => setTimeout(r, 2500));
  }
}
console.log(`   Confirmed: airline reference ${confirmed.bookingReference}${confirmed.ticketId ? ", event ticket issued" : ""}`);

const pass = await api("/api/me/membership");
const after = await balances();
console.log(`\nEstela Pass of the agent: ${pass.level}, ${pass.xp} XP`);
console.log(`USDC ${before.usdc} → ${after.usdc} (x402 calls) · XLM ${before.xlm.toFixed(2)} → ${after.xlm.toFixed(2)} (escrow + tx fee)`);
