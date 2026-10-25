import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}


export const networks = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CDUARFKLW2YDKWIUZAAFY2BQCWOJU46H6NVY4ZKHRPLTSDTHYPZAHCTD",
  }
} as const

export const Errors = {
  1: {message:"AlreadyExists"},
  2: {message:"NotFound"},
  3: {message:"InvalidState"},
  4: {message:"PaymentWindowClosed"},
  5: {message:"RefundWindowClosed"},
  6: {message:"TooEarly"},
  7: {message:"TokenNotAllowed"},
  8: {message:"InvalidAmount"},
  9: {message:"InvalidDeadlines"},
  10: {message:"InvalidPayee"}
}

export type Status = {tag: "Pending", values: void} | {tag: "Funded", values: void} | {tag: "Released", values: void} | {tag: "Refunded", values: void};


export interface Booking {
  amount: i128;
  confirm_by: u64;
  pay_before: u64;
  /**
 * Partner organizer paid directly on release; `None` for Estela-only bookings.
 */
payee: Option<string>;
  /**
 * The payee's share of `amount`; the rest goes to the treasury.
 */
payee_amount: i128;
  refund_until: u64;
  status: Status;
  token: string;
  traveler: string;
}


export interface Client {
  /**
   * Construct and simulate a fund transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Traveler pays the booking: the exact amount moves from their wallet into the contract.
   */
  fund: ({id}: {id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Traveler cancels before `refund_until` and gets 100 % back.
   */
  cancel: ({id}: {id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a refund transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin applies the cancellation policy: `to_traveler` goes back to the traveler,
   * `to_payee` (at most its `payee_amount`) to the organizer, and the rest to the
   * treasury.
   */
  refund: ({id, to_traveler, to_payee}: {id: u64, to_traveler: i128, to_payee: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a reclaim transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Traveler takes 100 % back if Estela didn't confirm before `confirm_by`.
   */
  reclaim: ({id}: {id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a release transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin confirms the booking with the providers: the payee gets its share, the
   * treasury the rest, and the traveler earns XP.
   */
  release: ({id}: {id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_booking transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_booking: ({id}: {id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Booking>>>

  /**
   * Construct and simulate a create_booking transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin registers a booking with the exact price and deadlines (all unix seconds).
   * The traveler can only pay this exact amount, so they can't choose their own price.
   * A partner organizer (`payee`) gets `payee_amount` of it on release.
   */
  create_booking: ({id, traveler, token, amount, payee, payee_amount, pay_before, refund_until, confirm_by}: {id: u64, traveler: string, token: string, amount: i128, payee: Option<string>, payee_amount: i128, pay_before: u64, refund_until: u64, confirm_by: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a is_token_allowed transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  is_token_allowed: ({token}: {token: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a treasury_address transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  treasury_address: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin, treasury, loyalty, tokens}: {admin: string, treasury: string, loyalty: string, tokens: Array<string>},
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy({admin, treasury, loyalty, tokens}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAACgAAAAAAAAANQWxyZWFkeUV4aXN0cwAAAAAAAAEAAAAAAAAACE5vdEZvdW5kAAAAAgAAAAAAAAAMSW52YWxpZFN0YXRlAAAAAwAAAAAAAAATUGF5bWVudFdpbmRvd0Nsb3NlZAAAAAAEAAAAAAAAABJSZWZ1bmRXaW5kb3dDbG9zZWQAAAAAAAUAAAAAAAAACFRvb0Vhcmx5AAAABgAAAAAAAAAPVG9rZW5Ob3RBbGxvd2VkAAAAAAcAAAAAAAAADUludmFsaWRBbW91bnQAAAAAAAAIAAAAAAAAABBJbnZhbGlkRGVhZGxpbmVzAAAACQAAAAAAAAAMSW52YWxpZFBheWVlAAAACg==",
        "AAAAAgAAAAAAAAAAAAAABlN0YXR1cwAAAAAABAAAAAAAAAAAAAAAB1BlbmRpbmcAAAAAAAAAAAAAAAAGRnVuZGVkAAAAAAAAAAAAAAAAAAhSZWxlYXNlZAAAAAAAAAAAAAAACFJlZnVuZGVk",
        "AAAAAQAAAAAAAAAAAAAAB0Jvb2tpbmcAAAAACQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAApjb25maXJtX2J5AAAAAAAGAAAAAAAAAApwYXlfYmVmb3JlAAAAAAAGAAAATFBhcnRuZXIgb3JnYW5pemVyIHBhaWQgZGlyZWN0bHkgb24gcmVsZWFzZTsgYE5vbmVgIGZvciBFc3RlbGEtb25seSBib29raW5ncy4AAAAFcGF5ZWUAAAAAAAPoAAAAEwAAAD1UaGUgcGF5ZWUncyBzaGFyZSBvZiBgYW1vdW50YDsgdGhlIHJlc3QgZ29lcyB0byB0aGUgdHJlYXN1cnkuAAAAAAAADHBheWVlX2Ftb3VudAAAAAsAAAAAAAAADHJlZnVuZF91bnRpbAAAAAYAAAAAAAAABnN0YXR1cwAAAAAH0AAAAAZTdGF0dXMAAAAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAAAAAAh0cmF2ZWxlcgAAABM=",
        "AAAABQAAAFRFbWl0dGVkIG9uIGV2ZXJ5IHN0YXRlIGNoYW5nZSwgc28gdGhlIGJhY2tlbmQgY2FuIGZvbGxvdyBib29raW5ncyBmcm9tIGNoYWluIGV2ZW50cy4AAAAAAAAADkJvb2tpbmdDaGFuZ2VkAAAAAAABAAAAD2Jvb2tpbmdfY2hhbmdlZAAAAAADAAAAAAAAAAJpZAAAAAAABgAAAAEAAAAAAAAABnN0YXR1cwAAAAAH0AAAAAZTdGF0dXMAAAAAAAAAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAC",
        "AAAAAAAAAFZUcmF2ZWxlciBwYXlzIHRoZSBib29raW5nOiB0aGUgZXhhY3QgYW1vdW50IG1vdmVzIGZyb20gdGhlaXIgd2FsbGV0IGludG8gdGhlIGNvbnRyYWN0LgAAAAAABGZ1bmQAAAABAAAAAAAAAAJpZAAAAAAABgAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAADtUcmF2ZWxlciBjYW5jZWxzIGJlZm9yZSBgcmVmdW5kX3VudGlsYCBhbmQgZ2V0cyAxMDAgJSBiYWNrLgAAAAAGY2FuY2VsAAAAAAABAAAAAAAAAAJpZAAAAAAABgAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAKdBZG1pbiBhcHBsaWVzIHRoZSBjYW5jZWxsYXRpb24gcG9saWN5OiBgdG9fdHJhdmVsZXJgIGdvZXMgYmFjayB0byB0aGUgdHJhdmVsZXIsCmB0b19wYXllZWAgKGF0IG1vc3QgaXRzIGBwYXllZV9hbW91bnRgKSB0byB0aGUgb3JnYW5pemVyLCBhbmQgdGhlIHJlc3QgdG8gdGhlCnRyZWFzdXJ5LgAAAAAGcmVmdW5kAAAAAAADAAAAAAAAAAJpZAAAAAAABgAAAAAAAAALdG9fdHJhdmVsZXIAAAAACwAAAAAAAAAIdG9fcGF5ZWUAAAALAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAEdUcmF2ZWxlciB0YWtlcyAxMDAgJSBiYWNrIGlmIEVzdGVsYSBkaWRuJ3QgY29uZmlybSBiZWZvcmUgYGNvbmZpcm1fYnlgLgAAAAAHcmVjbGFpbQAAAAABAAAAAAAAAAJpZAAAAAAABgAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAHpBZG1pbiBjb25maXJtcyB0aGUgYm9va2luZyB3aXRoIHRoZSBwcm92aWRlcnM6IHRoZSBwYXllZSBnZXRzIGl0cyBzaGFyZSwgdGhlCnRyZWFzdXJ5IHRoZSByZXN0LCBhbmQgdGhlIHRyYXZlbGVyIGVhcm5zIFhQLgAAAAAAB3JlbGVhc2UAAAAAAQAAAAAAAAACaWQAAAAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAALZ2V0X2Jvb2tpbmcAAAAAAQAAAAAAAAACaWQAAAAAAAYAAAABAAAD6QAAB9AAAAAHQm9va2luZwAAAAAD",
        "AAAAAAAAAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAQAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAIdHJlYXN1cnkAAAATAAAAAAAAAAdsb3lhbHR5AAAAABMAAAAAAAAABnRva2VucwAAAAAD6gAAABMAAAAA",
        "AAAAAAAAAOdBZG1pbiByZWdpc3RlcnMgYSBib29raW5nIHdpdGggdGhlIGV4YWN0IHByaWNlIGFuZCBkZWFkbGluZXMgKGFsbCB1bml4IHNlY29uZHMpLgpUaGUgdHJhdmVsZXIgY2FuIG9ubHkgcGF5IHRoaXMgZXhhY3QgYW1vdW50LCBzbyB0aGV5IGNhbid0IGNob29zZSB0aGVpciBvd24gcHJpY2UuCkEgcGFydG5lciBvcmdhbml6ZXIgKGBwYXllZWApIGdldHMgYHBheWVlX2Ftb3VudGAgb2YgaXQgb24gcmVsZWFzZS4AAAAADmNyZWF0ZV9ib29raW5nAAAAAAAJAAAAAAAAAAJpZAAAAAAABgAAAAAAAAAIdHJhdmVsZXIAAAATAAAAAAAAAAV0b2tlbgAAAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAFcGF5ZWUAAAAAAAPoAAAAEwAAAAAAAAAMcGF5ZWVfYW1vdW50AAAACwAAAAAAAAAKcGF5X2JlZm9yZQAAAAAABgAAAAAAAAAMcmVmdW5kX3VudGlsAAAABgAAAAAAAAAKY29uZmlybV9ieQAAAAAABgAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAQaXNfdG9rZW5fYWxsb3dlZAAAAAEAAAAAAAAABXRva2VuAAAAAAAAEwAAAAEAAAAB",
        "AAAAAAAAAAAAAAAQdHJlYXN1cnlfYWRkcmVzcwAAAAAAAAABAAAAEw==" ]),
      options
    )
  }
  public readonly fromJSON = {
    fund: this.txFromJSON<Result<void>>,
        cancel: this.txFromJSON<Result<void>>,
        refund: this.txFromJSON<Result<void>>,
        reclaim: this.txFromJSON<Result<void>>,
        release: this.txFromJSON<Result<void>>,
        get_booking: this.txFromJSON<Result<Booking>>,
        create_booking: this.txFromJSON<Result<void>>,
        is_token_allowed: this.txFromJSON<boolean>,
        treasury_address: this.txFromJSON<string>
  }
}