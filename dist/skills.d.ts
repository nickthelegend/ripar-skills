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
import type { RiparRegistry } from "./registry.js";
import { type RiparConfig } from "./config.js";
import type { AgentSkillCard } from "./a2a/card.js";
export type SkillContext = {
    registry: RiparRegistry;
    config: RiparConfig;
};
export type Skill<S extends z.ZodType = z.ZodType> = {
    /** Stable, namespaced, and the same string in the A2A card and the price table. */
    id: string;
    name: string;
    description: string;
    tags: string[];
    examples: string[];
    input: S;
    /** USDC base units. 0 means free. */
    priceMicro: number;
    /** True when the result is a transaction for a human or wallet to sign. */
    producesUnsignedTx?: boolean;
    run: (input: z.infer<S>, ctx: SkillContext) => Promise<unknown>;
};
declare const resolveInput: z.ZodObject<{
    agentId: z.ZodOptional<z.ZodNumber>;
    domain: z.ZodOptional<z.ZodString>;
    address: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const resolveAgentSkill: Skill<typeof resolveInput>;
declare const reputationInput: z.ZodObject<{
    agentId: z.ZodNumber;
}, z.core.$strip>;
export declare const reputationReportSkill: Skill<typeof reputationInput>;
declare const settlementInput: z.ZodObject<{
    agentId: z.ZodOptional<z.ZodNumber>;
    address: z.ZodOptional<z.ZodString>;
    limit: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export declare const settlementAuditSkill: Skill<typeof settlementInput>;
declare const postJobInput: z.ZodObject<{
    sender: z.ZodString;
    specHash: z.ZodString;
    budgetMicro: z.ZodNumber;
    validatorAgentId: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export declare const postJobSkill: Skill<typeof postJobInput>;
export declare const SKILLS: Skill<any>[];
export declare function getSkill(id: string): Skill<any> | undefined;
/** JSON Schema for a skill's input, as published to MCP clients and the card. */
export declare function skillInputJsonSchema(skill: Skill<any>): Record<string, unknown>;
export declare function skillPriceUsdc(skill: Skill<any>): string;
/**
 * The skill list in A2A card form.
 *
 * Price does not live on the skill object here — the A2A `AgentSkill` shape has
 * no price field, and inventing one would produce a card that a strict reader
 * rejects. It goes in the x402 extension instead, keyed by the same skill id.
 */
export declare function skillsAsCardSkills(skills?: Skill<any>[]): AgentSkillCard[];
/** The `prices` half of the x402 card extension: skill id -> base units. */
export declare function skillPriceTable(skills?: Skill<any>[]): Record<string, string>;
export declare function skillsManifest(network?: "testnet" | "mainnet"): {
    asset: {
        id: number;
        symbol: string;
        decimals: number;
    };
    skills: {
        id: string;
        name: string;
        description: string;
        tags: string[];
        priceMicro: number;
        priceUsdc: string;
        producesUnsignedTx: boolean;
        inputSchema: Record<string, unknown>;
    }[];
};
export {};
