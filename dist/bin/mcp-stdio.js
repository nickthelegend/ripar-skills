#!/usr/bin/env node
/**
 * stdio entry point. This is the path that goes in claude_desktop_config.json.
 *
 * stdout carries the MCP protocol, so every diagnostic goes to stderr. A stray
 * console.log here corrupts the JSON-RPC stream and the client reports the
 * server as broken with no hint as to why.
 */
import { startStdioServer } from "../mcp/server.js";
import { REGISTRY_APP_IDS } from "../config.js";
const network = process.env.RIPAR_NETWORK ?? "testnet";
async function main() {
    await startStdioServer({
        network,
        ...(process.env.RIPAR_ALGOD ? { algod: process.env.RIPAR_ALGOD } : {}),
        ...(process.env.RIPAR_INDEXER ? { indexer: process.env.RIPAR_INDEXER } : {}),
    });
    console.error(`ripar-skills MCP server on stdio (${network}, identity app ${REGISTRY_APP_IDS.testnet.identity})`);
}
main().catch((err) => {
    console.error("ripar-skills failed to start:", err);
    process.exit(1);
});
