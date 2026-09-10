/**
 * The prose is a product surface, and it drifted.
 *
 * `config.ts` was updated to the current registry generation, the tests passed,
 * and the MCP tool descriptions went on telling every LLM client that the
 * identity registry was 769444119 — for three generations. The server
 * instructions said it too. A model reading those descriptions would have
 * quoted superseded app ids back to its user while the code underneath read the
 * right ones, and nothing anywhere would have raised a word.
 *
 * The ids are interpolated from `REGISTRY_APP_IDS` now, so this asserts the
 * property rather than the spelling: no descriptive text may contain a registry
 * id literal that is not a currently configured one.
 */
import { describe, expect, it } from "vitest";
import { REGISTRY_APP_IDS } from "../src/config.js";
import { TOOLS } from "../src/mcp/tools.js";
import { SERVER_INSTRUCTIONS } from "../src/mcp/server.js";

/** Every id this project has ever deployed a registry as. */
const SUPERSEDED = [768572968, 768572969, 768572979, 768633998, 768633999, 768634000, 769444119, 769444120, 769444121];

const CURRENT = new Set<number>([
  ...Object.values(REGISTRY_APP_IDS.testnet),
  ...Object.values(REGISTRY_APP_IDS.mainnet ?? {}),
]);

/** Everything an MCP client is shown as text. */
function surfaces(): { where: string; text: string }[] {
  return [
    { where: "SERVER_INSTRUCTIONS", text: SERVER_INSTRUCTIONS },
    ...TOOLS.map((t) => ({ where: `tool ${t.name} description`, text: t.description })),
  ];
}

describe("registry ids in LLM-facing prose", () => {
  it("names no superseded registry", () => {
    for (const { where, text } of surfaces()) {
      for (const old of SUPERSEDED) {
        if (CURRENT.has(old)) continue;
        expect(text, `${where} names superseded registry ${old}`).not.toContain(String(old));
      }
    }
  });

  it("quotes the configured ids, so the text and the code agree", () => {
    const all = surfaces().map((s) => s.text).join(" ");
    expect(all).toContain(String(REGISTRY_APP_IDS.testnet.identity));
    expect(all).toContain(String(REGISTRY_APP_IDS.testnet.validation));
    expect(SERVER_INSTRUCTIONS).toContain(String(REGISTRY_APP_IDS.testnet.reputation));
  });

  it("contains no 9-digit app id that is not currently configured", () => {
    for (const { where, text } of surfaces()) {
      for (const m of text.match(/\b7\d{8}\b/g) ?? []) {
        expect(CURRENT.has(Number(m)), `${where} names unconfigured app id ${m}`).toBe(true);
      }
    }
  });
});
