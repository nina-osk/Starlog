// Runs against the real testnet contracts: `npm run test:testnet`.
// TEST_TRAVELER_SECRET plays the wallet's part (what Pollar does in the browser).
import { Keypair, rpc, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { buildFundTx, createBooking, getBooking, membership, release } from ".";

const traveler = Keypair.fromSecret(process.env.TEST_TRAVELER_SECRET ?? "");
const server = new rpc.Server(process.env.STELLAR_RPC_URL!);

/** What Pollar's signAndSubmitTx does with the XDR we hand to the browser. */
async function signAndSubmitAsTraveler(xdr: string) {
  const tx = TransactionBuilder.fromXDR(xdr, process.env.STELLAR_NETWORK_PASSPHRASE!);
  tx.sign(traveler);
  const sent = await server.sendTransaction(tx);
  expect(sent.status).not.toBe("ERROR");
  const done = await server.pollTransaction(sent.hash);
  expect(done.status).toBe(rpc.Api.GetTransactionStatus.SUCCESS);
}

describe("chain service on testnet", () => {
  it("creates, funds through the traveler's signature, releases and awards XP", { timeout: 180_000 }, async () => {
    // Far above the ids the database hands out, so test bookings never collide.
    const id = BigInt(Date.now());
    const now = Date.now();
    const before = await membership(traveler.publicKey());

    await createBooking({
      id,
      traveler: traveler.publicKey(),
      currency: "XLM",
      amount: BigInt(20_000_000), // 2 XLM -> 2 XP
      payBefore: new Date(now + 3_600_000),
      refundUntil: new Date(now + 3_600_000),
      confirmBy: new Date(now + 7_200_000),
    });
    expect((await getBooking(id))?.status.tag).toBe("Pending");

    await signAndSubmitAsTraveler(await buildFundTx(id, traveler.publicKey()));
    expect((await getBooking(id))?.status.tag).toBe("Funded");

    const hash = await release(id);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await getBooking(id))?.status.tag).toBe("Released");

    const after = await membership(traveler.publicKey());
    expect(after.xp).toBe(before.xp + 2);
  });

  it("returns null for a booking that doesn't exist", async () => {
    expect(await getBooking(BigInt(1) << BigInt(62))).toBeNull();
  });
});
