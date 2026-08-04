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
import algosdk from "algosdk";
import { BOX_PREFIX, jobStatusName } from "./config.js";
const { ABIType, encodeAddress, decodeAddress } = algosdk;
/** IdentityRegistry `AgentInfo` — agents box map, prefix `ag_`. */
export const AGENT_INFO_TYPE = "(uint64,string,address,uint64,uint64)";
/** ReputationRegistry `Score` — scores box map, prefix `sc_`. */
export const SCORE_TYPE = "(uint64,uint64,uint64,uint64,uint64,uint64,uint64)";
/** ValidationRegistry `Job` — jobs box map, prefix `jb_`. */
export const JOB_TYPE = "(uint64,address,uint64,uint64,uint64,byte[],byte[],uint64,uint64,uint64)";
/** Timestamps are unix seconds; 0 means "never happened", not "the epoch". */
function isoOrNull(unixSeconds) {
    return unixSeconds > 0 ? new Date(unixSeconds * 1000).toISOString() : null;
}
export function toHex(bytes) {
    return Buffer.from(bytes).toString("hex");
}
export function fromHex(hex) {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
        throw new Error(`Not hex: ${hex}`);
    }
    return new Uint8Array(Buffer.from(clean, "hex"));
}
function n(v) {
    return typeof v === "bigint" ? Number(v) : Number(v);
}
/**
 * `address` decodes to an `Address` object on algosdk v3 and to a plain base32
 * string on v2. Normalising here keeps the decoders honest across both.
 */
function addr(v) {
    if (typeof v === "string")
        return v;
    if (v instanceof Uint8Array)
        return encodeAddress(v);
    return String(v);
}
function bytesOf(v) {
    if (v instanceof Uint8Array)
        return v;
    if (Array.isArray(v))
        return new Uint8Array(v);
    return new Uint8Array();
}
export function decodeAgentBox(value) {
    const t = ABIType.from(AGENT_INFO_TYPE).decode(value);
    return {
        agentId: n(t[0]),
        domain: String(t[1]),
        address: addr(t[2]),
        registeredAt: n(t[3]),
        updatedAt: n(t[4]),
    };
}
export function decodeScoreBox(value) {
    const t = ABIType.from(SCORE_TYPE).decode(value);
    return {
        agentId: n(t[0]),
        jobsPaid: n(t[1]),
        volumeMicro: n(t[2]),
        validated: n(t[3]),
        disputed: n(t[4]),
        firstAt: n(t[5]),
        lastAt: n(t[6]),
    };
}
export function decodeJobBox(value) {
    const t = ABIType.from(JOB_TYPE).decode(value);
    const statusCode = n(t[7]);
    return {
        jobId: n(t[0]),
        client: addr(t[1]),
        serverAgentId: n(t[2]),
        validatorAgentId: n(t[3]),
        budgetMicro: n(t[4]),
        specHash: toHex(bytesOf(t[5])),
        resultHash: toHex(bytesOf(t[6])),
        status: jobStatusName(statusCode),
        statusCode,
        createdAt: n(t[8]),
        updatedAt: n(t[9]),
    };
}
/**
 * `dm_` and `ad_` boxes hold a bare uint64 — the agent id — so a lookup is one
 * box read rather than a scan. 0 is the contract's "not found" sentinel and the
 * comment on `resolve_by_domain` is explicit that callers must check it.
 */
export function decodeUint64Box(value) {
    return Number(ABIType.from("uint64").decode(value));
}
// ---------------------------------------------------------------------------
// Box NAMES. Note these are raw AVM bytes, not ARC-4 encodings:
//   `ag_1` is "ag_" + 8 big-endian bytes  (uint64 happens to encode the same way)
//   `dm_x` is "dm_" + the domain's UTF-8 bytes, with NO 2-byte length prefix —
//          an ARC-4 `string` would add one, and the box would not be found.
//   `ad_x` is "ad_" + the 32-byte public key, not the 58-char base32 address.
// ---------------------------------------------------------------------------
function withPrefix(prefix, tail) {
    const head = new TextEncoder().encode(prefix);
    const out = new Uint8Array(head.length + tail.length);
    out.set(head, 0);
    out.set(tail, head.length);
    return out;
}
export function uint64Bytes(value) {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, BigInt(value), false);
    return out;
}
export function agentBoxName(agentId) {
    return withPrefix(BOX_PREFIX.agent, uint64Bytes(agentId));
}
export function domainBoxName(domain) {
    return withPrefix(BOX_PREFIX.domain, new TextEncoder().encode(domain));
}
export function addressBoxName(address) {
    return withPrefix(BOX_PREFIX.address, decodeAddress(address).publicKey);
}
export function scoreBoxName(agentId) {
    return withPrefix(BOX_PREFIX.score, uint64Bytes(agentId));
}
/**
 * `txId` may be the base32 id Algorand prints, or 32 raw bytes as hex.
 *
 * The two forms are distinguished by length, not by character class: an
 * unpadded base32 txid is 52 characters and hex is 64, but a base32 id made
 * only of `A-F` and `2-7` is also valid hex, so sniffing the alphabet would
 * occasionally decode the wrong one. Anything of another length falls through
 * to the 32-byte check, which is the error a caller can actually act on.
 */
export function paidBoxName(txId) {
    let raw;
    if (typeof txId !== "string") {
        raw = txId;
    }
    else if (txId.length === 52) {
        raw = base32TxIdToBytes(txId);
    }
    else if (txId.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(txId)) {
        raw = fromHex(txId);
    }
    else {
        raw = base32TxIdToBytes(txId);
    }
    if (raw.length !== 32) {
        throw new Error(`A payment txid must be 32 bytes, got ${raw.length}`);
    }
    return withPrefix(BOX_PREFIX.paid, raw);
}
export function jobBoxName(jobId) {
    return withPrefix(BOX_PREFIX.job, uint64Bytes(jobId));
}
/**
 * Algorand prints a txid as unpadded RFC-4648 base32 of the 32 raw bytes. The
 * `pd_` box is keyed by those raw bytes, so the printed form has to be decoded
 * before it can be looked up.
 */
export function base32TxIdToBytes(txId) {
    const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const clean = txId.replace(/=+$/, "").toUpperCase();
    let bits = 0;
    let value = 0;
    const out = [];
    for (const ch of clean) {
        const idx = ALPHABET.indexOf(ch);
        if (idx === -1)
            throw new Error(`Not a base32 transaction id: ${txId}`);
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return new Uint8Array(out);
}
export function withTimestamps(v) {
    return {
        ...v,
        ...(v.registeredAt !== undefined ? { registeredAtIso: isoOrNull(v.registeredAt) } : {}),
        ...(v.updatedAt !== undefined ? { updatedAtIso: isoOrNull(v.updatedAt) } : {}),
    };
}
export { isoOrNull };
