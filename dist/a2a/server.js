/**
 * Publishing a card.
 *
 * `riparAgentCard()` builds the card for an agent whose skills are the four in
 * `skills.ts`; `createCardHandler()` wraps it in a request handler that answers
 * both well-known paths. No framework — a card is a static JSON document, and
 * pulling in a web server to serve one file would make this package heavier
 * than the thing it publishes.
 */
import { createServer } from "node:http";
import { REGISTRY_APP_IDS, USDC_ASSET_ID, USDC_DECIMALS, CAIP2, } from "../config.js";
import { SKILLS, skillPriceTable, skillsAsCardSkills } from "../skills.js";
import { TOOL_NAMES } from "../mcp/tools.js";
import { WELL_KNOWN_PATH, WELL_KNOWN_PATH_CURRENT, buildAgentCard, } from "./card.js";
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
export function riparAgentCard(input) {
    const network = input.network ?? "testnet";
    const skills = input.skills ?? SKILLS;
    return buildAgentCard({
        name: input.name,
        description: input.description,
        version: input.version ?? "0.1.0",
        url: input.url,
        a2aUrl: input.a2aUrl,
        provider: input.provider,
        documentationUrl: input.documentationUrl,
        iconUrl: input.iconUrl,
        skills: skillsAsCardSkills(skills),
        x402: {
            network: CAIP2[network],
            asset: { id: USDC_ASSET_ID[network], symbol: "USDC", decimals: USDC_DECIMALS },
            payTo: input.payTo,
            facilitator: input.facilitator,
            prices: skillPriceTable(skills),
        },
        registry: {
            chain: CAIP2[network],
            agentId: input.agentId,
            identityApp: REGISTRY_APP_IDS.testnet.identity,
            reputationApp: REGISTRY_APP_IDS.testnet.reputation,
            validationApp: REGISTRY_APP_IDS.testnet.validation,
        },
        mcp: {
            transport: input.mcp?.transport ?? "stdio",
            command: input.mcp?.command ?? (input.mcp?.transport ? undefined : "npx"),
            args: input.mcp?.args ?? (input.mcp?.transport ? undefined : ["-y", "@ripar/skills"]),
            url: input.mcp?.url,
            tools: input.mcp?.tools ?? TOOL_NAMES,
        },
    });
}
/**
 * A handler for both well-known paths.
 *
 * Returns true when it answered, false when the path was not ours — so it drops
 * into an existing server as a first line rather than taking it over.
 */
export function createCardHandler(card) {
    const body = JSON.stringify(card, null, 2);
    return (req, res) => {
        const path = (req.url ?? "").split("?")[0];
        if (path !== WELL_KNOWN_PATH && path !== WELL_KNOWN_PATH_CURRENT)
            return false;
        res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            // A card is public by definition — discovery from a browser-based agent
            // fails without this, and there is nothing here worth protecting.
            "access-control-allow-origin": "*",
            "cache-control": "public, max-age=300",
        });
        res.end(body);
        return true;
    };
}
/** A standalone server, for when the card is the only thing being served. */
export function serveAgentCard(card, port = 8402) {
    const handle = createCardHandler(card);
    const server = createServer((req, res) => {
        if (handle(req, res))
            return;
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({
            error: "not found",
            cardAt: [WELL_KNOWN_PATH, WELL_KNOWN_PATH_CURRENT],
        }));
    });
    server.listen(port);
    return server;
}
