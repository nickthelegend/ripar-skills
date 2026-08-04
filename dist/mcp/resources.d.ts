/**
 * MCP resources: the registries as documents you can read rather than calls you
 * have to make.
 *
 * Tools and resources answer different questions. A tool is something a model
 * chooses to DO, and every one of them takes arguments a model has to guess at.
 * A resource is something a client can put in front of the model — or in front
 * of a person — without anyone deciding to invoke anything: `ripar://agents` is
 * a list a user can browse in their client's resource picker and attach to a
 * conversation, and `ripar://job/2` is a permalink to one job that can be
 * pasted, bookmarked, or re-read later.
 *
 * The templates enumerate. `ripar://agent/{agentId}` ships a `list` callback, so
 * every registered agent shows up in `resources/list` as its own entry with its
 * real domain as the title — a client can show the actual roster rather than a
 * URI pattern the user is expected to fill in themselves.
 *
 * **Every read here hits the chain, on every read.** There is no cache, and
 * that is deliberate: a stale escrow figure is worse than a slow one, because a
 * cached "escrow 1.0" on a job whose escrow was released half a minute ago is a
 * number that will get somebody to do unpaid work. If algod is unreachable the
 * read fails loudly. The one thing a resource must never do is answer from
 * memory while looking like it answered from the chain.
 */
import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type RiparRegistry } from "../registry.js";
import type { RiparConfig } from "../config.js";
export type ResourceContext = {
    registry: RiparRegistry;
    config: RiparConfig;
};
export declare const RESOURCE_URIS: {
    readonly registries: "ripar://registries";
    readonly agents: "ripar://agents";
    readonly agent: "ripar://agent/{agentId}";
    readonly jobs: "ripar://jobs";
    readonly job: "ripar://job/{jobId}";
};
export declare function registerRiparResources(server: McpServer, ctx: ResourceContext): void;
