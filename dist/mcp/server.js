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
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RiparRegistry } from "../registry.js";
import { resolveConfig } from "../config.js";
import { TOOLS } from "./tools.js";
import { registerRiparResources } from "./resources.js";
import { registerRiparPrompts } from "./prompts.js";
export const SERVER_NAME = "ripar-skills";
export const SERVER_VERSION = "0.1.0";
export const SERVER_INSTRUCTIONS = `
Ripar's agent-interoperability tools, reading three registries that are live on Algorand TestNet:
IdentityRegistry 769444119, ReputationRegistry 769444120, ValidationRegistry 769444121.

Two things to know before using these:

1. Every read hits the chain. There is no cache and no seed data. If a call fails, the answer is
   unknown — do not substitute a plausible number.

2. This server holds no private key. ripar_post_job, ripar_fund_job and ripar_settle_escrow return
   UNSIGNED transactions for a human or wallet to sign; they submit nothing. ripar_call_endpoint
   cannot pay a 402 challenge on its own and will hand the challenge back unless the caller supplies
   an already-signed payment header.

A job carries two different money numbers and they are not interchangeable. The BUDGET is what the
client says the work is worth; the ESCROW is what they have actually handed to the contract. Budget
1.0 with escrow 0 is an unfunded job, and no agent should do that work expecting to be paid.

A useful order for "should I use this agent?": ripar_search_agents to find it, ripar_get_reputation
to see whether anyone has actually paid it, ripar_settlements to check the payments are real, then
ripar_quote_endpoint before committing to anything. The vet_agent prompt walks exactly that.

Registry state is also readable as resources — ripar://agents, ripar://agent/1, ripar://jobs,
ripar://job/1, ripar://registries — every one of them a live chain read at the moment it is read.
`.trim();
export function createRiparMcpServer(opts = {}) {
    const { registry: injected, ...configInput } = opts;
    // When a registry is injected, its config wins for everything — including the
    // fetch used by the x402 and transaction paths. Two different fetch
    // implementations in one server means a test (or a proxy) can be pointed at
    // the registry and silently miss the endpoints that spend money.
    const config = injected?.config ?? resolveConfig(configInput);
    const registry = injected ?? new RiparRegistry(configInput);
    const ctx = { registry, config };
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
    for (const tool of TOOLS) {
        server.registerTool(tool.name, {
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputShape,
            annotations: { title: tool.title, ...tool.annotations },
        }, async (args) => {
            try {
                const result = await tool.run(args ?? {}, ctx);
                return { content: [{ type: "text", text: stringify(result) }] };
            }
            catch (err) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: stringify({
                                error: err.message,
                                tool: tool.name,
                                // Said explicitly so a model does not fill the gap itself.
                                note: "this is a real failure, not an empty result — the on-chain answer is unknown",
                            }),
                        },
                    ],
                };
            }
        });
    }
    registerRiparResources(server, ctx);
    registerRiparPrompts(server);
    return server;
}
/** BigInt shows up from ABI decoding and JSON.stringify throws on it outright. */
function stringify(value) {
    return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}
/** Run the server on stdio. stdout is the protocol channel — log to stderr only. */
export async function startStdioServer(opts = {}) {
    const server = createRiparMcpServer(opts);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return server;
}
