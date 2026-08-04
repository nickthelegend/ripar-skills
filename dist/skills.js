/**
 * Skills.
 *
 * A skill is the smallest unit an agent can advertise and be paid for: a stable
 * id, a description another model can route on, an input schema, and a price.
 * Nothing else. That triple is exactly what the two protocols each need —
 * A2A publishes the id/description/tags on the card so a peer can find it, MCP
 * publishes the input schema so a client can call it, and x402 publishes the
 * price so the caller knows what it will cost before it commits.
 *
 * The four here are real. Each one is answered by reading boxes out of the
 * registries that are live on Algorand TestNet, or by composing a transaction
 * against them. None of them returns a canned response.
 *
 * Prices are in USDC base units (6 decimals), so 10_000 = $0.01. Reads that
 * cost nothing to serve are priced at 0 rather than given a token price —
 * charging for a public box read would be theatre.
 */
import { z } from "zod";
import { microToUsdc } from "./registry.js";
import { USDC_ASSET_ID, USDC_DECIMALS } from "./config.js";
import { composePostJob } from "./unsigned.js";
// ---------------------------------------------------------------------------
// 1. Resolve an agent — IdentityRegistry
// ---------------------------------------------------------------------------
const resolveInput = z
    .object({
    agentId: z.number().int().positive().optional().describe("Registry id, if you already have it"),
    domain: z.string().min(1).optional().describe("Exact domain, e.g. agent-123.ripar.io"),
    address: z.string().length(58).optional().describe("Algorand address, 58 characters"),
})
    .describe("Give exactly one of agentId, domain, or address");
export const resolveAgentSkill = {
    id: "ripar.identity.resolve",
    name: "Resolve an agent",
    description: "Look up one agent in the on-chain IdentityRegistry by id, domain, or Algorand address, and " +
        "return its record: domain, controlling address, and when it was registered or last changed. " +
        "This is the check that tells you whether a domain claiming to be an agent actually is one.",
    tags: ["identity", "registry", "algorand", "discovery"],
    examples: [
        "Is agent-1785821796525.ripar.io a registered Ripar agent?",
        "Which address controls agent 1?",
    ],
    input: resolveInput,
    priceMicro: 0,
    async run(input, { registry, config }) {
        const given = [input.agentId, input.domain, input.address].filter((v) => v !== undefined);
        if (given.length !== 1) {
            throw new Error("Give exactly one of agentId, domain, or address");
        }
        let agentId = input.agentId ?? 0;
        let resolvedVia = "id";
        if (input.domain !== undefined) {
            agentId = await registry.resolveByDomain(input.domain);
            resolvedVia = "domain";
        }
        else if (input.address !== undefined) {
            agentId = await registry.resolveByAddress(input.address);
            resolvedVia = "address";
        }
        if (!agentId) {
            return {
                found: false,
                resolvedVia,
                // The contract's own sentinel. Saying so beats an empty object.
                reason: "the registry returned 0, which is its value for 'no such agent'",
            };
        }
        const agent = await registry.getAgent(agentId);
        if (!agent) {
            return {
                found: false,
                resolvedVia,
                reason: `index pointed at agent ${agentId} but its record box is missing`,
            };
        }
        return {
            found: true,
            resolvedVia,
            agent,
            registeredAtIso: new Date(agent.registeredAt * 1000).toISOString(),
            updatedAtIso: new Date(agent.updatedAt * 1000).toISOString(),
            cardUrl: `https://${agent.domain}/.well-known/agent.json`,
            explorer: `${config.explorer}/address/${agent.address}`,
        };
    },
};
// ---------------------------------------------------------------------------
// 2. Reputation report — ReputationRegistry
// ---------------------------------------------------------------------------
const reputationInput = z.object({
    agentId: z.number().int().positive().describe("The agent whose record you want"),
});
export const reputationReportSkill = {
    id: "ripar.reputation.report",
    name: "Reputation report",
    description: "Read an agent's on-chain score: payments credited to it, total USDC, and how many results a " +
        "validator passed or disputed. Nothing here is a star rating. A credit requires the settling " +
        "USDC transfer to be a transaction in the same atomic group, going FROM the client's " +
        "registered address TO the server's — both resolved through the IdentityRegistry — so the " +
        "amount is read off a transfer the AVM has already validated and cannot be fabricated. " +
        "Use ripar.settlement.audit to cross-check the score against the indexer.",
    tags: ["reputation", "registry", "trust", "algorand"],
    examples: ["What is agent 1's track record?", "Has anyone actually paid this agent?"],
    input: reputationInput,
    priceMicro: 10_000,
    async run({ agentId }, { registry }) {
        const [agent, score] = await Promise.all([
            registry.getAgent(agentId),
            registry.getScore(agentId),
        ]);
        if (!agent)
            return { found: false, reason: `agent ${agentId} is not registered` };
        if (!score) {
            return {
                found: true,
                agent,
                score: null,
                // No box is meaningfully different from a box of zeros: it means the
                // agent has never been paid at all, not that it was paid and scored 0.
                summary: `agent ${agentId} has no score box yet, so it has never been paid through Ripar`,
            };
        }
        const disputeRate = score.validated + score.disputed > 0
            ? score.disputed / (score.validated + score.disputed)
            : null;
        return {
            found: true,
            agent,
            score,
            volumeUsdc: microToUsdc(score.volumeMicro),
            averagePaymentUsdc: score.jobsPaid > 0 ? microToUsdc(Math.round(score.volumeMicro / score.jobsPaid)) : null,
            firstPaidIso: score.firstAt ? new Date(score.firstAt * 1000).toISOString() : null,
            lastPaidIso: score.lastAt ? new Date(score.lastAt * 1000).toISOString() : null,
            validation: {
                validated: score.validated,
                disputed: score.disputed,
                disputeRate,
                note: score.validated + score.disputed === 0
                    ? "no validator has judged this agent's work yet, so the payment count is the only signal"
                    : undefined,
            },
            summary: `agent ${agentId} has been paid ${score.jobsPaid} time(s) totalling ` +
                `${microToUsdc(score.volumeMicro)} USDC`,
        };
    },
};
// ---------------------------------------------------------------------------
// 3. Settlement audit — ReputationRegistry + indexer
// ---------------------------------------------------------------------------
const settlementInput = z.object({
    agentId: z.number().int().positive().optional().describe("Agent to audit"),
    address: z.string().length(58).optional().describe("Algorand address, if you have no agent id"),
    limit: z.number().int().min(1).max(100).default(25).describe("How many transfers to look at"),
});
export const settlementAuditSkill = {
    id: "ripar.settlement.audit",
    name: "Settlement audit",
    description: "Read an agent's real USDC transfers from the Algorand indexer and report them next to the " +
        "score the ReputationRegistry actually holds, so a claimed track record can be checked against " +
        "money that demonstrably moved. No transfer carries an 'already credited' flag, because the " +
        "chain records none; what this adds is which inbound transfers accept_feedback could still be " +
        "called for, and which can never be (a zero-amount or self-sent one).",
    tags: ["x402", "settlement", "reputation", "audit"],
    examples: [
        "Which of agent 1's payments could be credited to its score?",
        "How much USDC has this agent actually received?",
    ],
    input: settlementInput,
    priceMicro: 20_000,
    async run(input, { registry }) {
        const result = await registry.settlements({
            agentId: input.agentId,
            address: input.address,
            limit: input.limit,
        });
        // Inbound transfers the contract COULD credit. accept_feedback asserts the
        // amount is above zero and that the two agent ids differ, so a zero-amount
        // ASA opt-in — an inbound transfer from yourself, and the first thing in
        // every agent's history — can never be credited. Listing it as a reputation
        // gap produced a next step impossible to follow.
        //
        // What this can no longer say is WHICH of the eligible ones were already
        // credited. The registry used to keep a `pd_` box per counted payment and
        // this filtered on it; that ledger is gone, because keying it on the txid
        // was circular and unnecessary — the payment is a transaction in the same
        // group, and consensus rejects a duplicate txid.
        //
        // So `score` is the chain's record of credited work and `creditable` is
        // what a caller could still submit. They overlap; they are not
        // complementary. Leaving the old filter in place would have reported every
        // payment as uncredited — a lie in the shape of an answer.
        const inbound = result.transfers.filter((t) => t.direction === "in");
        const eligible = inbound.filter((t) => t.amountMicro > 0 && t.counterparty !== result.address);
        const ineligible = inbound.filter((t) => t.amountMicro === 0 || t.counterparty === result.address);
        return {
            ...result,
            creditable: {
                count: eligible.length,
                totalUsdc: microToUsdc(eligible.reduce((s, t) => s + t.amountMicro, 0)),
                txIds: eligible.map((t) => t.txId),
                // The CURRENT signature. accept_feedback takes the settling transfer as
                // a transaction in the group, not a txid and an amount as arguments —
                // that change is what stopped scores being minted from bytes, and a
                // caller following the old signature is rejected outright.
                nextStep: eligible.length > 0
                    ? "group the USDC transfer with a call to accept_feedback(payment: axfer, server_agent_id, client_agent_id). The transfer must go FROM the client's registered address TO the server's, or the call is rejected."
                    : "nothing in this window is creditable",
                note: "The chain records no per-payment credit flag, so this is what COULD be credited, " +
                    "not what has not been. `score` is the record of what already was.",
            },
            ...(ineligible.length
                ? {
                    ineligible: {
                        count: ineligible.length,
                        txIds: ineligible.map((t) => t.txId),
                        reason: "zero-amount or self-sent transfers (typically the ASA opt-in). accept_feedback " +
                            "rejects both, so these are not a reputation gap.",
                    },
                }
                : {}),
        };
    },
};
// ---------------------------------------------------------------------------
// 4. Post a job — ValidationRegistry (write, returns an unsigned transaction)
// ---------------------------------------------------------------------------
const postJobInput = z.object({
    sender: z.string().length(58).describe("Address that will sign and pay — becomes the job's client"),
    specHash: z
        .string()
        .describe("Hex of the 32-byte hash committing to the job spec. The spec itself stays offchain."),
    budgetMicro: z.number().int().positive().describe("Budget in USDC base units, so 2500000 = $2.50"),
    validatorAgentId: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Registry id of the agent that will judge the result. 0 means unassigned."),
});
export const postJobSkill = {
    id: "ripar.validation.post-job",
    name: "Post a validated job",
    description: "Open a job on the ValidationRegistry, committing to the spec by hash so it cannot be changed " +
        "afterwards. Returns an UNSIGNED transaction — this skill never holds a key and cannot submit " +
        "anything. A human or a wallet signs and broadcasts it.",
    tags: ["validation", "jobs", "registry", "write"],
    examples: [
        "Post a job with a $2.50 budget for spec hash 5d6a7c...",
        "Open a validated job and let me sign it in Pera",
    ],
    input: postJobInput,
    priceMicro: 50_000,
    producesUnsignedTx: true,
    async run(input, ctx) {
        return composePostJob(ctx.config, {
            sender: input.sender,
            specHash: input.specHash,
            budgetMicro: input.budgetMicro,
            validatorAgentId: input.validatorAgentId,
        });
    },
};
// ---------------------------------------------------------------------------
export const SKILLS = [
    resolveAgentSkill,
    reputationReportSkill,
    settlementAuditSkill,
    postJobSkill,
];
export function getSkill(id) {
    return SKILLS.find((s) => s.id === id);
}
/** JSON Schema for a skill's input, as published to MCP clients and the card. */
export function skillInputJsonSchema(skill) {
    return z.toJSONSchema(skill.input, { io: "input" });
}
export function skillPriceUsdc(skill) {
    return microToUsdc(skill.priceMicro);
}
/**
 * The skill list in A2A card form.
 *
 * Price does not live on the skill object here — the A2A `AgentSkill` shape has
 * no price field, and inventing one would produce a card that a strict reader
 * rejects. It goes in the x402 extension instead, keyed by the same skill id.
 */
export function skillsAsCardSkills(skills = SKILLS) {
    return skills.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        tags: s.tags,
        examples: s.examples,
        inputModes: ["application/json"],
        outputModes: ["application/json"],
    }));
}
/** The `prices` half of the x402 card extension: skill id -> base units. */
export function skillPriceTable(skills = SKILLS) {
    return Object.fromEntries(skills.map((s) => [s.id, String(s.priceMicro)]));
}
export function skillsManifest(network = "testnet") {
    return {
        asset: { id: USDC_ASSET_ID[network], symbol: "USDC", decimals: USDC_DECIMALS },
        skills: SKILLS.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            tags: s.tags,
            priceMicro: s.priceMicro,
            priceUsdc: microToUsdc(s.priceMicro),
            producesUnsignedTx: Boolean(s.producesUnsignedTx),
            inputSchema: skillInputJsonSchema(s),
        })),
    };
}
