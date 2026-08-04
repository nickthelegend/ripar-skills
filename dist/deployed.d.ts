/**
 * "Is this method actually on the app I am about to call?"
 *
 * The contracts in `ripar-contracts/contracts/*.py` are AHEAD of the chain.
 * Bidding, key rotation, milestone release, job expiry and a protocol fee were
 * all written, they compile, and they are NOT deployed — the deployer ran out
 * of TestNet ALGO. The live registries are the previous generation:
 *
 *     IdentityRegistry   768572968
 *     ReputationRegistry 768572969
 *     ValidationRegistry 768572979
 *
 * So a tool composing `place_bid` against 768572979 produces a perfectly valid
 * transaction that the router will reject, and the caller pays a fee to be told
 * `assert failed pc=NNN`. That error names neither the method nor the reason.
 * This module turns it into a sentence.
 *
 * ## How the check works, and what it can and cannot prove
 *
 * An ARC-4 router compares `Txn.application_args[0]` against the 4-byte method
 * selector — sha512/256 of the exact signature string, truncated. puya emits
 * each selector as a literal in the compiled approval program, so:
 *
 *   - If a method IS routed, its selector bytes MUST appear in the program.
 *     There is no way to route on a constant you never emitted.
 *   - Therefore a selector that is ABSENT proves the method is not callable.
 *
 * The converse is weaker: four arbitrary bytes could in principle collide with
 * some other run of bytecode, so PRESENT is strong evidence rather than proof.
 * That asymmetry is the right way round for a guard whose only job is to
 * REFUSE. A false "present" costs a rejected transaction — exactly what would
 * have happened without this check. A false "absent" would block a legal call,
 * and cannot happen.
 *
 * Nothing here is a mock, a version number, or a hard-coded "not yet" flag. It
 * reads the program that is running on chain right now, so the day the new
 * generation is deployed these tools start working with no code change — and
 * if someone points this package at a DIFFERENT registry that does have
 * bidding, it works there too.
 *
 * Signatures are transcribed from the `methods` block of the matching
 * `*.arc56.json` in ripar-contracts. They have to match character for character:
 * the selector is a hash of the signature STRING, so `uint64` vs `uint 64` is
 * two different methods as far as the router is concerned. ripar-contracts CI
 * asserts every name below still exists in the artifact.
 */
import type { RiparConfig } from "./config.js";
/**
 * Every contract method this package composes a call to, by signature.
 *
 * Transcribed from `ripar-contracts/contracts/artifacts/IdentityRegistry.arc56.json`
 * and `ValidationRegistry.arc56.json`. `deployed` records where each one stood
 * on 2026-08-04 and is DOCUMENTATION ONLY — every runtime decision below reads
 * the chain. A stale note here can mislead a reader; it cannot mislead a call.
 */
export declare const CONTRACT_METHODS: {
    readonly post_job: {
        readonly signature: "post_job(byte[],uint64,uint64)uint64";
        readonly registry: "validation";
        readonly deployed: true;
    };
    readonly fund_job: {
        readonly signature: "fund_job(axfer,uint64)uint64";
        readonly registry: "validation";
        readonly deployed: true;
    };
    readonly release_escrow: {
        readonly signature: "release_escrow(uint64)uint64";
        readonly registry: "validation";
        readonly deployed: true;
    };
    readonly refund_escrow: {
        readonly signature: "refund_escrow(uint64)uint64";
        readonly registry: "validation";
        readonly deployed: true;
    };
    readonly place_bid: {
        readonly signature: "place_bid(uint64,uint64,uint64,byte[])bool";
        readonly registry: "validation";
        readonly deployed: false;
    };
    readonly withdraw_bid: {
        readonly signature: "withdraw_bid(uint64,uint64)bool";
        readonly registry: "validation";
        readonly deployed: false;
    };
    readonly accept_bid: {
        readonly signature: "accept_bid(uint64,uint64)bool";
        readonly registry: "validation";
        readonly deployed: false;
    };
    readonly rotate_address: {
        readonly signature: "rotate_address(uint64,address)bool";
        readonly registry: "identity";
        readonly deployed: false;
    };
    readonly agent_address: {
        readonly signature: "agent_address(uint64)address";
        readonly registry: "identity";
        readonly deployed: true;
    };
};
export type ContractMethodName = keyof typeof CONTRACT_METHODS;
/**
 * Thrown when a method is not in the deployed approval program.
 *
 * A distinct class rather than a bare Error because the MCP layer wants to
 * report this as an ANSWER — "this feature is not on chain yet, here is what
 * exists instead" — and not as a failure of the tool. Confusing the two is how
 * a model ends up retrying a call that can never work.
 */
export declare class MethodNotDeployedError extends Error {
    readonly method: string;
    readonly appId: number;
    readonly selectorHex: string;
    readonly code = "method_not_deployed";
    constructor(method: string, appId: number, selectorHex: string, extra: string);
}
/**
 * The compiled approval program currently running on an app.
 *
 * Cached for the life of the process. An approval program only changes on an
 * UpdateApplication, which none of these registries has a handler for — they
 * are create-or-delete only — so within one MCP session the bytes are a
 * constant. Re-fetching for every compose would add a full application record
 * (approval program included) to every write path.
 */
export declare function approvalProgram(config: RiparConfig, appId: number): Promise<Uint8Array>;
/** The 4 bytes an ARC-4 router dispatches on. */
export declare function selectorOf(signature: string): Uint8Array;
/**
 * Whether an app's live approval program routes a signature. One chain read,
 * then pure bytes — no simulation, no fee, no key.
 */
export declare function isMethodDeployed(config: RiparConfig, appId: number, signature: string): Promise<boolean>;
/**
 * Refuse loudly, before composing, when the method is not on chain.
 *
 * `alternative` is the sentence that makes this useful rather than merely
 * correct: somebody asking to place a bid wants to know what they CAN do
 * today, and "assign_job still works, the client just names the agent" is the
 * answer. Written by the caller because only the caller knows the substitute.
 */
export declare function assertMethodDeployed(config: RiparConfig, appId: number, signature: string, alternative: string): Promise<void>;
/**
 * Which of the methods above the live apps actually route, as data.
 *
 * Exposed so a caller can ask once, up front, rather than discovering it one
 * refusal at a time — and so the gap between the source tree and the chain is
 * something you can print instead of something you have to remember.
 */
export declare function deploymentReport(config: RiparConfig): Promise<{
    network: string;
    apps: Record<string, number>;
    methods: {
        name: string;
        signature: string;
        registry: string;
        appId: number;
        selector: string;
        onChain: boolean;
        /** True when the source tree and the chain disagree about this method. */
        expectedOnChain: boolean;
    }[];
}>;
/** Test seam. The cache is keyed by endpoint, so tests must be able to drop it. */
export declare function clearDeployedCache(): void;
