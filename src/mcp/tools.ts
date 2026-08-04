/**
 * The ten tools, defined as data.
 *
 * Keeping the specs in a plain array — rather than inline in `registerTool`
 * calls — means the schemas can be asserted on directly, an A2A card can list
 * the tool names without starting a server, and a bad tool definition fails a
 * test instead of failing silently in a client that just... doesn't show it.
 *
 * The read/write split is the important thing here. Six tools read the chain
 * and are marked `readOnlyHint`. Three compose a transaction and return it
 * UNSIGNED. One (`ripar_call_endpoint`) can spend money, but only with a
 * payment header the caller supplies, because this process has no key. A client
 * is entitled to show a confirmation prompt for those last four and nothing
 * else, and the annotations say so honestly.
 */

import { z } from "zod";
import { microToUsdc, type RiparRegistry } from "../registry.js";
import type { RiparConfig } from "../config.js";
import {
  composeFundJob,
  composePostJob,
  composeRefundEscrow,
  composeReleaseEscrow,
} from "../unsigned.js";
import { callEndpoint, quoteEndpoint } from "../x402.js";
import { SKILLS, skillPriceUsdc, skillInputJsonSchema } from "../skills.js";
import { JOB_STATUS } from "../config.js";

export type ToolContext = {
  registry: RiparRegistry;
  config: RiparConfig;
};

export type RiparToolSpec = {
  name: string;
  title: string;
  description: string;
  inputShape: z.ZodRawShape;
  annotations: {
    readOnlyHint: boolean;
    /** True when the tool touches the world outside this process. All of them do. */
    openWorldHint: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
  run: (args: Record<string, any>, ctx: ToolContext) => Promise<unknown>;
};

const jobStatusValues = Object.values(JOB_STATUS) as [string, ...string[]];

export const TOOLS: RiparToolSpec[] = [
  // ------------------------------------------------------------------ reads
  {
    name: "ripar_search_agents",
    title: "Search Ripar agents",
    description:
      "List or search agents in the on-chain IdentityRegistry (Algorand TestNet app 768572968). " +
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
        ? await Promise.all(
            agents.map(async (a) => ({
              ...a,
              score: await registry.getScore(a.agentId).catch(() => null),
            }))
          )
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
    description:
      "Fetch a single agent record from the IdentityRegistry by id, domain, or Algorand address. " +
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
      const base = (await SKILLS.find((s) => s.id === "ripar.identity.resolve")!.run(
        { agentId: args.agentId, domain: args.domain, address: args.address },
        ctx
      )) as { found: boolean; agent?: { agentId: number } };

      if (!base.found || !base.agent) return base;

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
    description:
      "Read an agent's score from the ReputationRegistry (Algorand TestNet app 768572969): payments " +
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
      return SKILLS.find((s) => s.id === "ripar.reputation.report")!.run(
        { agentId: args.agentId },
        ctx
      );
    },
  },

  {
    name: "ripar_list_jobs",
    title: "List validated jobs, with what is actually escrowed",
    description:
      "List jobs on the ValidationRegistry (Algorand TestNet app 768572979), newest first, " +
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
        note:
          "budget is what the client says the work is worth; escrow is what the contract actually holds. " +
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
    description:
      "List real USDC transfers for an agent from the Algorand indexer, alongside the score the " +
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
      return SKILLS.find((s) => s.id === "ripar.settlement.audit")!.run(
        { agentId: args.agentId, address: args.address, limit: args.limit ?? 25 },
        ctx
      );
    },
  },

  {
    name: "ripar_quote_endpoint",
    title: "Quote an x402 endpoint",
    description:
      "Ask a paid endpoint what it charges, without paying. Makes the request, reads the HTTP 402 " +
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
    description:
      "Call an endpoint and return its response. If it answers 402, you get the payment challenge " +
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
        .describe(
          "A pre-signed x402 payment header. Sending this spends money. This server cannot create one."
        ),
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
    description:
      "Compose a ValidationRegistry post_job call and return it UNSIGNED as base64 msgpack, with a " +
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
    description:
      "Compose the transactions that move a job's budget into real escrow, and return them " +
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
        .describe(
          "Amount in the escrow asset's base units — 2500000 is $2.50 at six decimals. Added to " +
            "anything already escrowed; the contract rejects zero."
        ),
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
    description:
      "Compose an UNSIGNED release_escrow or refund_escrow call against the ValidationRegistry, " +
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
        .describe(
          "release pays the assignee on a passing verdict; refund returns it to the client on a " +
            "failed verdict or a cancelled job. The job's current status decides which one the " +
            "contract will accept."
        ),
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
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);

export function getTool(name: string): RiparToolSpec | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** Tool schemas as JSON Schema — what an MCP client actually sees in tools/list. */
export function toolJsonSchema(tool: RiparToolSpec): Record<string, unknown> {
  return z.toJSONSchema(z.object(tool.inputShape), { io: "input" }) as Record<string, unknown>;
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
