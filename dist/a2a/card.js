/**
 * A2A agent cards — building them, and parsing someone else's.
 *
 * ## How A2A and MCP compose (the "A2MCP" idea)
 *
 * They are perpendicular, and that is why they fit together:
 *
 *   - **MCP is agent-to-tool.** A client (Claude, an IDE, another agent's
 *     runtime) already knows about a server and speaks JSON-RPC to it to call
 *     tools. MCP answers "how do I *invoke* this?" It has no discovery story:
 *     someone has to put the server in a config file first.
 *
 *   - **A2A is agent-to-agent.** An agent publishes a card at a well-known URL
 *     describing who it is and what it can do. A2A answers "who is out there
 *     and what can they do?" It has no invocation story for tools: the card
 *     describes skills, not function signatures.
 *
 * Stack them and each covers the other's hole. A Ripar card carries an MCP
 * extension (`RIPAR_EXT.mcp`) that names the exact MCP server the agent
 * exposes, its transport, and the tool names on it. So the sequence is:
 *
 *     fetch https://them.example/.well-known/agent.json   <- A2A discovery
 *       -> read capabilities.extensions[".../mcp/v1"]     <- what tools exist
 *       -> connect to that MCP server                     <- MCP invocation
 *       -> call the tool                                  <- work happens
 *
 * Discovery and invocation end up **one hop apart**: an agent that has never
 * heard of another agent can go from a bare domain to a live tool call without
 * a human editing a config, because the card told it what to connect to.
 *
 * The third leg is payment. The x402 extension on the card states what each
 * skill costs and where to pay, and the registry extension states which
 * on-chain agent id backs the claims — so the caller can check reputation
 * (`ripar_get_reputation`) *before* it spends. Discovery, invocation, price,
 * and track record all come off one document.
 *
 * ## Spec notes, honestly
 *
 * The current A2A spec puts the card at `/.well-known/agent-card.json` (RFC
 * 8615) and models transports as `supportedInterfaces[]`. The older, widely
 * deployed shape used `/.well-known/agent.json` with flat `url` +
 * `preferredTransport` + `protocolVersion`. This module WRITES both — the same
 * document satisfies either reader — and PARSES both, normalising to one
 * internal shape. Extension data rides in `capabilities.extensions[]`, which is
 * the spec's own escape hatch, rather than in invented top-level fields.
 */
import { z } from "zod";
/** Both paths a card can live at. Serve both; fetch both. */
export const WELL_KNOWN_PATHS = ["/.well-known/agent.json", "/.well-known/agent-card.json"];
/** The legacy path, which is still the one most deployed clients ask for first. */
export const WELL_KNOWN_PATH = "/.well-known/agent.json";
/** The path the current spec registers. */
export const WELL_KNOWN_PATH_CURRENT = "/.well-known/agent-card.json";
/** Extension URIs Ripar defines. Namespaced, versioned, and inert to other readers. */
export const RIPAR_EXT = {
    /** What each skill costs and where the money goes. */
    x402: "https://ripar.io/a2a/ext/x402/v1",
    /** Which on-chain identity backs this card. */
    registry: "https://ripar.io/a2a/ext/registry/v1",
    /** The MCP server this agent exposes — the A2MCP hop. */
    mcp: "https://ripar.io/a2a/ext/mcp/v1",
};
export const A2A_PROTOCOL_VERSION = "1.0";
// ---------------------------------------------------------------------------
// Schemas. Required fields are required — a card missing `skills` is not a
// card, and parsing it as one would let an agent "discover" a peer that cannot
// actually do anything.
// ---------------------------------------------------------------------------
export const AgentSkillSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    tags: z.array(z.string()),
    examples: z.array(z.string()).optional(),
    inputModes: z.array(z.string()).optional(),
    outputModes: z.array(z.string()).optional(),
});
export const AgentExtensionSchema = z.object({
    uri: z.string().min(1),
    description: z.string().optional(),
    required: z.boolean().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
});
export const AgentCapabilitiesSchema = z.object({
    streaming: z.boolean().optional(),
    pushNotifications: z.boolean().optional(),
    extendedAgentCard: z.boolean().optional(),
    extensions: z.array(AgentExtensionSchema).optional(),
});
export const AgentInterfaceSchema = z.object({
    url: z.string().min(1),
    /** `JSONRPC` | `GRPC` | `HTTP+JSON` are the core bindings; the field is open. */
    protocolBinding: z.string().min(1),
    protocolVersion: z.string().min(1),
    tenant: z.string().optional(),
});
export const AgentProviderSchema = z.object({
    organization: z.string().min(1),
    url: z.string().min(1),
});
/**
 * Accepts either card generation. `supportedInterfaces` (1.0) and the flat
 * `url`/`preferredTransport` pair (0.3) are each optional *here* so that a card
 * carrying only one of them parses; `parseAgentCard` then enforces that at
 * least one is present, which is the real requirement.
 */
export const AgentCardSchema = z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    version: z.string().min(1),
    skills: z.array(AgentSkillSchema),
    capabilities: AgentCapabilitiesSchema.optional(),
    supportedInterfaces: z.array(AgentInterfaceSchema).optional(),
    url: z.string().optional(),
    preferredTransport: z.string().optional(),
    protocolVersion: z.string().optional(),
    provider: AgentProviderSchema.optional(),
    documentationUrl: z.string().optional(),
    iconUrl: z.string().optional(),
    defaultInputModes: z.array(z.string()).optional(),
    defaultOutputModes: z.array(z.string()).optional(),
    signatures: z.array(z.record(z.string(), z.unknown())).optional(),
});
export class AgentCardError extends Error {
    issues;
    constructor(message, issues = []) {
        super(issues.length ? `${message}: ${issues.join("; ")}` : message);
        this.issues = issues;
        this.name = "AgentCardError";
    }
}
function extensionParams(card, uri) {
    const ext = card.capabilities?.extensions?.find((e) => e.uri === uri);
    return ext?.params ?? null;
}
/**
 * Validate and normalise a card that came from somewhere else.
 *
 * Throws `AgentCardError` on anything structurally wrong. Things that are
 * merely suspicious — no on-chain identity, prices with no payee, an http://
 * endpoint — come back in `warnings`, because the caller, not this function,
 * decides how much risk it is willing to take.
 */
export function parseAgentCard(input, source) {
    if (typeof input !== "object" || input === null) {
        throw new AgentCardError("Agent card must be a JSON object");
    }
    const result = AgentCardSchema.safeParse(input);
    if (!result.success) {
        throw new AgentCardError("Invalid agent card", result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
    }
    const card = result.data;
    const warnings = [];
    // Fold the 0.3 flat transport fields into the 1.0 list so downstream code
    // only ever deals with one shape.
    const interfaces = [...(card.supportedInterfaces ?? [])];
    if (card.url) {
        const alreadyListed = interfaces.some((i) => i.url === card.url);
        if (!alreadyListed) {
            interfaces.push({
                url: card.url,
                protocolBinding: card.preferredTransport ?? "JSONRPC",
                protocolVersion: card.protocolVersion ?? A2A_PROTOCOL_VERSION,
            });
        }
    }
    if (interfaces.length === 0) {
        throw new AgentCardError("Invalid agent card", ["the card names no endpoint: expected supportedInterfaces[] or a top-level url"]);
    }
    const endpoint = interfaces[0]?.url ?? null;
    if (endpoint && endpoint.startsWith("http://")) {
        warnings.push(`endpoint ${endpoint} is plaintext http; A2A expects https in production`);
    }
    if (card.skills.length === 0) {
        warnings.push("the card advertises no skills, so there is nothing to invoke");
    }
    const duplicateSkillIds = card.skills
        .map((s) => s.id)
        .filter((id, i, all) => all.indexOf(id) !== i);
    if (duplicateSkillIds.length) {
        warnings.push(`duplicate skill ids: ${[...new Set(duplicateSkillIds)].join(", ")}`);
    }
    // --- x402 pricing extension
    let x402 = null;
    const x402Params = extensionParams(card, RIPAR_EXT.x402);
    if (x402Params) {
        const asset = (x402Params.asset ?? {});
        x402 = {
            network: String(x402Params.network ?? ""),
            asset: {
                id: Number(asset.id ?? 0),
                symbol: String(asset.symbol ?? "USDC"),
                decimals: Number(asset.decimals ?? 6),
            },
            payTo: String(x402Params.payTo ?? ""),
            facilitator: x402Params.facilitator ? String(x402Params.facilitator) : undefined,
            prices: (x402Params.prices ?? {}),
        };
        if (!x402.payTo)
            warnings.push("x402 extension quotes prices but names no payTo account");
        const priced = Object.keys(x402.prices);
        const unknownSkill = priced.filter((id) => !card.skills.some((s) => s.id === id));
        if (unknownSkill.length) {
            warnings.push(`x402 prices reference skills the card does not list: ${unknownSkill.join(", ")}`);
        }
    }
    // --- registry binding extension
    let registry = null;
    const regParams = extensionParams(card, RIPAR_EXT.registry);
    if (regParams) {
        registry = {
            chain: String(regParams.chain ?? ""),
            agentId: Number(regParams.agentId ?? 0),
            identityApp: regParams.identityApp !== undefined ? Number(regParams.identityApp) : undefined,
            reputationApp: regParams.reputationApp !== undefined ? Number(regParams.reputationApp) : undefined,
            validationApp: regParams.validationApp !== undefined ? Number(regParams.validationApp) : undefined,
        };
        if (!registry.agentId) {
            warnings.push("registry extension present but agentId is 0, so nothing on chain backs it");
        }
    }
    else {
        warnings.push("no registry extension: this card's claims are unverifiable, since no on-chain agent id backs them");
    }
    // --- MCP binding extension (the A2MCP hop)
    let mcp = null;
    const mcpParams = extensionParams(card, RIPAR_EXT.mcp);
    if (mcpParams) {
        const transport = String(mcpParams.transport ?? "stdio");
        mcp = {
            transport: transport === "http" || transport === "sse" ? transport : "stdio",
            command: mcpParams.command ? String(mcpParams.command) : undefined,
            args: Array.isArray(mcpParams.args) ? mcpParams.args.map(String) : undefined,
            url: mcpParams.url ? String(mcpParams.url) : undefined,
            tools: Array.isArray(mcpParams.tools) ? mcpParams.tools.map(String) : [],
        };
        if (mcp.transport !== "stdio" && !mcp.url) {
            warnings.push(`mcp extension declares ${mcp.transport} transport but gives no url`);
        }
        if (mcp.tools.length === 0) {
            warnings.push("mcp extension names no tools, so discovery cannot lead to a call");
        }
    }
    return { card, source, interfaces, endpoint, skills: card.skills, x402, registry, mcp, warnings };
}
/**
 * Build a card that satisfies both card generations at once: the 1.0
 * `supportedInterfaces` list AND the 0.3 flat `url`/`preferredTransport`/
 * `protocolVersion` fields, pointing at the same endpoint. Older clients read
 * the flat fields, newer ones read the list, and neither has to be told which
 * version it is looking at.
 */
export function buildAgentCard(input) {
    const endpoint = input.a2aUrl ?? `${input.url.replace(/\/$/, "")}/a2a`;
    const extensions = [];
    if (input.x402) {
        extensions.push({
            uri: RIPAR_EXT.x402,
            description: "Per-skill pricing settled over x402. Amounts are base units of `asset`; a caller pays by " +
                "signing the transfer named in the endpoint's 402 challenge.",
            required: false,
            params: input.x402,
        });
    }
    if (input.registry) {
        extensions.push({
            uri: RIPAR_EXT.registry,
            description: "The on-chain identity behind this card. Resolve `agentId` in the IdentityRegistry to check " +
                "that the domain matches, and read its reputation before paying.",
            required: false,
            params: input.registry,
        });
    }
    if (input.mcp) {
        extensions.push({
            uri: RIPAR_EXT.mcp,
            description: "The MCP server this agent exposes. This is the A2MCP hop: a peer that discovers this card " +
                "learns exactly which MCP server to connect to and which tools it will find there, so " +
                "discovery and invocation are one step apart.",
            required: false,
            params: input.mcp,
        });
    }
    const card = {
        name: input.name,
        description: input.description,
        version: input.version ?? "0.1.0",
        // --- A2A 1.0
        supportedInterfaces: [
            { url: endpoint, protocolBinding: "JSONRPC", protocolVersion: A2A_PROTOCOL_VERSION },
        ],
        // --- A2A 0.3, same endpoint, for clients that only read these
        url: endpoint,
        preferredTransport: "JSONRPC",
        protocolVersion: A2A_PROTOCOL_VERSION,
        capabilities: {
            streaming: input.capabilities?.streaming ?? false,
            pushNotifications: input.capabilities?.pushNotifications ?? false,
            extensions,
        },
        defaultInputModes: input.defaultInputModes ?? ["application/json", "text/plain"],
        defaultOutputModes: input.defaultOutputModes ?? ["application/json", "text/plain"],
        skills: input.skills,
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.documentationUrl ? { documentationUrl: input.documentationUrl } : {}),
        ...(input.iconUrl ? { iconUrl: input.iconUrl } : {}),
    };
    // Emitting something we would reject on the way in is how drift starts.
    parseAgentCard(card);
    return card;
}
