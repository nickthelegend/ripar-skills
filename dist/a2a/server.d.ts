/**
 * Publishing a card.
 *
 * `riparAgentCard()` builds the card for an agent whose skills are the four in
 * `skills.ts`; `createCardHandler()` wraps it in a request handler that answers
 * both well-known paths. No framework — a card is a static JSON document, and
 * pulling in a web server to serve one file would make this package heavier
 * than the thing it publishes.
 */
import { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type Network } from "../config.js";
import { type Skill } from "../skills.js";
import { type AgentCard } from "./card.js";
export type RiparCardInput = {
    name: string;
    description: string;
    version?: string;
    /** Base URL this agent is served from. Must match the domain in the registry. */
    url: string;
    a2aUrl?: string;
    /** The IdentityRegistry id backing this card. 0 means "not registered yet". */
    agentId: number;
    /** Algorand address that receives x402 payments. */
    payTo: string;
    network?: Network;
    facilitator?: string;
    skills?: Skill<any>[];
    provider?: {
        organization: string;
        url: string;
    };
    documentationUrl?: string;
    iconUrl?: string;
    /** How a peer should reach this agent's MCP server. Defaults to the npm stdio command. */
    mcp?: {
        transport: "stdio" | "http" | "sse";
        command?: string;
        args?: string[];
        url?: string;
        tools?: string[];
    };
};
/**
 * Build Ripar's card.
 *
 * The three extensions are what make it more than a business card: the x402
 * block says what each skill costs and where to pay, the registry block names
 * the on-chain id a peer can check that price-setter's track record against,
 * and the MCP block names the server and tools a peer should connect to. A
 * stranger with only this document can price the work, check the reputation,
 * and make the call.
 */
export declare function riparAgentCard(input: RiparCardInput): AgentCard;
export type CardHandler = (req: IncomingMessage, res: ServerResponse) => boolean;
/**
 * A handler for both well-known paths.
 *
 * Returns true when it answered, false when the path was not ours — so it drops
 * into an existing server as a first line rather than taking it over.
 */
export declare function createCardHandler(card: AgentCard): CardHandler;
/** A standalone server, for when the card is the only thing being served. */
export declare function serveAgentCard(card: AgentCard, port?: number): Server;
