/**
 * "Is this method actually on the app I am about to call?"
 *
 * The contracts in `ripar-contracts/contracts/*.py` were AHEAD of the chain for
 * most of this project's life. Bidding, key rotation, milestone release, job
 * expiry and a protocol fee all compiled while no deployed registry routed
 * them, because the deployer had run out of TestNet ALGO. As of 2026-08-05 the
 * live registries route all 36 compiled methods:
 *
 *     IdentityRegistry   768633998
 *     ReputationRegistry 768633999
 *     ValidationRegistry 768634000
 *
 * This module stays, and stays load bearing, for two reasons. A config pointed
 * at an older generation is still a config that exists — nine of them were
 * deployed and all but the last three are still on chain, answering. And the
 * next feature written will be ahead of the chain again.
 *
 * Without it, a tool composing `place_bid` against a registry that predates it
 * produces a perfectly valid transaction the router rejects, and the caller
 * pays a fee to be told `assert failed pc=NNN`. That error names neither the
 * method nor the reason. This module turns it into a sentence.
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
import type { RiparConfig } from "./config.js";

/**
 * Every contract method this package composes a call to, by signature.
 *
 * Transcribed from `ripar-contracts/contracts/artifacts/IdentityRegistry.arc56.json`
 * and `ValidationRegistry.arc56.json`. `deployed` records where each one stood
 * on 2026-08-05 — registries 768633998 / 768633999 / 768634000, where all 36
 * compiled methods are dispatchable — and is DOCUMENTATION ONLY. Every runtime
 * decision below reads the chain, so a stale note here can mislead a reader; it
 * cannot mislead a call. The bidding methods and rotate_address read `false`
 * until this deployment, and the tools that compose them refused at runtime by
 * reading the live approval program rather than trusting this table.
 */
export const CONTRACT_METHODS = {
  post_job: { signature: "post_job(byte[],uint64,uint64)uint64", registry: "validation", deployed: true },
  fund_job: { signature: "fund_job(axfer,uint64)uint64", registry: "validation", deployed: true },
  release_escrow: { signature: "release_escrow(uint64)uint64", registry: "validation", deployed: true },
  refund_escrow: { signature: "refund_escrow(uint64)uint64", registry: "validation", deployed: true },
  release_partial: { signature: "release_partial(uint64,uint64)uint64", registry: "validation", deployed: true },
  expire_job: { signature: "expire_job(uint64)bool", registry: "validation", deployed: true },
  place_bid: {
    signature: "place_bid(uint64,uint64,uint64,byte[])bool",
    registry: "validation",
    deployed: true,
  },
  withdraw_bid: { signature: "withdraw_bid(uint64,uint64)bool", registry: "validation", deployed: true },
  accept_bid: { signature: "accept_bid(uint64,uint64)bool", registry: "validation", deployed: true },
  get_bid: {
    signature: "get_bid(uint64,uint64)(uint64,uint64,uint64,byte[],uint64)",
    registry: "validation",
    deployed: true,
  },
  rotate_address: {
    signature: "rotate_address(uint64,address)bool",
    registry: "identity",
    deployed: true,
  },
  agent_address: { signature: "agent_address(uint64)address", registry: "identity", deployed: true },
} as const satisfies Record<
  string,
  { signature: string; registry: "identity" | "reputation" | "validation"; deployed: boolean }
>;

export type ContractMethodName = keyof typeof CONTRACT_METHODS;

/**
 * Thrown when a method is not in the deployed approval program.
 *
 * A distinct class rather than a bare Error because the MCP layer wants to
 * report this as an ANSWER — "this feature is not on chain yet, here is what
 * exists instead" — and not as a failure of the tool. Confusing the two is how
 * a model ends up retrying a call that can never work.
 */
export class MethodNotDeployedError extends Error {
  readonly code = "method_not_deployed";
  constructor(
    readonly method: string,
    readonly appId: number,
    readonly selectorHex: string,
    extra: string
  ) {
    super(
      `${method} is not deployed on app ${appId}. The selector 0x${selectorHex} does not appear ` +
        `anywhere in that app's approval program, so its router cannot dispatch the call and the ` +
        `contract would reject the transaction after you paid the fee. ${extra}`
    );
    this.name = "MethodNotDeployedError";
  }
}

/** Base64 of an app's approval program, keyed by `${algod}:${appId}`. */
const programCache = new Map<string, Uint8Array>();

/**
 * The compiled approval program currently running on an app.
 *
 * Cached for the life of the process. An approval program only changes on an
 * UpdateApplication, which none of these registries has a handler for — they
 * are create-or-delete only — so within one MCP session the bytes are a
 * constant. Re-fetching for every compose would add a full application record
 * (approval program included) to every write path.
 */
export async function approvalProgram(config: RiparConfig, appId: number): Promise<Uint8Array> {
  const key = `${config.algod}:${appId}`;
  const cached = programCache.get(key);
  if (cached) return cached;

  const res = await config.fetch(`${config.algod}/v2/applications/${appId}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(
      `Could not read app ${appId} from ${config.algod} to check what it exposes: ` +
        `${res.status} ${res.statusText}`
    );
  }
  const body = (await res.json()) as { params?: { "approval-program"?: string } };
  const b64 = body.params?.["approval-program"];
  if (!b64) {
    throw new Error(
      `App ${appId} came back without an approval program, so what it exposes cannot be checked. ` +
        `Refusing to compose a call that might be undeliverable.`
    );
  }
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  programCache.set(key, bytes);
  return bytes;
}

/** The 4 bytes an ARC-4 router dispatches on. */
export function selectorOf(signature: string): Uint8Array {
  return algosdk.ABIMethod.fromSignature(signature).getSelector();
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Whether an app's live approval program routes a signature. One chain read,
 * then pure bytes — no simulation, no fee, no key.
 */
export async function isMethodDeployed(
  config: RiparConfig,
  appId: number,
  signature: string
): Promise<boolean> {
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
export async function assertMethodDeployed(
  config: RiparConfig,
  appId: number,
  signature: string,
  alternative: string
): Promise<void> {
  if (await isMethodDeployed(config, appId, signature)) return;
  throw new MethodNotDeployedError(
    signature,
    appId,
    Buffer.from(selectorOf(signature)).toString("hex"),
    alternative
  );
}

/**
 * Which of the methods above the live apps actually route, as data.
 *
 * Exposed so a caller can ask once, up front, rather than discovering it one
 * refusal at a time — and so the gap between the source tree and the chain is
 * something you can print instead of something you have to remember.
 */
export async function deploymentReport(config: RiparConfig): Promise<{
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
}> {
  const entries = Object.entries(CONTRACT_METHODS);
  const methods = await Promise.all(
    entries.map(async ([name, spec]) => {
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
    })
  );
  return {
    network: config.network,
    apps: { ...config.appIds },
    methods,
  };
}

/** Test seam. The cache is keyed by endpoint, so tests must be able to drop it. */
export function clearDeployedCache(): void {
  programCache.clear();
}
