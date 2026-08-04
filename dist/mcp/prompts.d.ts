/**
 * MCP prompts: the three flows that are easy to get wrong.
 *
 * A prompt here is not a personality or a system message. It is a procedure a
 * user can pick from a menu — "vet this agent before paying it" — that expands
 * into the ORDER the tools have to be called in, and the reasons an answer
 * should be no. That order is the part a model does not get from the tool
 * descriptions: any one tool can say what it returns, but nothing in
 * `ripar_get_reputation` says "check the settlements before you believe this",
 * and nothing in `ripar_post_job` says "your budget is not money until you
 * fund it".
 *
 * Two rules hold for everything in this file:
 *
 *   1. Every tool named in a prompt exists. A prompt that references a tool the
 *      server does not register sends the model looking for something that
 *      cannot be found, and it will improvise instead — which, for a question
 *      about whether an agent has been paid, means inventing a track record.
 *      `PROMPTS_REFERENCE_TOOLS` is asserted against `TOOL_NAMES` in the tests.
 *   2. Nothing here tells the model to sign anything. The compose tools return
 *      unsigned transactions and the prompts say so, because a flow that ends
 *      "and then submit it" would be describing a capability this server does
 *      not have.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export type RiparPromptSpec = {
    name: string;
    title: string;
    description: string;
    argsShape: z.ZodRawShape;
    /** Tool names the rendered text tells the model to use. Checked against TOOL_NAMES. */
    tools: string[];
    render: (args: Record<string, string | undefined>) => string;
};
export declare const PROMPTS: RiparPromptSpec[];
/** Every tool name any prompt tells the model to call. Asserted against TOOL_NAMES. */
export declare const PROMPTS_REFERENCE_TOOLS: string[];
export declare function getPrompt(name: string): RiparPromptSpec | undefined;
export declare function registerRiparPrompts(server: McpServer): void;
