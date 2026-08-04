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
/**
 * A box the call must declare, and which app owns it.
 *
 * `appId` matters because box references are shared across the whole group by
 * app id: when the ValidationRegistry resolves an agent by inner call into the
 * IdentityRegistry, the IDENTITY app's `ag_` box has to be listed here, on the
 * outer transaction, or the inner call fails on an unavailable box with an
 * error that names neither the box nor the app.
 */
export type BoxRef = {
    name: Uint8Array;
    appId?: number;
};
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
export type AppCallOptions = {
    sender: string;
    appId: number;
    signature: string;
    encodedArgs: Uint8Array[];
    boxes?: BoxRef[];
    /** Apps the call reaches by inner call. Unlisted, the inner call is refused. */
    foreignApps?: number[];
    /** Assets an inner transaction moves. Unlisted, the transfer is refused. */
    foreignAssets?: number[];
    /** Accounts an inner transaction pays. Unlisted, the payment is refused. */
    accounts?: string[];
    /**
     * How many inner transactions the contract will submit for this call.
     *
     * algopy gives every inner transaction a fee of 0 by design, so the OUTER
     * call has to fund the whole pool: one minimum fee for itself plus one for
     * each inner transaction. Left at 0, the network's own suggested fee is used,
     * which is right for a call that submits none — and short by exactly the
     * missing inners for a call that does, failing with "fee too small" rather
     * than anything that points at the cause.
     */
    innerTransactions?: number;
    summary: string;
    args: Record<string, unknown>;
    nextSteps?: string[];
};
/**
 * Generic ARC-4 app call composer. Args are already-encoded ABI values; the
 * method signature is used only for its selector, so it must match the ARC-56
 * spec exactly or the contract will reject the call at the router.
 */
export declare function composeAppCall(config: RiparConfig, opts: AppCallOptions): Promise<UnsignedTransaction>;
export declare function composePostJob(config: RiparConfig, input: {
    sender: string;
    specHash: string;
    budgetMicro: number;
    validatorAgentId?: number;
}): Promise<UnsignedTransaction>;
/**
 * A group of unsigned transactions that only mean anything together.
 *
 * A group id is computed over ALL the members, so every one of them commits to
 * the others. Signing a subset, reordering them, or submitting them separately
 * does not do part of the job — it fails, which is the property being relied on
 * here: the ValidationRegistry reads the escrow amount off the transfer sitting
 * next to it in the group rather than off a number the caller supplied.
 */
export type UnsignedTransactionGroup = {
    /** Always false. Present so a caller cannot mistake this for a submitted group. */
    signed: false;
    /** base64 of the 32-byte group id every member carries. */
    groupId: string;
    network: string;
    appId: number;
    method: string;
    sender: string;
    summary: string;
    args: Record<string, unknown>;
    transactions: UnsignedGroupMember[];
    /** What the whole group costs in fees, in microALGO. */
    totalFee: number;
    validRounds: {
        first: number;
        last: number;
    };
    nextSteps: string[];
};
export type UnsignedGroupMember = {
    /** Position in the group. The order is part of what the group id commits to. */
    index: number;
    kind: "axfer" | "appl";
    unsignedTxnBase64: string;
    txId: string;
    fee: number;
    boxes?: string[];
    summary: string;
};
/**
 * Compose the two-transaction group that moves a job's budget into escrow.
 *
 * The shape is the whole point. `fund_job` takes the transfer as a TRANSACTION
 * IN ITS OWN GROUP, not as an amount argument, so the number it records is one
 * the AVM has already validated — the same rule that stopped reputation being
 * minted from bytes. That is why this returns two transactions and not one, and
 * why they have to be signed and submitted together.
 */
export declare function composeFundJob(config: RiparConfig, input: {
    sender: string;
    jobId: number;
    amountMicro: number;
}): Promise<UnsignedTransactionGroup>;
/**
 * Compose `release_escrow` — pay the assignee.
 *
 * Legal only on a passing verdict. The client may call it immediately; anyone
 * at all may call it once the dispute window has passed since that verdict,
 * because a validator who never returns would otherwise freeze the worker's
 * money for good, and a lock with no key is not escrow, it is confiscation.
 */
export declare function composeReleaseEscrow(config: RiparConfig, input: {
    sender: string;
    jobId: number;
}): Promise<UnsignedTransaction>;
/**
 * Compose `refund_escrow` — return the escrow to the client.
 *
 * Legal on a failed verdict or a cancelled job, and the destination is read off
 * the job rather than from the sender: whoever triggers a refund, the money
 * goes to the client, so triggering one can never redirect one.
 */
export declare function composeRefundEscrow(config: RiparConfig, input: {
    sender: string;
    jobId: number;
}): Promise<UnsignedTransaction>;
