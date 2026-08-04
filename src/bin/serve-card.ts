#!/usr/bin/env node
/**
 * Serve this agent's A2A card, so another agent can discover it.
 *
 * The card it publishes points at the same MCP tools this package exposes —
 * that is the A2MCP hop in one command: a peer fetches
 * `/.well-known/agent.json`, reads the MCP extension, and knows what to connect
 * to next.
 *
 *   RIPAR_AGENT_ID=1 RIPAR_PAY_TO=<58-char address> npm run card
 */

import { riparAgentCard, serveAgentCard } from "../a2a/server.js";
import { WELL_KNOWN_PATH, WELL_KNOWN_PATH_CURRENT } from "../a2a/card.js";

const port = Number(process.env.PORT ?? 8402);
const url = process.env.RIPAR_AGENT_URL ?? `http://localhost:${port}`;
const agentId = Number(process.env.RIPAR_AGENT_ID ?? 0);
const payTo = process.env.RIPAR_PAY_TO ?? "";

if (!payTo) {
  console.error(
    "RIPAR_PAY_TO is required: the card quotes prices, and a price with no payee is not a quote."
  );
  process.exit(1);
}
if (!agentId) {
  console.warn(
    "RIPAR_AGENT_ID is 0, so this card makes no on-chain claim. Peers that verify it will say so."
  );
}

const card = riparAgentCard({
  name: process.env.RIPAR_AGENT_NAME ?? "Ripar Skills Agent",
  description:
    process.env.RIPAR_AGENT_DESCRIPTION ??
    "Reads Ripar's on-chain agent registries on Algorand and exposes them as MCP tools: identity, " +
      "reputation earned from settled payments, validated jobs, and x402 settlement history.",
  url,
  agentId,
  payTo,
  network: (process.env.RIPAR_NETWORK as "testnet" | "mainnet" | undefined) ?? "testnet",
  documentationUrl: "https://github.com/ripar/ripar-skills#readme",
});

serveAgentCard(card, port);
console.error(`agent card on ${url}${WELL_KNOWN_PATH} (and ${WELL_KNOWN_PATH_CURRENT})`);
