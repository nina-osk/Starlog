import { Keypair, StrKey, WebAuth } from "@stellar/stellar-sdk";

// SEP-10 (Stellar Web Authentication): the server hands out a challenge transaction
// that can never be submitted (sequence 0), the wallet signs it, and a valid client
// signature proves the user controls that account. Pollar signs it with signTx().

export type Sep10Config = {
  signingSecret: string;
  homeDomain: string;
  webAuthDomain: string;
  networkPassphrase: string;
};

export const CHALLENGE_TIMEOUT_SECONDS = 300;
// The SDK accepts challenges up to 5 minutes past their expiry; we only allow for
// clock skew.
const CLOCK_SKEW_SECONDS = 30;

export class AuthError extends Error {}

export function createChallenge(cfg: Sep10Config, account: string): string {
  if (!StrKey.isValidEd25519PublicKey(account)) {
    throw new AuthError("account must be a G... Stellar address");
  }
  return WebAuth.buildChallengeTx(
    Keypair.fromSecret(cfg.signingSecret),
    account,
    cfg.homeDomain,
    CHALLENGE_TIMEOUT_SECONDS,
    cfg.networkPassphrase,
    cfg.webAuthDomain,
  );
}

/**
 * Checks that `signedXdr` is a challenge this server issued, still within its time
 * window, and signed by the account it was issued for. Returns that account and the
 * transaction hash (stored to reject replays).
 */
export function verifyChallenge(cfg: Sep10Config, signedXdr: string): { account: string; txHash: string } {
  const serverAccount = Keypair.fromSecret(cfg.signingSecret).publicKey();
  try {
    const { tx, clientAccountID } = WebAuth.readChallengeTx(
      signedXdr,
      serverAccount,
      cfg.networkPassphrase,
      cfg.homeDomain,
      cfg.webAuthDomain,
    );
    const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
    if (Date.now() / 1000 > maxTime + CLOCK_SKEW_SECONDS) {
      throw new AuthError("challenge expired");
    }
    // Pollar's custodial wallets are plain accounts signed by their master key, so
    // the client's own key is the only signer we accept.
    WebAuth.verifyChallengeTxSigners(
      signedXdr,
      serverAccount,
      cfg.networkPassphrase,
      [clientAccountID],
      cfg.homeDomain,
      cfg.webAuthDomain,
    );
    return { account: clientAccountID, txHash: tx.hash().toString("hex") };
  } catch (err) {
    throw new AuthError(err instanceof Error ? err.message : "invalid challenge");
  }
}
