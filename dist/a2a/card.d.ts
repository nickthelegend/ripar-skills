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
export declare const WELL_KNOWN_PATHS: readonly ["/.well-known/agent.json", "/.well-known/agent-card.json"];
/** The legacy path, which is still the one most deployed clients ask for first. */
export declare const WELL_KNOWN_PATH = "/.well-known/agent.json";
/** The path the current spec registers. */
export declare const WELL_KNOWN_PATH_CURRENT = "/.well-known/agent-card.json";
/** Extension URIs Ripar defines. Namespaced, versioned, and inert to other readers. */
export declare const RIPAR_EXT: {
    /** What each skill costs and where the money goes. */
    readonly x402: "https://ripar.io/a2a/ext/x402/v1";
    /** Which on-chain identity backs this card. */
    readonly registry: "https://ripar.io/a2a/ext/registry/v1";
    /** The MCP server this agent exposes — the A2MCP hop. */
    readonly mcp: "https://ripar.io/a2a/ext/mcp/v1";
};
export declare const A2A_PROTOCOL_VERSION = "1.0";
export declare const AgentSkillSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    description: z.ZodString;
    tags: z.ZodArray<z.ZodString>;
    examples: z.ZodOptional<z.ZodArray<z.ZodString>>;
    inputModes: z.ZodOptional<z.ZodArray<z.ZodString>>;
    outputModes: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export declare const AgentExtensionSchema: z.ZodObject<{
    uri: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    required: z.ZodOptional<z.ZodBoolean>;
    params: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
export declare const AgentCapabilitiesSchema: z.ZodObject<{
    streaming: z.ZodOptional<z.ZodBoolean>;
    pushNotifications: z.ZodOptional<z.ZodBoolean>;
    extendedAgentCard: z.ZodOptional<z.ZodBoolean>;
    extensions: z.ZodOptional<z.ZodArray<z.ZodObject<{
        uri: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        required: z.ZodOptional<z.ZodBoolean>;
        params: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>>>;
}, z.core.$strip>;
export declare const AgentInterfaceSchema: z.ZodObject<{
    url: z.ZodString;
    protocolBinding: z.ZodString;
    protocolVersion: z.ZodString;
    tenant: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const AgentProviderSchema: z.ZodObject<{
    organization: z.ZodString;
    url: z.ZodString;
}, z.core.$strip>;
/**
 * Accepts either card generation. `supportedInterfaces` (1.0) and the flat
 * `url`/`preferredTransport` pair (0.3) are each optional *here* so that a card
 * carrying only one of them parses; `parseAgentCard` then enforces that at
 * least one is present, which is the real requirement.
 */
export declare const AgentCardSchema: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodString;
    version: z.ZodString;
    skills: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        description: z.ZodString;
        tags: z.ZodArray<z.ZodString>;
        examples: z.ZodOptional<z.ZodArray<z.ZodString>>;
        inputModes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        outputModes: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    capabilities: z.ZodOptional<z.ZodObject<{
        streaming: z.ZodOptional<z.ZodBoolean>;
        pushNotifications: z.ZodOptional<z.ZodBoolean>;
        extendedAgentCard: z.ZodOptional<z.ZodBoolean>;
        extensions: z.ZodOptional<z.ZodArray<z.ZodObject<{
            uri: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
            required: z.ZodOptional<z.ZodBoolean>;
            params: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>>>;
    }, z.core.$strip>>;
    supportedInterfaces: z.ZodOptional<z.ZodArray<z.ZodObject<{
        url: z.ZodString;
        protocolBinding: z.ZodString;
        protocolVersion: z.ZodString;
        tenant: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    url: z.ZodOptional<z.ZodString>;
    preferredTransport: z.ZodOptional<z.ZodString>;
    protocolVersion: z.ZodOptional<z.ZodString>;
    provider: z.ZodOptional<z.ZodObject<{
        organization: z.ZodString;
        url: z.ZodString;
    }, z.core.$strip>>;
    documentationUrl: z.ZodOptional<z.ZodString>;
    iconUrl: z.ZodOptional<z.ZodString>;
    defaultInputModes: z.ZodOptional<z.ZodArray<z.ZodString>>;
    defaultOutputModes: z.ZodOptional<z.ZodArray<z.ZodString>>;
    signatures: z.ZodOptional<z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
}, z.core.$strip>;
export type AgentSkillCard = z.infer<typeof AgentSkillSchema>;
export type AgentExtension = z.infer<typeof AgentExtensionSchema>;
export type AgentInterface = z.infer<typeof AgentInterfaceSchema>;
export type AgentCard = z.infer<typeof AgentCardSchema>;
export declare class AgentCardError extends Error {
    readonly issues: string[];
    constructor(message: string, issues?: string[]);
}
export type X402Pricing = {
    /** CAIP-2 network id, e.g. `algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe`. */
    network: string;
    asset: {
        id: number;
        symbol: string;
        decimals: number;
    };
    /** The account that receives payment. */
    payTo: string;
    facilitator?: string;
    /** Price per skill id, in the asset's base units. */
    prices: Record<string, string>;
};
export type RegistryBinding = {
    chain: string;
    /** The IdentityRegistry id. 0 or absent means the card makes no on-chain claim. */
    agentId: number;
    identityApp?: number;
    reputationApp?: number;
    validationApp?: number;
};
export type McpBinding = {
    transport: "stdio" | "http" | "sse";
    /** For stdio: the command a client should spawn. */
    command?: string;
    args?: string[];
    /** For http/sse: the endpoint. */
    url?: string;
    /** Tool names available on that server — the invocation half of A2MCP. */
    tools: string[];
};
export type ParsedAgentCard = {
    card: AgentCard;
    /** Where the source document was fetched from, when it was fetched. */
    source?: string;
    /** Ordered, best first — flat 0.3 fields are folded in as an interface. */
    interfaces: AgentInterface[];
    /** The single best endpoint to talk to, or null when the card names none. */
    endpoint: string | null;
    skills: AgentSkillCard[];
    x402: X402Pricing | null;
    registry: RegistryBinding | null;
    mcp: McpBinding | null;
    /** Non-fatal problems. A card can be valid and still be a bad idea to trust. */
    warnings: string[];
};
/**
 * Validate and normalise a card that came from somewhere else.
 *
 * Throws `AgentCardError` on anything structurally wrong. Things that are
 * merely suspicious — no on-chain identity, prices with no payee, an http://
 * endpoint — come back in `warnings`, because the caller, not this function,
 * decides how much risk it is willing to take.
 */
export declare function parseAgentCard(input: unknown, source?: string): ParsedAgentCard;
export type BuildCardInput = {
    name: string;
    description: string;
    version?: string;
    /** Base URL this agent is served from, e.g. `https://agent.example`. */
    url: string;
    /** A2A endpoint if it differs from `url`. */
    a2aUrl?: string;
    provider?: {
        organization: string;
        url: string;
    };
    documentationUrl?: string;
    iconUrl?: string;
    skills: AgentSkillCard[];
    x402?: X402Pricing;
    registry?: RegistryBinding;
    mcp?: McpBinding;
    defaultInputModes?: string[];
    defaultOutputModes?: string[];
    capabilities?: {
        streaming?: boolean;
        pushNotifications?: boolean;
    };
};
/**
 * Build a card that satisfies both card generations at once: the 1.0
 * `supportedInterfaces` list AND the 0.3 flat `url`/`preferredTransport`/
 * `protocolVersion` fields, pointing at the same endpoint. Older clients read
 * the flat fields, newer ones read the list, and neither has to be told which
 * version it is looking at.
 */
export declare function buildAgentCard(input: BuildCardInput): AgentCard;
