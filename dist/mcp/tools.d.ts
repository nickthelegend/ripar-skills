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
 * `ripar_rotate_address` — target methods that exist in ripar-contracts and are
 * NOT on the live registries, which ran out of deployment budget mid-generation.
 * They do not pretend otherwise and they do not fail obscurely: each one reads
 * the target app's approval program for the method's selector before composing,
 * and refuses with what the deployed contract does offer instead. See
 * `src/deployed.ts`.
 */
import { z } from "zod";
import { type RiparRegistry } from "../registry.js";
import type { RiparConfig } from "../config.js";
import { SKILLS, skillPriceUsdc, skillInputJsonSchema } from "../skills.js";
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
export declare const TOOLS: RiparToolSpec[];
export declare const TOOL_NAMES: string[];
export declare function getTool(name: string): RiparToolSpec | undefined;
/** Tool schemas as JSON Schema — what an MCP client actually sees in tools/list. */
export declare function toolJsonSchema(tool: RiparToolSpec): Record<string, unknown>;
/** A compact catalogue for humans and for the A2A card. */
export declare function toolCatalogue(): {
    name: string;
    title: string;
    description: string;
    readOnly: boolean;
    inputSchema: Record<string, unknown>;
}[];
export { SKILLS, skillPriceUsdc, skillInputJsonSchema };
