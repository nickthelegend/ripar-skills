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
import { agentBoxName, escrowBoxName, fromHex, jobBoxName, uint64Bytes } from "./abi.js";
import { RiparRegistry, microToUsdc, type EscrowTerms, type JobWithEscrow } from "./registry.js";
import type { RiparConfig } from "./config.js";

const {
  ABIMethod,
  ABIType,
  assignGroupID,
  encodeUnsignedTransaction,
  getApplicationAddress,
  makeApplicationNoOpTxnFromObject,
  makeAssetTransferTxnWithSuggestedParamsFromObject,
} = algosdk;

/**
 * A box the call must declare, and which app owns it.
 *
 * `appId` matters because box references are shared across the whole group by
 * app id: when the ValidationRegistry resolves an agent by inner call into the
 * IdentityRegistry, the IDENTITY app's `ag_` box has to be listed here, on the
 * outer transaction, or the inner call fails on an unavailable box with an
 * error that names neither the box nor the app.
 */
export type BoxRef = { name: Uint8Array; appId?: number };

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
export async function composeAppCall(
  config: RiparConfig,
  opts: AppCallOptions
): Promise<UnsignedTransaction> {
  const params = await suggestedParams(config);
  const txn = buildAppCall(params, opts);

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
    boxes: (opts.boxes ?? []).map((b) => describeBoxRef(b, opts.appId)),
    fee: Number(txn.fee),
    validRounds: { first: Number(params.firstValid), last: Number(params.lastValid) },
    nextSteps: opts.nextSteps ?? [
      "Decode unsignedTxnBase64 and check the numbers in `summary` against it.",
      "Sign it with the wallet that holds `sender` — this package holds no key and cannot.",
      "Submit the signed bytes to POST {algod}/v2/transactions.",
    ],
  };
}

function buildAppCall(
  params: algosdk.SuggestedParams,
  opts: AppCallOptions
): algosdk.Transaction {
  // The selector is the first 4 bytes of sha512/256 over the exact signature
  // string, so it has to be derived from the signature rather than assembled by
  // hand — one character off and the contract's router rejects the call.
  const method = ABIMethod.fromSignature(opts.signature);
  const inners = opts.innerTransactions ?? 0;

  return makeApplicationNoOpTxnFromObject({
    sender: opts.sender,
    appIndex: opts.appId,
    appArgs: [method.getSelector(), ...opts.encodedArgs],
    boxes: (opts.boxes ?? []).map((b) => ({ appIndex: b.appId ?? opts.appId, name: b.name })),
    foreignApps: opts.foreignApps,
    foreignAssets: opts.foreignAssets,
    accounts: opts.accounts,
    suggestedParams: inners
      ? { ...params, flatFee: true, fee: Number(params.minFee) * (1 + inners) }
      : params,
  });
}

/** `jb_` + 8 raw bytes is unreadable in a diff; show the prefix and the number. */
function describeBoxRef(ref: BoxRef, ownAppId: number): string {
  const name = ref.name;
  const prefix = Buffer.from(name.slice(0, 3)).toString("utf8");
  const tail = name.slice(3);
  const body =
    tail.length === 8
      ? `${prefix}${new DataView(tail.buffer, tail.byteOffset, 8).getBigUint64(0, false)}`
      : `${prefix}0x${Buffer.from(tail).toString("hex")}`;
  // A foreign box is the interesting case — say whose it is, since an inner
  // call reading it is the only reason it would be listed here.
  return ref.appId && ref.appId !== ownAppId ? `${body}@${ref.appId}` : body;
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
    boxes: [{ name: jobBoxName(nextJobId) }],
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

// ---------------------------------------------------------------------------
// Escrow. The one place Ripar takes custody, so the one place a composer has to
// say out loud what signing will move, and who is allowed to move it.
// ---------------------------------------------------------------------------

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
  validRounds: { first: number; last: number };
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

async function loadJobForEscrow(
  config: RiparConfig,
  jobId: number
): Promise<{ job: JobWithEscrow; terms: EscrowTerms }> {
  const registry = new RiparRegistry(config);
  const [job, terms] = await Promise.all([
    registry.getJobWithEscrow(jobId),
    registry.escrowTerms(),
  ]);
  if (!job) throw new Error(`No job ${jobId} in the ValidationRegistry`);
  if (!terms.assetId) {
    throw new Error(
      `ValidationRegistry ${terms.validationApp} has no escrow asset, so it was never bootstrapped and nothing can be funded`
    );
  }
  return { job, terms };
}

/**
 * Compose the two-transaction group that moves a job's budget into escrow.
 *
 * The shape is the whole point. `fund_job` takes the transfer as a TRANSACTION
 * IN ITS OWN GROUP, not as an amount argument, so the number it records is one
 * the AVM has already validated — the same rule that stopped reputation being
 * minted from bytes. That is why this returns two transactions and not one, and
 * why they have to be signed and submitted together.
 */
export async function composeFundJob(
  config: RiparConfig,
  input: { sender: string; jobId: number; amountMicro: number }
): Promise<UnsignedTransactionGroup> {
  const appId = config.appIds.validation;
  if (!appId) throw new Error("No ValidationRegistry app id for this network");
  if (!Number.isInteger(input.amountMicro) || input.amountMicro <= 0) {
    throw new Error("amountMicro must be a positive integer; the contract rejects a zero transfer");
  }

  const { job, terms } = await loadJobForEscrow(config, input.jobId);
  // Both are contract asserts. Failing here costs nothing; failing on chain
  // costs a fee and reports only which assert line tripped.
  if (job.client !== input.sender) {
    throw new Error(
      `Only the client may fund their own job. Job ${job.jobId}'s client is ${job.client}, not ${input.sender}`
    );
  }
  if (job.status !== "open" && job.status !== "assigned") {
    throw new Error(
      `Job ${job.jobId} is ${job.status}; funding is only accepted while it is open or assigned`
    );
  }

  const params = await suggestedParams(config);
  const transfer = makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: input.sender,
    receiver: terms.appAddress,
    amount: input.amountMicro,
    assetIndex: terms.assetId,
    suggestedParams: params,
  });

  const boxes: BoxRef[] = [{ name: jobBoxName(job.jobId) }, { name: escrowBoxName(job.jobId) }];
  const call = buildAppCall(params, {
    sender: input.sender,
    appId,
    // The `axfer` argument is the transfer above: an ARC-4 transaction argument
    // is matched by POSITION in the group, not encoded into appArgs, so the
    // only app arg is the job id.
    signature: "fund_job(axfer,uint64)uint64",
    encodedArgs: [uint64Bytes(job.jobId)],
    boxes,
    summary: "",
    args: {},
  });

  assignGroupID([transfer, call]);
  const held = job.escrowMicro + input.amountMicro;

  return {
    signed: false,
    groupId: Buffer.from(call.group!).toString("base64"),
    network: config.network,
    appId,
    method: "fund_job(axfer,uint64)uint64",
    sender: input.sender,
    summary:
      `Move ${microToUsdc(input.amountMicro)} of asset ${terms.assetId} into escrow for job ` +
      `${job.jobId} on ValidationRegistry ${appId}. The job's budget is ` +
      `${job.budgetUsdc} and ${job.escrowUsdc} is escrowed now, so signing takes it to ` +
      `${microToUsdc(held)}. The money leaves ${input.sender} and is held by the contract at ` +
      `${terms.appAddress} until the work passes (release_escrow pays the assignee) or fails ` +
      `(refund_escrow returns it here).`,
    args: {
      jobId: job.jobId,
      amountMicro: input.amountMicro,
      amountUsdc: microToUsdc(input.amountMicro),
      assetId: terms.assetId,
      appAddress: terms.appAddress,
      budgetMicro: job.budgetMicro,
      escrowBeforeMicro: job.escrowMicro,
      escrowAfterMicro: held,
      fullyFundsBudget: held >= job.budgetMicro,
      jobStatus: job.status,
    },
    transactions: [
      {
        index: 0,
        kind: "axfer",
        unsignedTxnBase64: Buffer.from(encodeUnsignedTransaction(transfer)).toString("base64"),
        txId: transfer.txID(),
        fee: Number(transfer.fee),
        summary: `Transfer ${microToUsdc(input.amountMicro)} of asset ${terms.assetId} from ${input.sender} to the app account ${terms.appAddress}.`,
      },
      {
        index: 1,
        kind: "appl",
        unsignedTxnBase64: Buffer.from(encodeUnsignedTransaction(call)).toString("base64"),
        txId: call.txID(),
        fee: Number(call.fee),
        boxes: boxes.map((b) => describeBoxRef(b, appId)),
        summary: `Call fund_job(axfer,uint64) on app ${appId} for job ${job.jobId}, which reads the amount off transaction 0 and records it in the es_ box.`,
      },
    ],
    totalFee: Number(transfer.fee) + Number(call.fee),
    validRounds: { first: Number(params.firstValid), last: Number(params.lastValid) },
    nextSteps: [
      "Sign BOTH transactions with the wallet that holds `sender`, in this order — a group is invalid if any member is missing or moved.",
      `The transfer fails unless ${input.sender} has opted into asset ${terms.assetId} and holds at least ${microToUsdc(input.amountMicro)} of it.`,
      "Submit the two signed blobs together, concatenated, to POST {algod}/v2/transactions.",
      "This package holds no key and submits nothing.",
    ],
  };
}

/**
 * Compose `release_escrow` — pay the assignee.
 *
 * Legal only on a passing verdict. The client may call it immediately; anyone
 * at all may call it once the dispute window has passed since that verdict,
 * because a validator who never returns would otherwise freeze the worker's
 * money for good, and a lock with no key is not escrow, it is confiscation.
 */
export async function composeReleaseEscrow(
  config: RiparConfig,
  input: { sender: string; jobId: number }
): Promise<UnsignedTransaction> {
  const appId = config.appIds.validation!;
  const { job, terms } = await loadJobForEscrow(config, input.jobId);

  if (job.status !== "validated") {
    throw new Error(
      `Job ${job.jobId} is ${job.status}; escrow is released on a passing verdict only. ` +
        (job.status === "disputed" || job.status === "cancelled"
          ? "Use refund_escrow, which returns it to the client."
          : "Nothing is payable until a validator passes the result.")
    );
  }
  requireEscrow(job);

  const registry = new RiparRegistry(config);
  const assignee = await registry.getAgent(job.serverAgentId);
  if (!assignee) {
    throw new Error(
      `Job ${job.jobId} names agent ${job.serverAgentId} as its assignee, but the IdentityRegistry has no such record — the contract resolves the payee the same way and would fail`
    );
  }

  // The window runs from the verdict, which is the last thing that touched the
  // job, so updated_at IS the verdict time for a VALIDATED job.
  const windowClosesAt = job.updatedAt + terms.disputeWindowSecs;
  const now = Math.floor(Date.now() / 1000);
  const isClient = job.client === input.sender;

  return composeAppCall(config, {
    sender: input.sender,
    appId,
    signature: "release_escrow(uint64)uint64",
    encodedArgs: [uint64Bytes(job.jobId)],
    boxes: [
      { name: jobBoxName(job.jobId) },
      { name: escrowBoxName(job.jobId) },
      // Read by the IdentityRegistry during the inner call that resolves the
      // payee. Box references are group-wide by app id, so it goes here.
      { name: agentBoxName(job.serverAgentId), appId: terms.identityApp },
    ],
    foreignApps: [terms.identityApp],
    foreignAssets: [terms.assetId],
    accounts: [assignee.address],
    // agent_address() by inner app call, then the asset transfer.
    innerTransactions: 2,
    summary:
      `Release ${job.escrowUsdc} of asset ${terms.assetId} from ValidationRegistry ${appId} to ` +
      `${assignee.address} — agent ${job.serverAgentId} (${assignee.domain}), the agent that did ` +
      `the work on job ${job.jobId}. The escrow leaves the contract; ${input.sender} pays only ` +
      `the fee. ` +
      (isClient
        ? "You are the client, so this is legal now."
        : `You are not the client, so this is legal only after the dispute window closes at ` +
          `${new Date(windowClosesAt * 1000).toISOString()}.`),
    args: {
      jobId: job.jobId,
      escrowMicro: job.escrowMicro,
      escrowUsdc: job.escrowUsdc,
      assetId: terms.assetId,
      payee: assignee.address,
      serverAgentId: job.serverAgentId,
      client: job.client,
      senderIsClient: isClient,
      verdictAt: job.updatedAt,
      disputeWindowSecs: terms.disputeWindowSecs,
      disputeWindowClosesAt: windowClosesAt,
      disputeWindowClosesAtIso: new Date(windowClosesAt * 1000).toISOString(),
      anyoneMayReleaseNow: now > windowClosesAt,
    },
    nextSteps: [
      isClient
        ? "You are the job's client, so the contract accepts this immediately."
        : now > windowClosesAt
          ? `The dispute window closed at ${new Date(windowClosesAt * 1000).toISOString()}, so anyone may release — including you.`
          : `Wait: the dispute window closes at ${new Date(windowClosesAt * 1000).toISOString()}. Signed before then by anyone other than the client, this is rejected.`,
      "Sign it with the wallet that holds `sender` — this package holds no key and cannot.",
      "Submit the signed bytes to POST {algod}/v2/transactions.",
    ],
  });
}

/**
 * Compose `refund_escrow` — return the escrow to the client.
 *
 * Legal on a failed verdict or a cancelled job, and the destination is read off
 * the job rather than from the sender: whoever triggers a refund, the money
 * goes to the client, so triggering one can never redirect one.
 */
export async function composeRefundEscrow(
  config: RiparConfig,
  input: { sender: string; jobId: number }
): Promise<UnsignedTransaction> {
  const appId = config.appIds.validation!;
  const { job, terms } = await loadJobForEscrow(config, input.jobId);

  if (job.status !== "disputed" && job.status !== "cancelled") {
    throw new Error(
      `Job ${job.jobId} is ${job.status}; escrow is refunded on a failed verdict (disputed) or a cancelled job only. ` +
        (job.status === "validated"
          ? "Use release_escrow, which pays the assignee."
          : "Nothing is refundable while the job is still live.")
    );
  }
  requireEscrow(job);

  return composeAppCall(config, {
    sender: input.sender,
    appId,
    signature: "refund_escrow(uint64)uint64",
    encodedArgs: [uint64Bytes(job.jobId)],
    boxes: [{ name: jobBoxName(job.jobId) }, { name: escrowBoxName(job.jobId) }],
    foreignAssets: [terms.assetId],
    // The payee is the client, and it is not the sender in the general case.
    accounts: [job.client],
    // The asset transfer, and nothing else — a refund resolves no agent.
    innerTransactions: 1,
    summary:
      `Refund ${job.escrowUsdc} of asset ${terms.assetId} from ValidationRegistry ${appId} to ` +
      `${job.client}, the client of job ${job.jobId}, because the job is ${job.status}. The ` +
      `destination is read off the job, so it is the client whoever signs this; ` +
      `${input.sender} pays only the fee.`,
    args: {
      jobId: job.jobId,
      escrowMicro: job.escrowMicro,
      escrowUsdc: job.escrowUsdc,
      assetId: terms.assetId,
      payee: job.client,
      jobStatus: job.status,
      senderIsClient: job.client === input.sender,
    },
    nextSteps: [
      "Anyone may sign this: the contract puts no condition on the sender, because the money can only go to the client.",
      "Sign it with the wallet that holds `sender` — this package holds no key and cannot.",
      "Submit the signed bytes to POST {algod}/v2/transactions.",
    ],
  });
}

/** The box is deleted the moment the escrow is paid out, so absent means paid. */
function requireEscrow(job: JobWithEscrow): void {
  if (job.escrowMicro <= 0) {
    throw new Error(
      `Nothing is escrowed for job ${job.jobId}: its budget is ${job.budgetUsdc} but the es_ box holds 0. ` +
        `Either it was never funded, or it was already paid out — the contract deletes the box before it sends, ` +
        `which is what makes paying twice impossible.`
    );
  }
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
