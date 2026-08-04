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
export {};
