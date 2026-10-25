// Client for Estela's API as an AI agent: x402 pay-per-call for searches and quotes,
// SEP-10 sign-in with the agent's own key, and escrow payments signed locally.
import { Keypair, rpc, TransactionBuilder } from "@stellar/stellar-sdk";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";

const TESTNET = "Test SDF Network ; September 2015";

export class EstelaClient {
  constructor({ baseUrl, secret, rpcUrl = "https://soroban-testnet.stellar.org", passphrase = TESTNET }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.keypair = Keypair.fromSecret(secret);
    this.passphrase = passphrase;
    this.soroban = new rpc.Server(rpcUrl);
    this.cookie = "";
    const network = passphrase === TESTNET ? "stellar:testnet" : "stellar:pubnet";
    this.payingFetch = wrapFetchWithPayment(
      fetch,
      new x402Client().register("stellar:*", new ExactStellarScheme(createEd25519Signer(secret, network))),
    );
  }

  get wallet() {
    return this.keypair.publicKey();
  }

  async call(path, body, { pay = false } = {}) {
    const res = await (pay ? this.payingFetch : fetch)(`${this.baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0];
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error ?? `HTTP ${res.status}`);
      err.status = res.status;
      err.code = data.code;
      throw err;
    }
    return data;
  }

  sign(xdr, passphrase = this.passphrase) {
    const tx = TransactionBuilder.fromXDR(xdr, passphrase);
    tx.sign(this.keypair);
    return tx;
  }

  /** SEP-10 sign-in with the agent's key; reuses the session while it's valid. */
  async signIn() {
    if (this.cookie) {
      const me = await this.call("/api/auth/me");
      if (me?.wallet === this.wallet) return me;
    }
    const challenge = await this.call("/api/auth/challenge", { account: this.wallet });
    return this.call("/api/auth/verify", { transaction: this.sign(challenge.transaction, challenge.networkPassphrase).toXDR() });
  }

  events() {
    return this.call("/api/agent/events");
  }

  searchFlights({ origin, destination, departureDate }) {
    return this.call("/api/agent/flights/search", { origin, destination, departureDate }, { pay: true });
  }

  quote({ offerId, eventId, payWith }) {
    return this.call("/api/agent/quotes", { offerId, eventId, payWith, traveler: this.wallet }, { pay: true });
  }

  /** Books through the escrow: the agent signs and submits the fund transaction itself. */
  async book({ offerId, eventId, payWith, passenger }) {
    await this.signIn();
    const started = await this.call("/api/bookings/package", { offerId, eventId, payWith, passenger });
    let fundHash;
    if (started.fundXdr) {
      const sent = await this.soroban.sendTransaction(this.sign(started.fundXdr));
      if (sent.status === "ERROR") throw new Error("La red rechazó el pago al escrow.");
      const done = await this.soroban.pollTransaction(sent.hash);
      if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`El pago al escrow falló (${done.status}).`);
      fundHash = sent.hash;
    }
    for (let i = 0; ; i++) {
      try {
        const confirmed = await this.call(`/api/bookings/${started.bookingId}/confirm`, { fundHash });
        return { ...confirmed, amount: started.price.amount, fundHash };
      } catch (err) {
        if (err.code !== "payment_pending" || i >= 5) throw err;
        await new Promise((r) => setTimeout(r, 2500));
      }
    }
  }

  async pass() {
    await this.signIn();
    const [membership, tickets] = await Promise.all([this.call("/api/me/membership"), this.call("/api/me/tickets")]);
    return { wallet: this.wallet, ...membership, tickets };
  }
}

/** 7-decimal base units → human amount. */
export const units = (s) => (Number(s) / 1e7).toString();
