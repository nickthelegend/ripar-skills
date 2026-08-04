/**
 * The write side — and the reason this package can be pointed at a wallet
 * without anyone auditing it for key handling.
 *
 * **This module has no signing code and never will.** There is no mnemonic
 * parameter, no `algosdk.signTransaction` import, no env var read for a secret.
 * A write returns the composed, unsigned transaction as base64 msgpack plus a
 * plain-language description of what signing it would do. Whoever holds the key
 * — a human in Pera, a wallet extension, a signing service — makes that
 * decision.
 *
 * That is a deliberate constraint, not an unfinished feature. An MCP server is
 * driven by a model, and a model that can both choose to spend and sign for the
 * spend has no meaningful approval step. Splitting compose from sign puts a
 * human between the two, and the base64 blob is exactly what a wallet expects,
 * so the split costs the caller one paste.
 */
import algosdk from "algosdk";
import type { RiparConfig } from "./config.js";
export type UnsignedTransaction = {
    /** Always false. Present so a caller cannot mistake this for a submitted tx. */
    signed: false;
    /** base64 msgpack, ready to hand to a wallet. */
    unsignedTxnBase64: string;
    /** The id this transaction will have once signed, unchanged by signing. */
    txId: string;
    network: string;
    appId: number;
    method: string;
    sender: string;
    /** Human-readable, so a signer can check the numbers without decoding msgpack. */
    summary: string;
    args: Record<string, unknown>;
    boxes: string[];
    fee: number;
    validRounds: {
        first: number;
        last: number;
    };
    /** What the caller has to do next, since this package deliberately cannot. */
    nextSteps: string[];
};
export declare function suggestedParams(config: RiparConfig): Promise<algosdk.SuggestedParams>;
/**
 * Generic ARC-4 app call composer. Args are already-encoded ABI values; the
 * method signature is used only for its selector, so it must match the ARC-56
 * spec exactly or the contract will reject the call at the router.
 */
export declare function composeAppCall(config: RiparConfig, opts: {
    sender: string;
    appId: number;
    signature: string;
    encodedArgs: Uint8Array[];
    boxNames?: Uint8Array[];
    summary: string;
    args: Record<string, unknown>;
    nextSteps?: string[];
}): Promise<UnsignedTransaction>;
export declare function composePostJob(config: RiparConfig, input: {
    sender: string;
    specHash: string;
    budgetMicro: number;
    validatorAgentId?: number;
}): Promise<UnsignedTransaction>;
