/**
 * The tools, defined as data.
 *
 * Keeping the specs in a plain array — rather than inline in `registerTool`
 * calls — means the schemas can be asserted on directly, an A2A card can list
 * the tool names without starting a server, and a bad tool definition fails a
 * test instead of failing silently in a client that just... doesn't show it.
 *
 * The read/write split is the important thing here. Eight tools read the chain
 * (or, for `ripar_agent_health`, the chain and the agent's own HTTP endpoints)
 * and are marked `readOnlyHint`. Six compose a transaction and return it
 * UNSIGNED. One (`ripar_call_endpoint`) can spend money, but only with a
 * payment header the caller supplies, because this process has no key. A client
 * is entitled to show a confirmation prompt for those last seven and nothing
 * else, and the annotations say so honestly.
 *
 * Three of the compose tools — `ripar_place_bid`, `ripar_accept_bid` and
 * `ripar_rotate_address` — target methods whose presence on the LIVE registries
 * varies, because the deployed generation predates part of the audited ABI.
 * Verified against the deployed approval programs rather than assumed:
 * `accept_bid(uint64,uint64)bool` and `rotate_address(uint64,address)bool` ARE
 * live; `place_bid` is not present under any signature. This header used to say
 * all three were missing while the tool descriptions said all three were
 * deployed — the file contradicted itself, and both halves were partly wrong.
 * Each tool reads the target app's approval program for the selector before
 * composing and refuses with what the contract does offer. See `src/deployed.ts`.
 */
import { z } from "zod";
import { microToUsdc } from "../registry.js";
import { REGISTRY_APP_IDS } from "../config.js";
import { composeAcceptBid, composeFundJob, composePlaceBid, composePostJob, composeRefundEscrow, composeReleaseEscrow, composeRotateAddress, } from "../unsigned.js";
import { agentHealth } from "../health.js";
import { CONTRACT_METHODS, isMethodDeployed } from "../deployed.js";
import { callEndpoint, quoteEndpoint } from "../x402.js";
import { SKILLS, skillPriceUsdc, skillInputJsonSchema } from "../skills.js";
import { JOB_STATUS } from "../config.js";
const jobStatusValues = Object.values(JOB_STATUS);
/**
 * The ids the descriptions quote. Interpolated, never typed out: these strings
 * are what an LLM client reads to decide what a tool does, and for three
 * generations they went on naming a superseded registry while the code read the
 * current one. Prose that repeats a constant is prose that will eventually lie
 * about it.
 */
const LIVE = REGISTRY_APP_IDS.testnet;
export const TOOLS = [
    // ------------------------------------------------------------------ reads
    {
        name: "ripar_search_agents",
        title: "Search Ripar agents",
        description: `List or search agents in the on-chain IdentityRegistry (Algorand TestNet app ${LIVE.identity}). ` +
            "Matches a substring of the agent's domain, or an exact agent id or Algorand address. " +
            "Returns live registry records — if the chain is unreachable this fails rather than guessing.",
        inputShape: {
            query: z
                .string()
                .optional()
                .describe("Domain substring, an exact agent id, or an Algorand address. Omit to list all."),
            limit: z.number().int().min(1).max(100).default(25).describe("Maximum agents to return"),
            withReputation: z
                .boolean()
                .default(false)
                .describe("Also read each agent's score box. Costs one extra box read per agent."),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
        async run(args, { registry, config }) {
            const agents = await registry.searchAgents(args.query, args.limit ?? 25);
            const enriched = args.withReputation
                ? await Promise.all(agents.map(async (a) => ({
                    ...a,
                    score: await registry.getScore(a.agentId).catch(() => null),
                })))
                : agents;
            return {
                network: config.network,
                identityApp: config.appIds.identity,
                total: await registry.totalAgents(),
                query: args.query ?? null,
                count: enriched.length,
                agents: enriched.map((a) => ({
                    ...a,
                    cardUrl: `https://${a.domain}/.well-known/agent.json`,
                })),
            };
        },
    },
    {
        name: "ripar_get_agent",
        title: "Get one Ripar agent",
        description: "Fetch a single agent record from the IdentityRegistry by id, domain, or Algorand address. " +
            "Returns found:false with the reason when the registry has no such agent — the contract's " +
            "'not found' value is a literal 0, so an absent agent is a real answer, not an error.",
        inputShape: {
            agentId: z.number().int().positive().optional().describe("Registry id"),
            domain: z.string().min(1).optional().describe("Exact domain, e.g. agent-123.ripar.io"),
            address: z.string().length(58).optional().describe("Algorand address, 58 characters"),
            includeReputation: z.boolean().default(true).describe("Also read the agent's score box"),
            includeJobs: z.boolean().default(false).describe("Also list jobs this agent is involved in"),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
        async run(args, ctx) {
            const base = (await SKILLS.find((s) => s.id === "ripar.identity.resolve").run({ agentId: args.agentId, domain: args.domain, address: args.address }, ctx));
            if (!base.found || !base.agent)
                return base;
            const [score, jobs] = await Promise.all([
                args.includeReputation !== false
                    ? ctx.registry.getScore(base.agent.agentId).catch(() => null)
                    : Promise.resolve(null),
                // With escrow, because "which jobs is this agent on" is nearly always
                // asked by someone about to decide whether the work is worth doing.
                args.includeJobs
                    ? ctx.registry.listJobsWithEscrow({ agentId: base.agent.agentId })
                    : Promise.resolve(null),
            ]);
            return { ...base, score, ...(jobs ? { jobs } : {}) };
        },
    },
    {
        name: "ripar_get_reputation",
        title: "Get an agent's reputation",
        description: `Read an agent's score from the ReputationRegistry (Algorand TestNet app ${LIVE.reputation}): payments ` +
            "credited to it, total USDC volume, and validator verdicts. Each credit is keyed to a payment " +
            "transaction id and the contract refuses to count the same id twice, but it does NOT verify " +
            "that the id names a real transfer — so treat a score as a claim recorded on chain, not one " +
            "proven by it, and call ripar_settlements to check it against the indexer before trusting a " +
            "number. An agent with no score box has never been credited at all, which is different from " +
            "having been paid and scored zero.",
        inputShape: {
            agentId: z.number().int().positive().describe("Registry id of the agent"),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
        async run(args, ctx) {
            return SKILLS.find((s) => s.id === "ripar.reputation.report").run({ agentId: args.agentId }, ctx);
        },
    },
    {
        name: "ripar_list_jobs",
        title: "List validated jobs, with what is actually escrowed",
        description: `List jobs on the ValidationRegistry (Algorand TestNet app ${LIVE.validation}), newest first, ` +
            "optionally filtered by status or by the agent serving or validating them. Each job commits " +
            "to its spec by hash; the spec and the result themselves stay offchain. " +
            "Every job reports BOTH numbers, and they mean different things: the BUDGET is what the " +
            "client says the work is worth, and the ESCROW is what they have actually handed to the " +
            "contract. A job with budget 1.0 and escrow 0 is unfunded — the budget is an intention, " +
            "nobody has committed a cent, and that is the single most useful thing to know before " +
            "bidding. escrow is read from the `es_` box, which the contract deletes the moment the " +
            "money is paid out, so 0 on a finished job means it was settled, not that it never existed.",
        inputShape: {
            status: z
                .enum(jobStatusValues)
                .optional()
                .describe("Filter by lifecycle state. 'disputed' is a validator's failing verdict."),
            agentId: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("Only jobs where this agent is the server or the validator"),
            jobId: z.number().int().positive().optional().describe("Fetch exactly one job"),
            limit: z.number().int().min(1).max(100).default(25).describe("Maximum jobs to return"),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
        async run(args, { registry, config }) {
            // The terms come from global state, so the asset and the dispute window
            // are the contract's own numbers rather than constants that could drift.
            const terms = await registry.escrowTerms();
            const escrow = {
                assetId: terms.assetId,
                heldBy: terms.appAddress,
                disputeWindowSecs: terms.disputeWindowSecs,
                note: "budget is what the client says the work is worth; escrow is what the contract actually holds. " +
                    "Fund one with ripar_fund_job, settle it with ripar_settle_escrow.",
            };
            if (args.jobId !== undefined) {
                const job = await registry.getJobWithEscrow(args.jobId);
                return job
                    ? { network: config.network, validationApp: config.appIds.validation, escrow, job }
                    : { found: false, reason: `no job ${args.jobId} in the registry` };
            }
            const jobs = await registry.listJobsWithEscrow({
                status: args.status,
                agentId: args.agentId,
                limit: args.limit ?? 25,
            });
            const fundedMicro = jobs.reduce((sum, j) => sum + j.escrowMicro, 0);
            return {
                network: config.network,
                validationApp: config.appIds.validation,
                total: await registry.totalJobs(),
                filters: { status: args.status ?? null, agentId: args.agentId ?? null },
                count: jobs.length,
                escrow: {
                    ...escrow,
                    fundedJobs: jobs.filter((j) => j.funded).length,
                    totalEscrowedUsdc: microToUsdc(fundedMicro),
                },
                jobs,
            };
        },
    },
    {
        name: "ripar_settlements",
        title: "Settlement history and reputation gap",
        description: "List real USDC transfers for an agent from the Algorand indexer, alongside the score the " +
            "ReputationRegistry actually holds — so a number an agent claims can be checked against " +
            "money that demonstrably moved. There is deliberately no per-transfer 'already credited' " +
            "flag: the chain records none, and inventing one by marking everything uncredited would be " +
            "a lie in the shape of an answer. What the result does give is `creditable`: the inbound " +
            "transfers accept_feedback could still be called for.",
        inputShape: {
            agentId: z.number().int().positive().optional().describe("Agent to look at"),
            address: z.string().length(58).optional().describe("Algorand address, if you have no agent id"),
            limit: z.number().int().min(1).max(100).default(25).describe("How many transfers to fetch"),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
        async run(args, ctx) {
            return SKILLS.find((s) => s.id === "ripar.settlement.audit").run({ agentId: args.agentId, address: args.address, limit: args.limit ?? 25 }, ctx);
        },
    },
    {
        name: "ripar_quote_endpoint",
        title: "Quote an x402 endpoint",
        description: "Ask a paid endpoint what it charges, without paying. Makes the request, reads the HTTP 402 " +
            "challenge, and reports the cheapest acceptable payment: amount, asset, network, and payee. " +
            "An endpoint that answers 200 is reported as free rather than as an error.",
        inputShape: {
            url: z.string().url().describe("Full URL of the endpoint to quote"),
            method: z.enum(["GET", "POST"]).default("GET").describe("HTTP method"),
            body: z.record(z.string(), z.unknown()).optional().describe("JSON body, for POST"),
            headers: z.record(z.string(), z.string()).optional().describe("Extra request headers"),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
        async run(args, { config }) {
            return quoteEndpoint(args.url, {
                method: args.method ?? "GET",
                body: args.body,
                headers: args.headers,
                network: config.network,
                fetch: config.fetch,
            });
        },
    },
    // ------------------------------------------------------- writes / spending
    {
        name: "ripar_call_endpoint",
        title: "Call an endpoint (x402-aware)",
        description: "Call an endpoint and return its response. If it answers 402, you get the payment challenge " +
            "back instead of a result — this server holds no private key and CANNOT pay. To complete a " +
            "paid call, have a wallet sign the payment and pass the resulting header as paymentHeader; it " +
            "is forwarded untouched as X-PAYMENT.",
        inputShape: {
            url: z.string().url().describe("Full URL of the endpoint to call"),
            method: z.enum(["GET", "POST"]).default("GET").describe("HTTP method"),
            body: z.record(z.string(), z.unknown()).optional().describe("JSON body, for POST"),
            headers: z.record(z.string(), z.string()).optional().describe("Extra request headers"),
            paymentHeader: z
                .string()
                .optional()
                .describe("A pre-signed x402 payment header. Sending this spends money. This server cannot create one."),
        },
        annotations: {
            readOnlyHint: false,
            openWorldHint: true,
            destructiveHint: false,
            idempotentHint: false,
        },
        async run(args, { config }) {
            return callEndpoint(args.url, {
                method: args.method ?? "GET",
                body: args.body,
                headers: args.headers,
                paymentHeader: args.paymentHeader,
                network: config.network,
                fetch: config.fetch,
            });
        },
    },
    {
        name: "ripar_post_job",
        title: "Compose a post-job transaction (unsigned)",
        description: "Compose a ValidationRegistry post_job call and return it UNSIGNED as base64 msgpack, with a " +
            "plain-language summary of what signing it would do. Nothing is submitted and no key is used " +
            "or held: a human or wallet signs and broadcasts. The spec is committed by hash so it cannot " +
            "be changed after the job is open.",
        inputShape: {
            sender: z
                .string()
                .length(58)
                .describe("Address that will sign, pay the fee, and become the job's client"),
            specHash: z
                .string()
                .describe("Hex of the 32-byte sha256 digest of the job spec. The spec stays offchain."),
            budgetMicro: z
                .number()
                .int()
                .positive()
                .describe("Budget in USDC base units — 2500000 is $2.50. The contract rejects zero."),
            validatorAgentId: z
                .number()
                .int()
                .min(0)
                .default(0)
                .describe("Registry id of the judging agent, or 0 to leave it unset"),
        },
        annotations: {
            readOnlyHint: false,
            openWorldHint: true,
            // Composing costs nothing and changes nothing; only signing does.
            destructiveHint: false,
            idempotentHint: true,
        },
        async run(args, { config }) {
            return composePostJob(config, {
                sender: args.sender,
                specHash: args.specHash,
                budgetMicro: args.budgetMicro,
                validatorAgentId: args.validatorAgentId ?? 0,
            });
        },
    },
    {
        name: "ripar_fund_job",
        title: "Compose a fund-job group (unsigned)",
        description: "Compose the transactions that move a job's budget into real escrow, and return them " +
            "UNSIGNED. This is a GROUP OF TWO and it only works as two: transaction 0 transfers the " +
            "asset to the ValidationRegistry's own app account, and transaction 1 calls " +
            "fund_job(axfer,uint64), which reads the amount off transaction 0 rather than from an " +
            "argument — so the number recorded is one the chain has already validated and cannot be " +
            "inflated by the caller. Both share a group id: sign both, in this order, and submit them " +
            "together, or the group is invalid and nothing happens. Only the job's client may fund it, " +
            "and only while the job is open or assigned; this checks all three against the chain before " +
            "composing, so an impossible funding fails here for free instead of on chain for a fee. " +
            "Funding is what turns a stated budget into money an assignee can see before doing the work. " +
            "Nothing is submitted and no key is used or held.",
        inputShape: {
            sender: z
                .string()
                .length(58)
                .describe("The job's client — the only address the contract lets fund it"),
            jobId: z.number().int().positive().describe("Job to fund, from ripar_list_jobs"),
            amountMicro: z
                .number()
                .int()
                .positive()
                .describe("Amount in the escrow asset's base units — 2500000 is $2.50 at six decimals. Added to " +
                "anything already escrowed; the contract rejects zero."),
        },
        annotations: {
            readOnlyHint: false,
            openWorldHint: true,
            // Composing costs nothing and changes nothing; only signing does.
            destructiveHint: false,
            idempotentHint: true,
        },
        async run(args, { config }) {
            return composeFundJob(config, {
                sender: args.sender,
                jobId: args.jobId,
                amountMicro: args.amountMicro,
            });
        },
    },
    {
        name: "ripar_settle_escrow",
        title: "Compose a release or refund of escrow (unsigned)",
        description: "Compose an UNSIGNED release_escrow or refund_escrow call against the ValidationRegistry, " +
            "for a job that has money held for it. " +
            "RELEASE pays the assigned agent and is legal only on a passing verdict (status 'validated'). " +
            "The client may sign it the moment the verdict lands. ANYONE may sign it once the dispute " +
            "window has passed since that verdict — that path exists because a validator who never " +
            "returns would otherwise freeze the worker's money for good, and a lock with no key is not " +
            "escrow, it is confiscation. The response reports exactly when that window closes. " +
            "REFUND returns the escrow to the client and is legal only on a failed verdict (status " +
            "'disputed') or a cancelled job. Anyone may sign it: the destination is read off the job, " +
            "not off the sender, so triggering a refund can never redirect one. " +
            "Either way the signer pays only the transaction fee — the escrow itself moves out of the " +
            "contract's own account. A job whose escrow is already 0 is refused here with the reason, " +
            "because the contract deletes the box before it sends, which is what makes paying twice " +
            "impossible. Nothing is submitted and no key is used or held.",
        inputShape: {
            sender: z.string().length(58).describe("Address that will sign and pay the fee"),
            jobId: z.number().int().positive().describe("Job whose escrow should move"),
            action: z
                .enum(["release", "refund"])
                .describe("release pays the assignee on a passing verdict; refund returns it to the client on a " +
                "failed verdict or a cancelled job. The job's current status decides which one the " +
                "contract will accept."),
        },
        annotations: {
            readOnlyHint: false,
            openWorldHint: true,
            destructiveHint: false,
            idempotentHint: true,
        },
        async run(args, { config }) {
            return args.action === "refund"
                ? composeRefundEscrow(config, { sender: args.sender, jobId: args.jobId })
                : composeReleaseEscrow(config, { sender: args.sender, jobId: args.jobId });
        },
    },
    {
        name: "ripar_list_bids",
        title: "Read every bid on a job",
        description: "Read every `bd_` box for one job off the ValidationRegistry and decode it: the bidding " +
            "agent, the price they will do it for, a hash of their pitch, and when it was placed. " +
            "Cheapest first. " +
            "THE PITCH TEXT IS NOT ON CHAIN — only a 32-byte commitment to it — so a bid tells you a " +
            "price and proves nothing about the words behind it until the bidder shows you text that " +
            "hashes to the same digest. " +
            "LOSING BIDS ARE KEPT DELIBERATELY. accept_bid does not sweep the boxes it rejected, because " +
            "a board that erases what it turned down cannot be checked afterwards — 'we took the " +
            "cheapest' should be verifiable against the ones that lost. So a bid appearing here does not " +
            "mean it is still live: check the job's status. Only bids on an OPEN job can be accepted. " +
            `Bidding is live on ValidationRegistry ${LIVE.validation}: accept_bid is in its approval program. Against an older registry ` +
            "that predates place_bid this returns an empty list and says why, rather than letting " +
            "'no bids' read as 'nobody bid'. Either way it is a real read of a real chain, not a stub.",
        inputShape: {
            jobId: z.number().int().positive().describe("The job whose bids you want"),
            limit: z.number().int().min(1).max(100).default(50).describe("Maximum bids to return"),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
        async run(args, { registry, config }) {
            const appId = config.appIds.validation;
            // Read the chain for whether bidding exists here, rather than trusting a
            // constant — a caller pointed at a newer registry gets the truth about
            // THAT one.
            const [job, bids, biddingLive] = await Promise.all([
                registry.getJob(args.jobId),
                registry.listBids(args.jobId, args.limit ?? 50).catch(() => []),
                isMethodDeployed(config, appId, CONTRACT_METHODS.place_bid.signature).catch(() => false),
            ]);
            if (!job)
                return { found: false, reason: `no job ${args.jobId} in the registry` };
            const decorated = bids.map((b) => ({
                ...b,
                priceUsdc: microToUsdc(b.priceMicro),
                placedAtIso: b.placedAt > 0 ? new Date(b.placedAt * 1000).toISOString() : null,
                // The client can still accept only while the job is OPEN; every other
                // status makes a listed bid history rather than an offer.
                stillAcceptable: job.status === "open",
                undercutsBudget: b.priceMicro < job.budgetMicro,
            }));
            return {
                network: config.network,
                validationApp: appId,
                job: {
                    jobId: job.jobId,
                    status: job.status,
                    client: job.client,
                    budgetMicro: job.budgetMicro,
                    budgetUsdc: microToUsdc(job.budgetMicro),
                    serverAgentId: job.serverAgentId,
                },
                biddingDeployed: biddingLive,
                count: decorated.length,
                bids: decorated,
                notes: [
                    biddingLive
                        ? "place_bid is routed by this app's approval program, so bids are real here."
                        : `place_bid is NOT in app ${appId}'s approval program. Bidding exists in ` +
                            `ripar-contracts/contracts/validation_registry.py but this registry predates it, so no bd_ ` +
                            `box exists or can exist on it and an empty list is the only honest answer. Jobs get ` +
                            `assigned here by the client naming an agent directly.`,
                    "Losing bids are NOT swept when one is accepted — that is deliberate, so the choice stays checkable.",
                    "The pitch text is off chain. Ask the bidder for it and check it hashes to pitchHash before you rely on it.",
                    job.status === "open"
                        ? "This job is open, so any bid here can still be accepted."
                        : `This job is ${job.status}, so these are a record of what was offered, not live offers.`,
                ],
            };
        },
    },
    {
        name: "ripar_agent_health",
        title: "Check an agent is alive and is who the registry says",
        description: "The check to run before paying a stranger. Fetches the agent's real /.well-known/agent.json " +
            "and its /health endpoint over HTTP, then answers four things the chain cannot: is anything " +
            "actually running there; does the card's x402 payTo match the address the IdentityRegistry " +
            "holds; does the agent id the card claims resolve back to this same domain; and does its " +
            "priced endpoint really answer 402 to an unpaid request. " +
            "Every finding comes from a request that was actually made — there are no fixtures and no " +
            "cached verdicts. AN UNREACHABLE AGENT IS REPORTED AS UNREACHABLE, never as a pass and never " +
            "as agreement: `verdict` distinguishes healthy, degraded (up, nothing wrong, something " +
            "unverifiable), failing (it answered and was WRONG), and unreachable (nothing answered, so " +
            "nothing was checked). A payTo or agent-id mismatch is the failure that costs money — it is " +
            "what a copied card with the payee swapped looks like — and the report says so in words.",
        inputShape: {
            agentId: z.number().int().positive().optional().describe("Registry id of the agent"),
            domain: z.string().min(1).optional().describe("Its registered domain, if you have no id"),
            address: z.string().length(58).optional().describe("Its Algorand address, if you have no id"),
            timeoutMs: z
                .number()
                .int()
                .min(1000)
                .max(30000)
                .default(10000)
                .describe("Per-request timeout. A slow agent is not a healthy one, but it is not a liar either."),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
        async run(args, { registry, config }) {
            return agentHealth(config, { agentId: args.agentId, domain: args.domain, address: args.address }, { registry, timeoutMs: args.timeoutMs ?? 10_000 });
        },
    },
    {
        name: "ripar_place_bid",
        title: "Compose a bid on a job (unsigned)",
        description: "Compose a ValidationRegistry place_bid call and return it UNSIGNED. You give the pitch as " +
            "TEXT and it is hashed here; only the 32-byte digest goes on chain and THE TEXT STAYS OFF " +
            "CHAIN. That is deliberate — a bid board holding prose would put every agent's sales copy " +
            "into permanent paid box storage and still could not prove the client read the pitch that was " +
            "bid under, whereas a hash proves exactly that for 32 bytes. Keep the text: nothing, including " +
            "this tool, can recover it from the registry, and a commitment you cannot open commits you to " +
            "nothing. " +
            "Only the bidding agent's own address may bid, only while the job is OPEN, and a second bid " +
            "from the same agent REPLACES the first — all three are checked against the chain here so an " +
            "impossible bid fails for free instead of for a fee. " +
            `place_bid is NOT in the approval program of the live ValidationRegistry ${LIVE.validation} — the deployed generation predates it, so a compose here is refused rather than submitted. This tool reads that app's ` +
            "approval program before composing anything, so a config pointed at an older generation gets " +
            "an explanation instead of a transaction its router cannot dispatch. Nothing is submitted " +
            "and no key is used or held.",
        inputShape: {
            sender: z
                .string()
                .length(58)
                .describe("The bidding agent's own controlling address — the contract accepts no other"),
            jobId: z.number().int().positive().describe("The job being bid on. It must still be open."),
            bidderAgentId: z.number().int().positive().describe("Your registry id"),
            priceMicro: z
                .number()
                .int()
                .positive()
                .describe("What you will do it for, in USDC base units — 400000 is $0.40"),
            pitch: z
                .string()
                .min(1)
                .optional()
                .describe("Your pitch, as text. Hashed here and never transmitted. Give this OR pitchHash."),
            pitchHash: z
                .string()
                .optional()
                .describe("Hex of a 32-byte sha256 digest you made yourself. Give this OR pitch, not both."),
        },
        annotations: {
            readOnlyHint: false,
            openWorldHint: true,
            destructiveHint: false,
            idempotentHint: true,
        },
        async run(args, { config }) {
            return composePlaceBid(config, {
                sender: args.sender,
                jobId: args.jobId,
                bidderAgentId: args.bidderAgentId,
                priceMicro: args.priceMicro,
                pitch: args.pitch,
                pitchHash: args.pitchHash,
            });
        },
    },
    {
        name: "ripar_accept_bid",
        title: "Compose an accept-bid transaction (unsigned)",
        description: "Compose a ValidationRegistry accept_bid call and return it UNSIGNED. " +
            "ACCEPTING A BID REWRITES THE JOB'S BUDGET TO THE BID PRICE. That is the single most " +
            "important thing about this call: a job posted at 1.0 USDC and accepted at a bid of 0.4 reads " +
            "0.4 afterwards, and everything downstream — escrow, release, what the assignee is owed — uses " +
            "the new number. The contract does it that way on purpose, because leaving the old figure " +
            "would let the job, the escrow and any release disagree about what was actually agreed. The " +
            "response states the before and after explicitly so you sign knowing which number survives. " +
            "It also assigns the job in the same call: there is no separate assign step and no window " +
            "where the job is assigned at the old price. Losing bids are not swept and stay readable. " +
            "Client-only and open-jobs-only, both checked against the chain first. " +
            `accept_bid IS live on ValidationRegistry ${LIVE.validation}, as accept_bid(uint64,uint64)bool. This still reads that app's ` +
            "approval program first, so an older registry gets a clear refusal rather than a call its " +
            "router cannot dispatch. Nothing is submitted and no key is used or held.",
        inputShape: {
            sender: z.string().length(58).describe("The job's client — the only address that may accept"),
            jobId: z.number().int().positive().describe("The job whose bid you are accepting"),
            bidderAgentId: z
                .number()
                .int()
                .positive()
                .describe("Registry id of the agent whose bid you are taking, from ripar_list_bids"),
        },
        annotations: {
            readOnlyHint: false,
            openWorldHint: true,
            destructiveHint: false,
            idempotentHint: true,
        },
        async run(args, { config }) {
            return composeAcceptBid(config, {
                sender: args.sender,
                jobId: args.jobId,
                bidderAgentId: args.bidderAgentId,
            });
        },
    },
    {
        name: "ripar_rotate_address",
        title: "Compose a key rotation for an agent (unsigned)",
        description: "Compose an IdentityRegistry rotate_address call and return it UNSIGNED. This is the recovery " +
            "path for a compromised or lost key, and it matters because without it a bad key is TERMINAL: " +
            "new_agent allows one identity per address, so the owner can neither re-register nor reclaim, " +
            "and the agent id — with every reputation score and job that references it — stays bound to a " +
            "key somebody else may hold. An identity you cannot move is an identity you cannot secure. " +
            "THE OLD ADDRESS STOPS RESOLVING. The reverse index moves with the identity: the `ad_` box for " +
            "the old key is deleted, so from the moment this confirms, a caller running the obvious check " +
            "— does the payee match the registry — gets a MISS on the old address. That is the entire " +
            "point; if the old key kept resolving, the rotation would have secured nothing. " +
            "The id, the domain and the reputation are preserved and follow the identity. " +
            "Only the CURRENT address may sign, so this is a race: it rescues a key you fear is exposed " +
            "and is useless against one already in use against you — whoever holds it can rotate first. " +
            `rotate_address IS live on IdentityRegistry ${LIVE.identity}, as rotate_address(uint64,address)bool. This still reads that ` +
            "app's approval program before composing, so an older registry gets a refusal naming what it " +
            "does offer instead. Nothing is submitted and no key is used or held.",
        inputShape: {
            sender: z
                .string()
                .length(58)
                .describe("The agent's CURRENT controlling address — the only key the contract accepts"),
            agentId: z.number().int().positive().describe("The agent being moved"),
            newAddress: z
                .string()
                .length(58)
                .describe("The address taking control. It must not already control an agent."),
        },
        annotations: {
            readOnlyHint: false,
            openWorldHint: true,
            destructiveHint: false,
            idempotentHint: true,
        },
        async run(args, { config }) {
            return composeRotateAddress(config, {
                sender: args.sender,
                agentId: args.agentId,
                newAddress: args.newAddress,
            });
        },
    },
];
export const TOOL_NAMES = TOOLS.map((t) => t.name);
export function getTool(name) {
    return TOOLS.find((t) => t.name === name);
}
/** Tool schemas as JSON Schema — what an MCP client actually sees in tools/list. */
export function toolJsonSchema(tool) {
    return z.toJSONSchema(z.object(tool.inputShape), { io: "input" });
}
/** A compact catalogue for humans and for the A2A card. */
export function toolCatalogue() {
    return TOOLS.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        readOnly: t.annotations.readOnlyHint,
        inputSchema: toolJsonSchema(t),
    }));
}
export { SKILLS, skillPriceUsdc, skillInputJsonSchema };
