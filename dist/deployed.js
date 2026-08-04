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
import algosdk from "algosdk";
/**
 * Every contract method this package composes a call to, by signature.
 *
 * Transcribed from `ripar-contracts/contracts/artifacts/IdentityRegistry.arc56.json`
 * and `ValidationRegistry.arc56.json`. `deployed` records where each one stood
 * on 2026-08-04 and is DOCUMENTATION ONLY — every runtime decision below reads
 * the chain. A stale note here can mislead a reader; it cannot mislead a call.
 */
export const CONTRACT_METHODS = {
    post_job: { signature: "post_job(byte[],uint64,uint64)uint64", registry: "validation", deployed: true },
    fund_job: { signature: "fund_job(axfer,uint64)uint64", registry: "validation", deployed: true },
    release_escrow: { signature: "release_escrow(uint64)uint64", registry: "validation", deployed: true },
    refund_escrow: { signature: "refund_escrow(uint64)uint64", registry: "validation", deployed: true },
    place_bid: {
        signature: "place_bid(uint64,uint64,uint64,byte[])bool",
        registry: "validation",
        deployed: false,
    },
    withdraw_bid: { signature: "withdraw_bid(uint64,uint64)bool", registry: "validation", deployed: false },
    accept_bid: { signature: "accept_bid(uint64,uint64)bool", registry: "validation", deployed: false },
    rotate_address: {
        signature: "rotate_address(uint64,address)bool",
        registry: "identity",
        deployed: false,
    },
    agent_address: { signature: "agent_address(uint64)address", registry: "identity", deployed: true },
};
/**
 * Thrown when a method is not in the deployed approval program.
 *
 * A distinct class rather than a bare Error because the MCP layer wants to
 * report this as an ANSWER — "this feature is not on chain yet, here is what
 * exists instead" — and not as a failure of the tool. Confusing the two is how
 * a model ends up retrying a call that can never work.
 */
export class MethodNotDeployedError extends Error {
    method;
    appId;
    selectorHex;
    code = "method_not_deployed";
    constructor(method, appId, selectorHex, extra) {
        super(`${method} is not deployed on app ${appId}. The selector 0x${selectorHex} does not appear ` +
            `anywhere in that app's approval program, so its router cannot dispatch the call and the ` +
            `contract would reject the transaction after you paid the fee. ${extra}`);
        this.method = method;
        this.appId = appId;
        this.selectorHex = selectorHex;
        this.name = "MethodNotDeployedError";
    }
}
/** Base64 of an app's approval program, keyed by `${algod}:${appId}`. */
const programCache = new Map();
/**
 * The compiled approval program currently running on an app.
 *
 * Cached for the life of the process. An approval program only changes on an
 * UpdateApplication, which none of these registries has a handler for — they
 * are create-or-delete only — so within one MCP session the bytes are a
 * constant. Re-fetching for every compose would add a full application record
 * (approval program included) to every write path.
 */
export async function approvalProgram(config, appId) {
    const key = `${config.algod}:${appId}`;
    const cached = programCache.get(key);
    if (cached)
        return cached;
    const res = await config.fetch(`${config.algod}/v2/applications/${appId}`, {
        headers: { accept: "application/json" },
    });
    if (!res.ok) {
        throw new Error(`Could not read app ${appId} from ${config.algod} to check what it exposes: ` +
            `${res.status} ${res.statusText}`);
    }
    const body = (await res.json());
    const b64 = body.params?.["approval-program"];
    if (!b64) {
        throw new Error(`App ${appId} came back without an approval program, so what it exposes cannot be checked. ` +
            `Refusing to compose a call that might be undeliverable.`);
    }
    const bytes = new Uint8Array(Buffer.from(b64, "base64"));
    programCache.set(key, bytes);
    return bytes;
}
/** The 4 bytes an ARC-4 router dispatches on. */
export function selectorOf(signature) {
    return algosdk.ABIMethod.fromSignature(signature).getSelector();
}
function indexOfBytes(haystack, needle) {
    outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (haystack[i + j] !== needle[j])
                continue outer;
        }
        return i;
    }
    return -1;
}
/**
 * Whether an app's live approval program routes a signature. One chain read,
 * then pure bytes — no simulation, no fee, no key.
 */
export async function isMethodDeployed(config, appId, signature) {
    const program = await approvalProgram(config, appId);
    return indexOfBytes(program, selectorOf(signature)) !== -1;
}
/**
 * Refuse loudly, before composing, when the method is not on chain.
 *
 * `alternative` is the sentence that makes this useful rather than merely
 * correct: somebody asking to place a bid wants to know what they CAN do
 * today, and "assign_job still works, the client just names the agent" is the
 * answer. Written by the caller because only the caller knows the substitute.
 */
export async function assertMethodDeployed(config, appId, signature, alternative) {
    if (await isMethodDeployed(config, appId, signature))
        return;
    throw new MethodNotDeployedError(signature, appId, Buffer.from(selectorOf(signature)).toString("hex"), alternative);
}
/**
 * Which of the methods above the live apps actually route, as data.
 *
 * Exposed so a caller can ask once, up front, rather than discovering it one
 * refusal at a time — and so the gap between the source tree and the chain is
 * something you can print instead of something you have to remember.
 */
export async function deploymentReport(config) {
    const entries = Object.entries(CONTRACT_METHODS);
    const methods = await Promise.all(entries.map(async ([name, spec]) => {
        const appId = config.appIds[spec.registry];
        const selector = Buffer.from(selectorOf(spec.signature)).toString("hex");
        return {
            name,
            signature: spec.signature,
            registry: spec.registry,
            appId,
            selector,
            onChain: appId ? await isMethodDeployed(config, appId, spec.signature) : false,
            expectedOnChain: spec.deployed,
        };
    }));
    return {
        network: config.network,
        apps: { ...config.appIds },
        methods,
    };
}
/** Test seam. The cache is keyed by endpoint, so tests must be able to drop it. */
export function clearDeployedCache() {
    programCache.clear();
}
