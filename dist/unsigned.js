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
import { createHash } from "node:crypto";
import algosdk from "algosdk";
import { addressBoxName, agentBoxName, bidBoxName, escrowBoxName, fromHex, jobBoxName, uint64Bytes, } from "./abi.js";
import { RiparRegistry, microToUsdc } from "./registry.js";
import { CONTRACT_METHODS, assertMethodDeployed } from "./deployed.js";
const { ABIMethod, ABIType, assignGroupID, encodeUnsignedTransaction, getApplicationAddress, makeApplicationNoOpTxnFromObject, makeAssetTransferTxnWithSuggestedParamsFromObject, } = algosdk;
export async function suggestedParams(config) {
    const res = await config.fetch(`${config.algod}/v2/transactions/params`, {
        headers: { accept: "application/json" },
    });
    if (!res.ok) {
        throw new Error(`Could not fetch suggested params: ${res.status} ${res.statusText}`);
    }
    const p = (await res.json());
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
export async function composeAppCall(config, opts) {
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
function buildAppCall(params, opts) {
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
function describeBoxRef(ref, ownAppId) {
    const name = ref.name;
    const prefix = Buffer.from(name.slice(0, 3)).toString("utf8");
    const tail = name.slice(3);
    const body = tail.length === 8
        ? `${prefix}${new DataView(tail.buffer, tail.byteOffset, 8).getBigUint64(0, false)}`
        : `${prefix}0x${Buffer.from(tail).toString("hex")}`;
    // A foreign box is the interesting case — say whose it is, since an inner
    // call reading it is the only reason it would be listed here.
    return ref.appId && ref.appId !== ownAppId ? `${body}@${ref.appId}` : body;
}
export async function composePostJob(config, input) {
    const appId = config.appIds.validation;
    if (!appId)
        throw new Error("No ValidationRegistry app id for this network");
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
        summary: `Open job #${nextJobId} on ValidationRegistry ${appId} with a budget of ` +
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
async function loadJobForEscrow(config, jobId) {
    const registry = new RiparRegistry(config);
    const [job, terms] = await Promise.all([
        registry.getJobWithEscrow(jobId),
        registry.escrowTerms(),
    ]);
    if (!job)
        throw new Error(`No job ${jobId} in the ValidationRegistry`);
    if (!terms.assetId) {
        throw new Error(`ValidationRegistry ${terms.validationApp} has no escrow asset, so it was never bootstrapped and nothing can be funded`);
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
export async function composeFundJob(config, input) {
    const appId = config.appIds.validation;
    if (!appId)
        throw new Error("No ValidationRegistry app id for this network");
    if (!Number.isInteger(input.amountMicro) || input.amountMicro <= 0) {
        throw new Error("amountMicro must be a positive integer; the contract rejects a zero transfer");
    }
    const { job, terms } = await loadJobForEscrow(config, input.jobId);
    // Both are contract asserts. Failing here costs nothing; failing on chain
    // costs a fee and reports only which assert line tripped.
    if (job.client !== input.sender) {
        throw new Error(`Only the client may fund their own job. Job ${job.jobId}'s client is ${job.client}, not ${input.sender}`);
    }
    if (job.status !== "open" && job.status !== "assigned") {
        throw new Error(`Job ${job.jobId} is ${job.status}; funding is only accepted while it is open or assigned`);
    }
    const params = await suggestedParams(config);
    const transfer = makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: input.sender,
        receiver: terms.appAddress,
        amount: input.amountMicro,
        assetIndex: terms.assetId,
        suggestedParams: params,
    });
    const boxes = [{ name: jobBoxName(job.jobId) }, { name: escrowBoxName(job.jobId) }];
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
        groupId: Buffer.from(call.group).toString("base64"),
        network: config.network,
        appId,
        method: "fund_job(axfer,uint64)uint64",
        sender: input.sender,
        summary: `Move ${microToUsdc(input.amountMicro)} of asset ${terms.assetId} into escrow for job ` +
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
export async function composeReleaseEscrow(config, input) {
    const appId = config.appIds.validation;
    const { job, terms } = await loadJobForEscrow(config, input.jobId);
    if (job.status !== "validated") {
        throw new Error(`Job ${job.jobId} is ${job.status}; escrow is released on a passing verdict only. ` +
            (job.status === "disputed" || job.status === "cancelled"
                ? "Use refund_escrow, which returns it to the client."
                : "Nothing is payable until a validator passes the result."));
    }
    requireEscrow(job);
    const registry = new RiparRegistry(config);
    const assignee = await registry.getAgent(job.serverAgentId);
    if (!assignee) {
        throw new Error(`Job ${job.jobId} names agent ${job.serverAgentId} as its assignee, but the IdentityRegistry has no such record — the contract resolves the payee the same way and would fail`);
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
        summary: `Release ${job.escrowUsdc} of asset ${terms.assetId} from ValidationRegistry ${appId} to ` +
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
export async function composeRefundEscrow(config, input) {
    const appId = config.appIds.validation;
    const { job, terms } = await loadJobForEscrow(config, input.jobId);
    if (job.status !== "disputed" && job.status !== "cancelled") {
        throw new Error(`Job ${job.jobId} is ${job.status}; escrow is refunded on a failed verdict (disputed) or a cancelled job only. ` +
            (job.status === "validated"
                ? "Use release_escrow, which pays the assignee."
                : "Nothing is refundable while the job is still live."));
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
        summary: `Refund ${job.escrowUsdc} of asset ${terms.assetId} from ValidationRegistry ${appId} to ` +
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
// ---------------------------------------------------------------------------
// Bidding. Every composer below FIRST checks the live approval program for the
// method's selector, because these are the features that exist in
// ripar-contracts and not on chain. See deployed.ts for why an absent selector
// is proof and a present one is only strong evidence.
// ---------------------------------------------------------------------------
/**
 * sha256 of the pitch text, as hex. The text itself never leaves this process.
 *
 * UTF-8, explicitly, because the digest is a commitment two parties have to
 * agree on: the bidder hashes the words and the client re-hashes them later to
 * check they were shown the same offer. An encoding either side has to guess at
 * would make honest pitches fail that check.
 */
export function hashPitch(pitch) {
    return createHash("sha256").update(Buffer.from(pitch, "utf8")).digest("hex");
}
/**
 * Compose `place_bid` — offer to do a job at a price.
 *
 * The pitch is COMMITTED BY HASH, not stored. What goes on chain is 32 bytes;
 * the words stay wherever the bidder keeps them. That is the same rule the spec
 * and the result already follow, and it is doing real work here: a bid board
 * that stored prose would put every agent's sales copy into permanent, paid box
 * storage, and a client could still not prove the pitch they read was the one
 * bid under. A hash proves exactly that, and costs 32 bytes.
 *
 * Because the text is not recoverable from the chain, the BIDDER has to keep
 * it. This function returns the hash and says so; it does not store anything.
 */
export async function composePlaceBid(config, input) {
    const appId = config.appIds.validation;
    if (!appId)
        throw new Error("No ValidationRegistry app id for this network");
    await assertMethodDeployed(config, appId, CONTRACT_METHODS.place_bid.signature, `Bidding is written in ripar-contracts/contracts/validation_registry.py and compiles, but the ` +
        `ValidationRegistry that is live on TestNet predates it. Until a registry with place_bid is ` +
        `deployed, the way onto a job is the client naming you directly with assign_job — there is no ` +
        `bid to place, and ripar_list_bids on this registry will always be empty for the same reason.`);
    if (!Number.isInteger(input.priceMicro) || input.priceMicro <= 0) {
        throw new Error("priceMicro must be a positive integer; the contract rejects a zero bid");
    }
    if (!Number.isInteger(input.bidderAgentId) || input.bidderAgentId < 1) {
        throw new Error("bidderAgentId must be a registered agent id");
    }
    // Exactly one source for the commitment. Accepting both and preferring one
    // would let a caller show a pitch while committing to a different digest.
    if ((input.pitch === undefined) === (input.pitchHash === undefined)) {
        throw new Error("Give exactly one of `pitch` (the text, hashed here) or `pitchHash` (a digest you made yourself). " +
            "Both would let the text and the commitment disagree; neither leaves nothing to commit to.");
    }
    const pitchHash = input.pitch !== undefined ? hashPitch(input.pitch) : input.pitchHash;
    const digest = fromHex(pitchHash);
    if (digest.length !== 32) {
        throw new Error(`pitchHash must be a 32-byte sha256 digest, got ${digest.length} bytes`);
    }
    // Both are contract asserts, and both are cheaper to fail here.
    const registry = new RiparRegistry(config);
    const [job, bidder] = await Promise.all([
        registry.getJob(input.jobId),
        registry.getAgent(input.bidderAgentId),
    ]);
    if (!job)
        throw new Error(`No job ${input.jobId} in the ValidationRegistry`);
    if (job.status !== "open") {
        throw new Error(`Job ${job.jobId} is ${job.status}; bids close when the job is assigned. A bid that looks ` +
            `live on work somebody else is already doing misleads whoever reads the board.`);
    }
    if (!bidder) {
        throw new Error(`The IdentityRegistry has no agent ${input.bidderAgentId}. The contract resolves the bidder ` +
            `through it and would reject this — only the bidding agent's own address may bid.`);
    }
    if (bidder.address !== input.sender) {
        throw new Error(`Agent ${input.bidderAgentId} is controlled by ${bidder.address}, not ${input.sender}. ` +
            `Only the bidding agent may place its own bid, so an agent cannot be bid on behalf of.`);
    }
    if (job.client === input.sender) {
        throw new Error(`${input.sender} is the client of job ${job.jobId} and cannot bid on it`);
    }
    const identityApp = config.appIds.identity;
    return composeAppCall(config, {
        sender: input.sender,
        appId,
        signature: CONTRACT_METHODS.place_bid.signature,
        encodedArgs: [
            uint64Bytes(input.jobId),
            uint64Bytes(input.bidderAgentId),
            uint64Bytes(input.priceMicro),
            ABIType.from("byte[]").encode(digest),
        ],
        boxes: [
            { name: jobBoxName(input.jobId) },
            { name: bidBoxName(input.jobId, input.bidderAgentId) },
            // Read by the IdentityRegistry when it resolves the bidder. Box refs are
            // group-wide by app id, so the foreign box is declared on this call.
            { name: agentBoxName(input.bidderAgentId), appId: identityApp },
        ],
        foreignApps: [identityApp],
        // _agent_address() resolves the bidder by inner app call.
        innerTransactions: 1,
        summary: `Bid ${microToUsdc(input.priceMicro)} on job ${job.jobId} as agent ${input.bidderAgentId} ` +
            `(${bidder.domain}). The job's stated budget is ${microToUsdc(job.budgetMicro)}. ` +
            `Only the 32-byte hash ${pitchHash} goes on chain — THE PITCH TEXT STAYS OFF CHAIN, so keep ` +
            `it: nobody, including this tool, can recover it from the registry, and you will need it to ` +
            `show the client what they are accepting. A second bid from this agent on this job REPLACES ` +
            `this one.`,
        args: {
            jobId: job.jobId,
            bidderAgentId: input.bidderAgentId,
            bidderDomain: bidder.domain,
            bidderAddress: bidder.address,
            priceMicro: input.priceMicro,
            priceUsdc: microToUsdc(input.priceMicro),
            jobBudgetMicro: job.budgetMicro,
            jobBudgetUsdc: microToUsdc(job.budgetMicro),
            undercutsBudget: input.priceMicro < job.budgetMicro,
            pitchHash,
            pitchStoredOnChain: false,
            pitchBytesOnChain: 32,
        },
        nextSteps: [
            `Keep the pitch text. The chain holds ${pitchHash} and nothing else, and a commitment you ` +
                `cannot open is a commitment to nothing.`,
            "Sign it with the wallet that holds `sender` — this package holds no key and cannot.",
            "Submit the signed bytes to POST {algod}/v2/transactions.",
            "Accepting is the client's move, not yours: they call accept_bid, which assigns the job to you AND rewrites its budget to your price.",
        ],
    });
}
/**
 * Compose `accept_bid` — take an offer.
 *
 * **Accepting REWRITES the job's budget to the bid price.** That is not a side
 * effect, it is the point: accepting an offer of 0.4 on a job budgeted at 1.0
 * should leave the record saying 0.4, because otherwise the job, the escrow and
 * any release all disagree about what was agreed, and a release reading the old
 * budget would pay a number nobody offered. The summary states the before and
 * after explicitly so the client signs knowing which of the two numbers
 * survives.
 *
 * It also assigns the job, in the same call. There is no separate assign step
 * and no window in which the job is assigned at the old price.
 */
export async function composeAcceptBid(config, input) {
    const appId = config.appIds.validation;
    if (!appId)
        throw new Error("No ValidationRegistry app id for this network");
    await assertMethodDeployed(config, appId, CONTRACT_METHODS.accept_bid.signature, `accept_bid exists in ripar-contracts/contracts/validation_registry.py and compiles, but the ` +
        `live ValidationRegistry predates it — and so does place_bid, so there are no bids on it to ` +
        `accept. What works today is assign_job: the client names the agent, and the budget stays ` +
        `whatever was posted.`);
    const registry = new RiparRegistry(config);
    const job = await registry.getJob(input.jobId);
    if (!job)
        throw new Error(`No job ${input.jobId} in the ValidationRegistry`);
    if (job.client !== input.sender) {
        throw new Error(`Only the client may accept a bid. Job ${job.jobId}'s client is ${job.client}, not ${input.sender}`);
    }
    if (job.status !== "open") {
        throw new Error(`Job ${job.jobId} is ${job.status}; a bid can only be accepted while it is open`);
    }
    const bids = await registry.listBids(input.jobId);
    const bid = bids.find((b) => b.bidderAgentId === input.bidderAgentId);
    if (!bid) {
        throw new Error(`Agent ${input.bidderAgentId} has no bid on job ${input.jobId}. ` +
            (bids.length
                ? `The bids on it are from agents ${bids.map((b) => b.bidderAgentId).join(", ")}.`
                : `There are no bids on it at all.`));
    }
    const bidder = await registry.getAgent(input.bidderAgentId);
    const identityApp = config.appIds.identity;
    const delta = bid.priceMicro - job.budgetMicro;
    return composeAppCall(config, {
        sender: input.sender,
        appId,
        signature: CONTRACT_METHODS.accept_bid.signature,
        encodedArgs: [uint64Bytes(input.jobId), uint64Bytes(input.bidderAgentId)],
        boxes: [
            { name: jobBoxName(input.jobId) },
            { name: bidBoxName(input.jobId, input.bidderAgentId) },
            { name: agentBoxName(input.bidderAgentId), appId: identityApp },
        ],
        foreignApps: [identityApp],
        summary: `Accept agent ${input.bidderAgentId}${bidder ? ` (${bidder.domain})` : ""}'s bid of ` +
            `${microToUsdc(bid.priceMicro)} on job ${job.jobId}, which assigns the job to them. ` +
            `ACCEPTING REWRITES THE JOB'S BUDGET: it currently reads ${microToUsdc(job.budgetMicro)} and ` +
            `will read ${microToUsdc(bid.priceMicro)} afterwards` +
            (delta === 0
                ? ` — the same number, because the bid matched the budget.`
                : delta < 0
                    ? ` — ${microToUsdc(-delta)} less than posted.`
                    : ` — ${microToUsdc(delta)} MORE than you posted. Check that.`) +
            ` Everything downstream reads the new figure, including escrow and release. ` +
            `The losing bids are NOT swept and stay readable.`,
        args: {
            jobId: job.jobId,
            bidderAgentId: input.bidderAgentId,
            bidderDomain: bidder?.domain ?? null,
            bidderAddress: bidder?.address ?? null,
            budgetBeforeMicro: job.budgetMicro,
            budgetBeforeUsdc: microToUsdc(job.budgetMicro),
            budgetAfterMicro: bid.priceMicro,
            budgetAfterUsdc: microToUsdc(bid.priceMicro),
            budgetChangesTo: microToUsdc(bid.priceMicro),
            pitchHash: bid.pitchHash,
            competingBids: bids.length,
            cheaperBidsNotTaken: bids.filter((b) => b.priceMicro < bid.priceMicro).length,
        },
        nextSteps: [
            `Signing this sets job ${job.jobId}'s budget to ${microToUsdc(bid.priceMicro)}. If you have ` +
                `already escrowed against the old figure, the difference does not move on its own.`,
            `Ask the bidder for the pitch text behind ${bid.pitchHash} and check it hashes to that, before signing rather than after.`,
            "Sign it with the wallet that holds `sender` — this package holds no key and cannot.",
            "Submit the signed bytes to POST {algod}/v2/transactions.",
        ],
    });
}
/**
 * Compose `rotate_address` — move an identity to a new controlling key.
 *
 * This is the recovery path, and without it a compromised key is TERMINAL.
 * `new_agent` asserts one identity per address, so the owner of a stolen key
 * can neither re-register nor reclaim: the agent id, and every score and job
 * that references it, stays bound to a key somebody else holds. An identity you
 * cannot move is an identity you cannot secure.
 *
 * The reverse index moves with it, which is the part that matters for anyone
 * about to pay. `ad_<old key>` is DELETED, so **the old address stops resolving
 * to this agent**. If it kept resolving, a caller running the obvious check —
 * "does the address this card wants me to pay match the registry?" — would
 * still get a match on the compromised key, and the rotation would have secured
 * nothing.
 *
 * Only the CURRENT address may sign, so this is a race: it recovers a key you
 * fear is exposed, and it is useless against one already being used against
 * you. Rotate on suspicion, not on confirmation.
 */
export async function composeRotateAddress(config, input) {
    const appId = config.appIds.identity;
    if (!appId)
        throw new Error("No IdentityRegistry app id for this network");
    await assertMethodDeployed(config, appId, CONTRACT_METHODS.rotate_address.signature, `rotate_address exists in ripar-contracts/contracts/identity_registry.py and compiles, but the ` +
        `live IdentityRegistry predates it, so THERE IS NO KEY RECOVERY ON CHAIN TODAY. What the ` +
        `deployed contract does have is deregister_agent, which the current address can call to free ` +
        `the domain and address boxes — after which a NEW agent id can be registered from a new ` +
        `address. That loses the id, and every score and job that references it, which is exactly the ` +
        `cost rotation exists to avoid. If the key is compromised, treat this as urgent: whoever holds ` +
        `it can also deregister, and can do it first.`);
    // Validated before anything is composed: an invalid address would otherwise
    // fail deep inside decodeAddress with a message about base32 checksums, and
    // the caller's actual mistake is one wrong character in an address.
    let newPublicKey;
    try {
        newPublicKey = algosdk.decodeAddress(input.newAddress).publicKey;
    }
    catch {
        throw new Error(`newAddress is not a valid Algorand address: ${input.newAddress}`);
    }
    const registry = new RiparRegistry(config);
    const agent = await registry.getAgent(input.agentId);
    if (!agent)
        throw new Error(`No agent ${input.agentId} in the IdentityRegistry`);
    if (agent.address !== input.sender) {
        throw new Error(`Agent ${input.agentId} is controlled by ${agent.address}, not ${input.sender}. Only the ` +
            `current address may rotate — which is why rotation is a race against whoever has the key.`);
    }
    if (agent.address === input.newAddress) {
        throw new Error(`${input.newAddress} is already agent ${input.agentId}'s controlling address. The contract ` +
            `refuses a rotation to itself rather than succeeding silently, because succeeding silently ` +
            `would hide a typo in the address you meant to move to.`);
    }
    const alreadyUsed = await registry.resolveByAddress(input.newAddress);
    if (alreadyUsed !== 0) {
        throw new Error(`${input.newAddress} already controls agent ${alreadyUsed}. The registry holds one identity ` +
            `per address, so the destination has to be an address with no agent of its own.`);
    }
    return composeAppCall(config, {
        sender: input.sender,
        appId,
        signature: CONTRACT_METHODS.rotate_address.signature,
        // An ARC-4 `address` is the bare 32-byte public key — no length prefix and
        // not the 58-character base32 form a human reads.
        encodedArgs: [uint64Bytes(input.agentId), newPublicKey],
        boxes: [
            { name: agentBoxName(input.agentId) },
            // The OLD reverse index, which this call deletes...
            { name: addressBoxName(agent.address) },
            // ...and the NEW one, which it creates. Both must be declared: an
            // undeclared box fails the call on an unavailable-box error that names
            // neither box nor reason.
            { name: addressBoxName(input.newAddress) },
        ],
        summary: `Move agent ${input.agentId} (${agent.domain}) from ${agent.address} to ${input.newAddress} ` +
            `on IdentityRegistry ${appId}. THE OLD ADDRESS STOPS RESOLVING: the ad_ box for ` +
            `${agent.address} is deleted, so a caller checking "does the payee match the registry" gets a ` +
            `MISS on the old key from the moment this confirms — which is the whole point, since a key ` +
            `you are rotating away from is one you no longer trust. The agent id, its domain, and every ` +
            `score and job referencing it are unchanged and stay with the identity. ` +
            `Only ${agent.address} can sign this, so if the key is already being used against you, ` +
            `whoever holds it can rotate first.`,
        args: {
            agentId: input.agentId,
            domain: agent.domain,
            oldAddress: agent.address,
            newAddress: input.newAddress,
            oldAddressStopsResolving: true,
            idIsPreserved: true,
            reputationFollowsTheId: true,
        },
        nextSteps: [
            "Sign it with the wallet that holds the OLD address — it is the only key the contract accepts, and it is also the key you are retiring.",
            "Submit the signed bytes to POST {algod}/v2/transactions.",
            `Then re-check with ripar_get_agent: ${input.newAddress} must resolve to agent ${input.agentId} and ${agent.address} must resolve to nothing.`,
            `Update the agent card at https://${agent.domain}/.well-known/agent.json — its x402 payTo still names ${agent.address}, and until it changes the card and the registry disagree about who to pay. ripar_agent_health reports exactly that mismatch.`,
        ],
    });
}
/** The box is deleted the moment the escrow is paid out, so absent means paid. */
function requireEscrow(job) {
    if (job.escrowMicro <= 0) {
        throw new Error(`Nothing is escrowed for job ${job.jobId}: its budget is ${job.budgetUsdc} but the es_ box holds 0. ` +
            `Either it was never funded, or it was already paid out — the contract deletes the box before it sends, ` +
            `which is what makes paying twice impossible.`);
    }
}
async function currentJobCount(config, appId) {
    const res = await config.fetch(`${config.algod}/v2/applications/${appId}`, {
        headers: { accept: "application/json" },
    });
    if (!res.ok)
        throw new Error(`Could not read job_count: ${res.status} ${res.statusText}`);
    const body = (await res.json());
    const key = Buffer.from("job_count", "utf8").toString("base64");
    const entry = (body.params?.["global-state"] ?? []).find((e) => e.key === key);
    return Number(entry?.value?.uint ?? 0);
}
