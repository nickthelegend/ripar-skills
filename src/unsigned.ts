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
import { fromHex, jobBoxName, uint64Bytes } from "./abi.js";
import { microToUsdc } from "./registry.js";
import type { RiparConfig } from "./config.js";

const { ABIMethod, ABIType, makeApplicationNoOpTxnFromObject, encodeUnsignedTransaction } = algosdk;

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
  validRounds: { first: number; last: number };
  /** What the caller has to do next, since this package deliberately cannot. */
  nextSteps: string[];
};

type AlgodParams = {
  fee: number;
  "min-fee": number;
  "last-round": number;
  "genesis-id": string;
  "genesis-hash": string;
};

export async function suggestedParams(config: RiparConfig): Promise<algosdk.SuggestedParams> {
  const res = await config.fetch(`${config.algod}/v2/transactions/params`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Could not fetch suggested params: ${res.status} ${res.statusText}`);
  }
  const p = (await res.json()) as AlgodParams;
  return {
    fee: p.fee,
    minFee: p["min-fee"],
    firstValid: p["last-round"],
    lastValid: p["last-round"] + 1000,
    genesisID: p["genesis-id"],
    genesisHash: new Uint8Array(Buffer.from(p["genesis-hash"], "base64")),
    flatFee: false,
  };
}

/**
 * Generic ARC-4 app call composer. Args are already-encoded ABI values; the
 * method signature is used only for its selector, so it must match the ARC-56
 * spec exactly or the contract will reject the call at the router.
 */
export async function composeAppCall(
  config: RiparConfig,
  opts: {
    sender: string;
    appId: number;
    signature: string;
    encodedArgs: Uint8Array[];
    boxNames?: Uint8Array[];
    summary: string;
    args: Record<string, unknown>;
    nextSteps?: string[];
  }
): Promise<UnsignedTransaction> {
  const params = await suggestedParams(config);
  // The selector is the first 4 bytes of sha512/256 over the exact signature
  // string, so it has to be derived from the signature rather than assembled by
  // hand — one character off and the contract's router rejects the call.
  const method = ABIMethod.fromSignature(opts.signature);

  const txn = makeApplicationNoOpTxnFromObject({
    sender: opts.sender,
    appIndex: opts.appId,
    appArgs: [method.getSelector(), ...opts.encodedArgs],
    boxes: (opts.boxNames ?? []).map((name) => ({ appIndex: opts.appId, name })),
    suggestedParams: params,
  });

  return {
    signed: false,
    unsignedTxnBase64: Buffer.from(encodeUnsignedTransaction(txn)).toString("base64"),
    txId: txn.txID(),
    network: config.network,
    appId: opts.appId,
    method: opts.signature,
    sender: opts.sender,
    summary: opts.summary,
    args: opts.args,
    boxes: (opts.boxNames ?? []).map(describeBoxName),
    fee: Number(txn.fee),
    validRounds: { first: Number(params.firstValid), last: Number(params.lastValid) },
    nextSteps: opts.nextSteps ?? [
      "Decode unsignedTxnBase64 and check the numbers in `summary` against it.",
      "Sign it with the wallet that holds `sender` — this package holds no key and cannot.",
      "Submit the signed bytes to POST {algod}/v2/transactions.",
    ],
  };
}

/** `jb_` + 8 raw bytes is unreadable in a diff; show the prefix and the number. */
function describeBoxName(name: Uint8Array): string {
  const prefix = Buffer.from(name.slice(0, 3)).toString("utf8");
  const tail = name.slice(3);
  if (tail.length === 8) {
    return `${prefix}${new DataView(tail.buffer, tail.byteOffset, 8).getBigUint64(0, false)}`;
  }
  return `${prefix}0x${Buffer.from(tail).toString("hex")}`;
}

export async function composePostJob(
  config: RiparConfig,
  input: { sender: string; specHash: string; budgetMicro: number; validatorAgentId?: number }
): Promise<UnsignedTransaction> {
  const appId = config.appIds.validation;
  if (!appId) throw new Error("No ValidationRegistry app id for this network");

  const specHash = fromHex(input.specHash);
  // The contract asserts this itself; failing here saves the caller a rejected
  // transaction and a wasted fee.
  if (specHash.length !== 32) {
    throw new Error(`specHash must be a 32-byte sha256 digest, got ${specHash.length} bytes`);
  }
  if (!Number.isInteger(input.budgetMicro) || input.budgetMicro <= 0) {
    throw new Error("budgetMicro must be a positive integer; the contract rejects a zero budget");
  }
  const validatorAgentId = input.validatorAgentId ?? 0;

  // post_job writes jb_<job_count + 1>, so the box that must be referenced is
  // the one that does not exist yet. Reading job_count now is the only way to
  // name it — get this wrong and the call fails with an unavailable-box error
  // that says nothing about why.
  const jobCount = await currentJobCount(config, appId);
  const nextJobId = jobCount + 1;

  return composeAppCall(config, {
    sender: input.sender,
    appId,
    signature: "post_job(byte[],uint64,uint64)uint64",
    encodedArgs: [
      ABIType.from("byte[]").encode(specHash),
      uint64Bytes(input.budgetMicro),
      uint64Bytes(validatorAgentId),
    ],
    boxNames: [jobBoxName(nextJobId)],
    summary:
      `Open job #${nextJobId} on ValidationRegistry ${appId} with a budget of ` +
      `${microToUsdc(input.budgetMicro)} USDC, committing to spec hash ${input.specHash}` +
      (validatorAgentId ? `, to be judged by agent ${validatorAgentId}` : ", with no validator set") +
      `. Signing this makes ${input.sender} the job's client.`,
    args: {
      specHash: input.specHash,
      budgetMicro: input.budgetMicro,
      budgetUsdc: microToUsdc(input.budgetMicro),
      validatorAgentId,
      expectedJobId: nextJobId,
    },
    nextSteps: [
      `This will be job #${nextJobId} unless someone else posts first, in which case the box reference is stale and the call fails harmlessly — recompose and try again.`,
      "Sign it with the wallet that holds `sender`; this package holds no key and cannot sign.",
      "Submit the signed bytes to POST {algod}/v2/transactions.",
    ],
  });
}

async function currentJobCount(config: RiparConfig, appId: number): Promise<number> {
  const res = await config.fetch(`${config.algod}/v2/applications/${appId}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Could not read job_count: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as {
    params: { "global-state"?: { key: string; value: { uint?: number } }[] };
  };
  const key = Buffer.from("job_count", "utf8").toString("base64");
  const entry = (body.params?.["global-state"] ?? []).find((e) => e.key === key);
  return Number(entry?.value?.uint ?? 0);
}
