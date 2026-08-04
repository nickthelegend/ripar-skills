/**
 * Box decoding.
 *
 * A box VALUE in these registries is an ARC-4 encoded struct — the same bytes
 * the ABI method would return. So the only safe way to read one is to hand the
 * bytes to `ABIType.from(...)` with the layout from the ARC-56 JSON. Slicing at
 * hand-counted offsets works right up until a `string` or `byte[]` field moves,
 * because dynamic fields live in a tail addressed by a 2-byte head offset — the
 * struct is NOT a flat concatenation of its fields.
 *
 * Concretely, `AgentInfo` is 5 fields but its head is 58 bytes: 8 (uint64) + 2
 * (offset standing in for the domain) + 32 (address) + 8 + 8, with the domain's
 * length prefix and text appended after. Guessing that is how you end up
 * reading an agent's domain out of the middle of its address.
 *
 * Every type string below is transcribed from the `structs` block of the
 * matching `*.arc56.json`, field order included.
 */
import { type JobStatus } from "./config.js";
/** IdentityRegistry `AgentInfo` — agents box map, prefix `ag_`. */
export declare const AGENT_INFO_TYPE = "(uint64,string,address,uint64,uint64)";
/** ReputationRegistry `Score` — scores box map, prefix `sc_`. */
export declare const SCORE_TYPE = "(uint64,uint64,uint64,uint64,uint64,uint64,uint64)";
/** ValidationRegistry `Job` — jobs box map, prefix `jb_`. */
export declare const JOB_TYPE = "(uint64,address,uint64,uint64,uint64,byte[],byte[],uint64,uint64,uint64)";
/**
 * ValidationRegistry `Bid` — bids box map, prefix `bd_`.
 *
 * `pitch_hash` is a `byte[]`, so this struct is dynamic and its head is 8+8+8+2+8
 * with the pitch's length prefix and bytes in the tail — the same trap
 * `AgentInfo` sets with its domain. Read it with ABIType, never by offset.
 */
export declare const BID_TYPE = "(uint64,uint64,uint64,byte[],uint64)";
export type Agent = {
    agentId: number;
    /** The agent's domain, which is also where its A2A card is expected to live. */
    domain: string;
    /** The Algorand account that controls the record and receives x402 payments. */
    address: string;
    registeredAt: number;
    updatedAt: number;
};
export type Score = {
    agentId: number;
    /** Distinct settled payments. Not a star rating — nothing here is typed by a human. */
    jobsPaid: number;
    /** Total USDC settled, in base units (6 decimals). */
    volumeMicro: number;
    validated: number;
    disputed: number;
    firstAt: number;
    lastAt: number;
};
export type Job = {
    jobId: number;
    client: string;
    serverAgentId: number;
    validatorAgentId: number;
    budgetMicro: number;
    /** Hex, no `0x`. Empty string when unset. The spec itself stays offchain. */
    specHash: string;
    resultHash: string;
    status: JobStatus | "unknown";
    statusCode: number;
    createdAt: number;
    updatedAt: number;
};
export type Bid = {
    jobId: number;
    bidderAgentId: number;
    /** What this agent will do the job for, in USDC base units. */
    priceMicro: number;
    /** Hex, no `0x`. The pitch TEXT is never on chain — only this commitment to it. */
    pitchHash: string;
    placedAt: number;
};
/** Timestamps are unix seconds; 0 means "never happened", not "the epoch". */
declare function isoOrNull(unixSeconds: number): string | null;
export declare function toHex(bytes: Uint8Array): string;
export declare function fromHex(hex: string): Uint8Array;
export declare function decodeAgentBox(value: Uint8Array): Agent;
export declare function decodeScoreBox(value: Uint8Array): Score;
export declare function decodeJobBox(value: Uint8Array): Job;
export declare function decodeBidBox(value: Uint8Array): Bid;
/**
 * `dm_` and `ad_` boxes hold a bare uint64 — the agent id — so a lookup is one
 * box read rather than a scan. 0 is the contract's "not found" sentinel and the
 * comment on `resolve_by_domain` is explicit that callers must check it.
 */
export declare function decodeUint64Box(value: Uint8Array): number;
export declare function uint64Bytes(value: number | bigint): Uint8Array;
export declare function agentBoxName(agentId: number | bigint): Uint8Array;
export declare function domainBoxName(domain: string): Uint8Array;
export declare function addressBoxName(address: string): Uint8Array;
export declare function scoreBoxName(agentId: number | bigint): Uint8Array;
export declare function jobBoxName(jobId: number | bigint): Uint8Array;
/**
 * `es_` + the job id. The VALUE is a bare uint64 of base units, not an ARC-4
 * struct — `BoxMap(UInt64, UInt64)` stores `itob(amount)` and nothing else — so
 * `decodeUint64Box` reads it, exactly as it reads the `dm_`/`ad_` pointers.
 */
export declare function escrowBoxName(jobId: number | bigint): Uint8Array;
/**
 * `bd_` + itob(job_id) + itob(bidder_agent_id) — 19 bytes.
 *
 * The contract's box map is `BoxMap(Bytes, Bid, key_prefix=b"bd_")` and its
 * `_bid_key` subroutine builds the key as `op.itob(job) + op.itob(bidder)`.
 * Because the KEY TYPE is `Bytes`, algopy stores it raw: there is NO ARC-4
 * length prefix in front of those 16 bytes, which is exactly the difference
 * that makes `dm_` work on raw UTF-8 rather than on an encoded `string`.
 *
 * Keying on both ids is what makes a bid addressable without iteration AND
 * makes a second bid from the same agent replace the first rather than stack
 * up beside it.
 */
export declare function bidBoxName(jobId: number | bigint, bidderAgentId: number | bigint): Uint8Array;
/**
 * The prefix that selects every bid on ONE job: `bd_` + itob(job_id).
 *
 * The job id is the FIRST half of the key precisely so this works — algod
 * filters box listings by a byte prefix, so "all bids on job 7" is one
 * server-side filtered listing instead of a scan of every bid ever placed.
 */
export declare function bidPrefixForJob(jobId: number | bigint): Uint8Array;
/**
 * Both ids back out of a `bd_` box name.
 *
 * Throws on anything else. A bid attributed to the wrong job or the wrong
 * bidder is worse than no bid at all: it is a price somebody never offered,
 * shown next to work they never saw.
 */
export declare function bidKeyFromBoxName(name: Uint8Array): {
    jobId: number;
    bidderAgentId: number;
};
/**
 * The id back out of a `<prefix>` + uint64 box name, for turning a box LISTING
 * into a map without a read per candidate id. Throws on a name that does not
 * carry the prefix, because silently returning a number for someone else's box
 * would attach an escrow to the wrong job.
 */
export declare function idFromBoxName(name: Uint8Array, prefix: string): number;
/**
 * Algorand prints a txid as unpadded RFC-4648 base32 of the 32 raw bytes. The
 * `pd_` box is keyed by those raw bytes, so the printed form has to be decoded
 * before it can be looked up.
 */
export declare function base32TxIdToBytes(txId: string): Uint8Array;
export declare function withTimestamps<T extends {
    registeredAt?: number;
    updatedAt?: number;
}>(v: T): T & {
    registeredAtIso?: string | null;
    updatedAtIso?: string | null;
};
export { isoOrNull };
