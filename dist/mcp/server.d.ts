/**
 * The MCP server itself.
 *
 * Thin on purpose: it takes the specs from `tools.ts`, `resources.ts` and
 * `prompts.ts`, registers each one, and turns whatever a handler returned into
 * MCP content. All the judgement lives in the specs and the registry reads,
 * which are testable without a transport.
 *
 * All three halves of MCP are served, because they answer different questions
 * about the same registries: tools are what a model can DO, resources are what
 * a client can PUT IN FRONT of it without deciding to invoke anything, and
 * prompts are the ORDER the tools have to be used in for the answer to be worth
 * anything.
 *
 * Errors are returned as tool results with `isError: true` rather than thrown.
 * A thrown error inside an MCP handler surfaces to the model as a protocol
 * failure with no explanation; a result the model can read ("the indexer
 * returned 503") lets it decide whether to retry or tell the user. What it must
 * never do is let a failed chain read look like an empty one. Resource reads
 * are the exception and DO throw: MCP has no per-resource error flag, so the
 * protocol-level error is the only way to say "this is not the document".
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RiparRegistry } from "../registry.js";
import { type RiparConfigInput } from "../config.js";
export declare const SERVER_NAME = "ripar-skills";
export declare const SERVER_VERSION = "0.1.0";
export declare const SERVER_INSTRUCTIONS: string;
export type CreateServerOptions = RiparConfigInput & {
    registry?: RiparRegistry;
};
export declare function createRiparMcpServer(opts?: CreateServerOptions): McpServer;
/** Run the server on stdio. stdout is the protocol channel — log to stderr only. */
export declare function startStdioServer(opts?: CreateServerOptions): Promise<McpServer>;
