import "server-only";
import { contract, Keypair } from "@stellar/stellar-sdk";
import { Client as EscrowClient, type Booking } from "estela-escrow";
import { Client as PassClient, type Level } from "estela-pass";
import { Client as StampsClient } from "estela-stamps";
import { env } from "../env";

// Server-side access to the three Estela contracts. Admin and backend calls are
// signed here with keys that never leave the server; the traveler's `fund` is only
// built here and signed in the browser through Pollar.

export type Currency = "USDC" | "EURC" | "XLM";
export type StampKind = "Event" | "Trip";

export class ChainError extends Error {}

function base() {
  const e = env();
  return { networkPassphrase: e.STELLAR_NETWORK_PASSPHRASE, rpcUrl: e.STELLAR_RPC_URL };
}

function signer(secret: string) {
  const keypair = Keypair.fromSecret(secret);
  return {
    publicKey: keypair.publicKey(),
    ...contract.basicNodeSigner(keypair, env().STELLAR_NETWORK_PASSPHRASE),
  };
}

const escrowAs = (opts: Partial<contract.ClientOptions> = {}) =>
  new EscrowClient({ ...base(), contractId: env().ESCROW_CONTRACT_ID, ...opts });

export function tokenContract(currency: Currency): string {
  const e = env();
  return { USDC: e.USDC_CONTRACT_ID, EURC: e.EURC_CONTRACT_ID, XLM: e.XLM_CONTRACT_ID }[currency];
}

/** Signs and submits an assembled call; returns its hash or throws a ChainError. */
async function submit<T>(tx: contract.AssembledTransaction<T>, what: string): Promise<string> {
  try {
    const sent = await tx.signAndSend();
    const hash = sent.sendTransactionResponse?.hash;
    if (!hash) throw new Error("no transaction hash");
    return hash;
  } catch (err) {
    throw new ChainError(`${what} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Contract calls return Result<T>; turn a contract error into a ChainError. */
function unwrap<T>(result: { isErr(): boolean; unwrap(): T; unwrapErr?: () => { message: string } }, what: string): T {
  if (result.isErr()) {
    throw new ChainError(`${what}: ${result.unwrapErr?.().message ?? "contract error"}`);
  }
  return result.unwrap();
}

export type NewBooking = {
  id: bigint;
  traveler: string;
  currency: Currency;
  /** Base units (7 decimals). */
  amount: bigint;
  payee?: string;
  payeeAmount?: bigint;
  payBefore: Date;
  refundUntil: Date;
  confirmBy: Date;
};

const unix = (d: Date) => BigInt(Math.floor(d.getTime() / 1000));

export async function createBooking(b: NewBooking): Promise<string> {
  const tx = await escrowAs(signer(env().ESCROW_ADMIN_SECRET)).create_booking({
    id: b.id,
    traveler: b.traveler,
    token: tokenContract(b.currency),
    amount: b.amount,
    payee: b.payee,
    payee_amount: b.payeeAmount ?? BigInt(0),
    pay_before: unix(b.payBefore),
    refund_until: unix(b.refundUntil),
    confirm_by: unix(b.confirmBy),
  });
  unwrap(tx.result, "create_booking simulation");
  return submit(tx, "create_booking");
}

/**
 * Builds the traveler's `fund` call, simulated and ready to sign: the browser signs
 * and submits it with Pollar (`signAndSubmitTx(xdr)`), since only the traveler can.
 */
export async function buildFundTx(id: bigint, traveler: string): Promise<string> {
  const tx = await escrowAs({ publicKey: traveler }).fund({ id });
  unwrap(tx.result, "fund simulation");
  return tx.toXDR();
}

export async function release(id: bigint): Promise<string> {
  const tx = await escrowAs(signer(env().ESCROW_ADMIN_SECRET)).release({ id });
  unwrap(tx.result, "release simulation");
  return submit(tx, "release");
}

export async function refund(id: bigint, toTraveler: bigint, toPayee: bigint): Promise<string> {
  const tx = await escrowAs(signer(env().ESCROW_ADMIN_SECRET)).refund({
    id,
    to_traveler: toTraveler,
    to_payee: toPayee,
  });
  unwrap(tx.result, "refund simulation");
  return submit(tx, "refund");
}

/** The on-chain booking, or null if it doesn't exist. */
export async function getBooking(id: bigint): Promise<Booking | null> {
  const tx = await escrowAs().get_booking({ id });
  return tx.result.isErr() ? null : tx.result.unwrap();
}

export async function mintStamp(user: string, kind: StampKind, refId: bigint): Promise<string> {
  const backend = signer(env().BACKEND_SECRET);
  const tx = await new StampsClient({ ...base(), contractId: env().STAMPS_CONTRACT_ID, ...backend }).mint_stamp({
    user,
    kind: { tag: kind, values: undefined },
    ref_id: refId,
    caller: backend.publicKey,
  });
  return submit(tx, "mint_stamp");
}

/** The token id of `user`'s stamp for this event/booking, if minted. */
export async function stampOf(user: string, kind: StampKind, refId: bigint): Promise<number | null> {
  const stamps = new StampsClient({ ...base(), contractId: env().STAMPS_CONTRACT_ID });
  const tx = await stamps.stamp_of({ user, kind: { tag: kind, values: undefined }, ref_id: refId });
  return tx.result ?? null;
}

/** Who holds Estela Pass `tokenId`; null if it was never minted. */
export async function passOwner(tokenId: number): Promise<string | null> {
  const pass = new PassClient({ ...base(), contractId: env().PASS_CONTRACT_ID });
  return ownerOrNull((await pass.owner_of({ token_id: tokenId })).result);
}

/**
 * owner_of fails for unknown tokens; the bindings hand that back as an Err value in
 * place of the address rather than throwing.
 */
function ownerOrNull(result: unknown): string | null {
  return typeof result === "string" ? result : null;
}

/** Holder and contents of stamp `tokenId`; null if it doesn't exist (or was revoked). */
export async function stampInfo(tokenId: number): Promise<{ owner: string; kind: StampKind; refId: bigint } | null> {
  const stamps = new StampsClient({ ...base(), contractId: env().STAMPS_CONTRACT_ID });
  const info = (await stamps.stamp_info({ token_id: tokenId })).result;
  if (!info) return null;
  const owner = ownerOrNull((await stamps.owner_of({ token_id: tokenId })).result);
  return owner ? { owner, kind: info.kind.tag, refId: info.ref_id } : null;
}

export type Membership = { xp: number; level: Level["tag"]; discountBps: number; passId: number | null };

/** The member's Estela Pass, read without a transaction. */
export async function membership(user: string): Promise<Membership> {
  const pass = new PassClient({ ...base(), contractId: env().PASS_CONTRACT_ID });
  const [xp, level, discount, passId] = await Promise.all([
    pass.xp_of({ user }),
    pass.level_of({ user }),
    pass.discount_bps_of({ user }),
    pass.pass_of({ user }),
  ]);
  return {
    xp: xp.result,
    level: level.result.tag,
    discountBps: discount.result,
    passId: passId.result ?? null,
  };
}
