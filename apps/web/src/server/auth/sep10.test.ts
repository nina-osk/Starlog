import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthError, CHALLENGE_TIMEOUT_SECONDS, createChallenge, verifyChallenge, type Sep10Config } from "./sep10";

const cfg: Sep10Config = {
  signingSecret: Keypair.random().secret(),
  homeDomain: "estela.test",
  webAuthDomain: "localhost:3000",
  networkPassphrase: Networks.TESTNET,
};

/** What Pollar's signTx() does with the challenge: add the wallet's signature. */
function signAs(xdr: string, signer: Keypair, passphrase = cfg.networkPassphrase): string {
  const tx = TransactionBuilder.fromXDR(xdr, passphrase);
  tx.sign(signer);
  return tx.toXDR();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SEP-10 login", () => {
  it("accepts a challenge signed by the account it was issued for", () => {
    const user = Keypair.random();
    const signed = signAs(createChallenge(cfg, user.publicKey()), user);

    const { account, txHash } = verifyChallenge(cfg, signed);
    expect(account).toBe(user.publicKey());
    expect(txHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects addresses that aren't Stellar accounts", () => {
    expect(() => createChallenge(cfg, "not-an-address")).toThrow(AuthError);
  });

  it("rejects an unsigned challenge", () => {
    const user = Keypair.random();
    expect(() => verifyChallenge(cfg, createChallenge(cfg, user.publicKey()))).toThrow(AuthError);
  });

  it("rejects a challenge signed by someone else", () => {
    const user = Keypair.random();
    const attacker = Keypair.random();
    const signed = signAs(createChallenge(cfg, user.publicKey()), attacker);
    expect(() => verifyChallenge(cfg, signed)).toThrow(AuthError);
  });

  it("rejects a challenge issued by another server", () => {
    const user = Keypair.random();
    const other: Sep10Config = { ...cfg, signingSecret: Keypair.random().secret() };
    const signed = signAs(createChallenge(other, user.publicKey()), user);
    expect(() => verifyChallenge(cfg, signed)).toThrow(AuthError);
  });

  it("rejects a challenge for another domain", () => {
    const user = Keypair.random();
    const phishing: Sep10Config = { ...cfg, webAuthDomain: "estela-login.evil" };
    const signed = signAs(createChallenge(phishing, user.publicKey()), user);
    expect(() => verifyChallenge(cfg, signed)).toThrow(AuthError);
  });

  it("rejects an expired challenge", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T12:00:00Z"));
    const user = Keypair.random();
    const signed = signAs(createChallenge(cfg, user.publicKey()), user);

    vi.setSystemTime(new Date(Date.now() + (CHALLENGE_TIMEOUT_SECONDS + 60) * 1000));
    expect(() => verifyChallenge(cfg, signed)).toThrow(AuthError);
  });
});
