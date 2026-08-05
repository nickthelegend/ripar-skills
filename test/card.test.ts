/**
 * A2A agent card tests: emitting, parsing, and discovering.
 *
 * The parser is a trust boundary — a card is a document a stranger wrote — so
 * these lean on the cases where being permissive would cost someone money:
 * a card that names no endpoint, prices with no payee, and an on-chain identity
 * that belongs to a different domain than the one that served the card.
 */

import { describe, expect, it } from "vitest";
import { ABIType } from "algosdk";

import {
  A2A_PROTOCOL_VERSION,
  AgentCardError,
  RIPAR_EXT,
  WELL_KNOWN_PATH,
  WELL_KNOWN_PATH_CURRENT,
  buildAgentCard,
  parseAgentCard,
} from "../src/a2a/card.js";
import { cardUrlCandidates, discoverAgent } from "../src/a2a/discover.js";
import { createCardHandler, riparAgentCard } from "../src/a2a/server.js";
import { RiparRegistry } from "../src/registry.js";
import { TOOL_NAMES } from "../src/mcp/tools.js";
import { SKILLS } from "../src/skills.js";

const PAY_TO = "UBB4PNTT7CI3IQS25ZMQR4DGVYYCBORNSBLU4WKUGX4BAZ3KN4O2KATPAU";

const minimalSkill = {
  id: "demo.echo",
  name: "Echo",
  description: "Echoes the input back",
  tags: ["demo"],
};

/** A card in the CURRENT (1.0) shape: transports live in supportedInterfaces. */
const modernCard = {
  name: "Modern Agent",
  description: "Speaks A2A 1.0",
  version: "2.0.0",
  supportedInterfaces: [
    { url: "https://modern.example/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
  ],
  skills: [minimalSkill],
};

/** A card in the OLDER (0.3) shape: flat url + preferredTransport. */
const legacyCard = {
  name: "Legacy Agent",
  description: "Speaks A2A 0.3",
  version: "1.0.0",
  url: "https://legacy.example/a2a",
  preferredTransport: "JSONRPC",
  protocolVersion: "0.3",
  skills: [minimalSkill],
};

describe("parseAgentCard: required structure", () => {
  it("accepts a well-formed modern card", () => {
    const parsed = parseAgentCard(modernCard);
    expect(parsed.card.name).toBe("Modern Agent");
    expect(parsed.endpoint).toBe("https://modern.example/a2a");
    expect(parsed.skills).toHaveLength(1);
  });

  it.each([
    ["name", { ...modernCard, name: undefined }],
    ["description", { ...modernCard, description: undefined }],
    ["version", { ...modernCard, version: undefined }],
    ["skills", { ...modernCard, skills: undefined }],
  ])("rejects a card with no %s", (field, bad) => {
    expect(() => parseAgentCard(bad)).toThrow(AgentCardError);
    try {
      parseAgentCard(bad);
    } catch (err) {
      expect((err as AgentCardError).issues.join(" ")).toContain(field);
    }
  });

  it("rejects a card that names no endpoint at all", () => {
    const noEndpoint = { ...modernCard, supportedInterfaces: undefined };
    expect(() => parseAgentCard(noEndpoint)).toThrow(/names no endpoint/);
  });

  it("rejects a skill that is missing its id or description", () => {
    expect(() =>
      parseAgentCard({ ...modernCard, skills: [{ name: "x", description: "y", tags: [] }] })
    ).toThrow(/skills\.0\.id/);
    expect(() =>
      parseAgentCard({ ...modernCard, skills: [{ id: "x", name: "y", tags: [] }] })
    ).toThrow(/skills\.0\.description/);
  });

  it("rejects things that are not objects", () => {
    expect(() => parseAgentCard(null)).toThrow(AgentCardError);
    expect(() => parseAgentCard("https://example.com")).toThrow(AgentCardError);
    expect(() => parseAgentCard(42)).toThrow(AgentCardError);
  });
});

describe("parseAgentCard: both card generations", () => {
  it("folds the legacy flat url into the interface list", () => {
    const parsed = parseAgentCard(legacyCard);
    expect(parsed.endpoint).toBe("https://legacy.example/a2a");
    expect(parsed.interfaces).toEqual([
      { url: "https://legacy.example/a2a", protocolBinding: "JSONRPC", protocolVersion: "0.3" },
    ]);
  });

  it("does not duplicate an endpoint that appears in both shapes", () => {
    const both = {
      ...modernCard,
      url: "https://modern.example/a2a",
      preferredTransport: "JSONRPC",
      protocolVersion: "1.0",
    };
    expect(parseAgentCard(both).interfaces).toHaveLength(1);
  });

  it("defaults a legacy card's missing transport fields rather than failing", () => {
    const sparse = { ...legacyCard, preferredTransport: undefined, protocolVersion: undefined };
    const parsed = parseAgentCard(sparse);
    expect(parsed.interfaces[0]!.protocolBinding).toBe("JSONRPC");
    expect(parsed.interfaces[0]!.protocolVersion).toBe(A2A_PROTOCOL_VERSION);
  });
});

describe("parseAgentCard: Ripar extensions", () => {
  const withExtensions = {
    ...modernCard,
    capabilities: {
      extensions: [
        {
          uri: RIPAR_EXT.x402,
          params: {
            network: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe",
            asset: { id: 10458941, symbol: "USDC", decimals: 6 },
            payTo: PAY_TO,
            prices: { "demo.echo": "10000" },
          },
        },
        {
          uri: RIPAR_EXT.registry,
          params: { chain: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe", agentId: 1, identityApp: 768633998 },
        },
        {
          uri: RIPAR_EXT.mcp,
          params: {
            transport: "stdio",
            command: "npx",
            args: ["-y", "@ripar/skills"],
            tools: ["ripar_get_agent", "ripar_get_reputation"],
          },
        },
      ],
    },
  };

  it("pulls x402 pricing out of the extension block", () => {
    const { x402 } = parseAgentCard(withExtensions);
    expect(x402).not.toBeNull();
    expect(x402!.payTo).toBe(PAY_TO);
    expect(x402!.asset.id).toBe(10458941);
    expect(x402!.prices["demo.echo"]).toBe("10000");
  });

  it("pulls the registry binding out, which is what makes the card checkable", () => {
    const { registry } = parseAgentCard(withExtensions);
    expect(registry).toEqual({
      chain: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe",
      agentId: 1,
      identityApp: 768633998,
      reputationApp: undefined,
      validationApp: undefined,
    });
  });

  it("pulls the MCP binding out — the A2MCP hop from discovery to invocation", () => {
    const { mcp } = parseAgentCard(withExtensions);
    expect(mcp).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@ripar/skills"],
      url: undefined,
      tools: ["ripar_get_agent", "ripar_get_reputation"],
    });
  });

  it("returns nulls, not guesses, when the extensions are absent", () => {
    const parsed = parseAgentCard(modernCard);
    expect(parsed.x402).toBeNull();
    expect(parsed.registry).toBeNull();
    expect(parsed.mcp).toBeNull();
  });
});

describe("parseAgentCard: warnings a caller should see before paying", () => {
  it("warns when nothing on chain backs the card", () => {
    expect(parseAgentCard(modernCard).warnings.join(" ")).toMatch(/no registry extension/);
  });

  it("warns when a price has no payee", () => {
    const card = {
      ...modernCard,
      capabilities: {
        extensions: [{ uri: RIPAR_EXT.x402, params: { prices: { "demo.echo": "1" } } }],
      },
    };
    expect(parseAgentCard(card).warnings.join(" ")).toMatch(/names no payTo/);
  });

  it("warns when prices reference skills the card does not list", () => {
    const card = {
      ...modernCard,
      capabilities: {
        extensions: [
          { uri: RIPAR_EXT.x402, params: { payTo: PAY_TO, prices: { "not.a.skill": "1" } } },
        ],
      },
    };
    expect(parseAgentCard(card).warnings.join(" ")).toMatch(/not\.a\.skill/);
  });

  it("warns when the registry extension claims agent 0", () => {
    const card = {
      ...modernCard,
      capabilities: { extensions: [{ uri: RIPAR_EXT.registry, params: { agentId: 0 } }] },
    };
    expect(parseAgentCard(card).warnings.join(" ")).toMatch(/agentId is 0/);
  });

  it("warns about a plaintext endpoint and about duplicate skill ids", () => {
    const card = {
      ...modernCard,
      supportedInterfaces: [
        { url: "http://insecure.example/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
      ],
      skills: [minimalSkill, minimalSkill],
    };
    const warnings = parseAgentCard(card).warnings.join(" ");
    expect(warnings).toMatch(/plaintext http/);
    expect(warnings).toMatch(/duplicate skill ids: demo\.echo/);
  });

  it("warns when the MCP extension names no tools, so discovery leads nowhere", () => {
    const card = {
      ...modernCard,
      capabilities: { extensions: [{ uri: RIPAR_EXT.mcp, params: { transport: "stdio" } }] },
    };
    expect(parseAgentCard(card).warnings.join(" ")).toMatch(/names no tools/);
  });
});

describe("buildAgentCard", () => {
  it("emits both card generations from one document", () => {
    const card = buildAgentCard({
      name: "Test",
      description: "Test agent",
      url: "https://test.example",
      skills: [minimalSkill],
    });
    expect(card.supportedInterfaces).toEqual([
      { url: "https://test.example/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
    ]);
    expect(card.url).toBe("https://test.example/a2a");
    expect(card.preferredTransport).toBe("JSONRPC");
    expect(card.protocolVersion).toBe("1.0");
  });

  it("round-trips through its own parser", () => {
    const card = buildAgentCard({
      name: "Test",
      description: "Test agent",
      url: "https://test.example",
      skills: [minimalSkill],
      x402: {
        network: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe",
        asset: { id: 10458941, symbol: "USDC", decimals: 6 },
        payTo: PAY_TO,
        prices: { "demo.echo": "10000" },
      },
      registry: { chain: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe", agentId: 7 },
      mcp: { transport: "stdio", command: "npx", args: ["-y", "@ripar/skills"], tools: ["a"] },
    });
    const parsed = parseAgentCard(JSON.parse(JSON.stringify(card)));
    expect(parsed.x402!.payTo).toBe(PAY_TO);
    expect(parsed.registry!.agentId).toBe(7);
    expect(parsed.mcp!.tools).toEqual(["a"]);
  });
});

describe("riparAgentCard", () => {
  const card = riparAgentCard({
    name: "Ripar Skills Agent",
    description: "Reads Ripar's on-chain registries",
    url: "https://agent.example",
    agentId: 1,
    payTo: PAY_TO,
  });

  it("advertises all four skills with a price for each", () => {
    const parsed = parseAgentCard(card);
    expect(parsed.skills.map((s) => s.id).sort()).toEqual(SKILLS.map((s) => s.id).sort());
    for (const skill of SKILLS) {
      expect(parsed.x402!.prices[skill.id]).toBe(String(skill.priceMicro));
    }
  });

  it("advertises every MCP tool, which is what makes it discoverable-then-callable", () => {
    const parsed = parseAgentCard(card);
    expect(parsed.mcp!.tools).toEqual(TOOL_NAMES);
    expect(parsed.mcp!.command).toBe("npx");
  });

  it("binds the card to the live TestNet registries", () => {
    const parsed = parseAgentCard(card);
    expect(parsed.registry).toMatchObject({
      agentId: 1,
      identityApp: 768633998,
      reputationApp: 768633999,
      validationApp: 768634000,
    });
    // With an id claimed and the apps named, it should not warn about being unbacked.
    expect(parsed.warnings.join(" ")).not.toMatch(/no registry extension/);
  });
});

describe("createCardHandler", () => {
  function fakeReqRes(url: string) {
    const res = {
      statusCode: 0,
      headers: {} as Record<string, string>,
      body: "",
      writeHead(code: number, headers: Record<string, string>) {
        this.statusCode = code;
        this.headers = headers;
      },
      end(body: string) {
        this.body = body;
      },
    };
    return { req: { url } as any, res: res as any, res_: res };
  }

  const handler = createCardHandler(
    riparAgentCard({
      name: "N",
      description: "D",
      url: "https://agent.example",
      agentId: 1,
      payTo: PAY_TO,
    })
  );

  it.each([WELL_KNOWN_PATH, WELL_KNOWN_PATH_CURRENT])("serves the card at %s", (path) => {
    const { req, res, res_ } = fakeReqRes(path);
    expect(handler(req, res)).toBe(true);
    expect(res_.statusCode).toBe(200);
    expect(res_.headers["access-control-allow-origin"]).toBe("*");
    expect(parseAgentCard(JSON.parse(res_.body)).skills).toHaveLength(SKILLS.length);
  });

  it("declines paths that are not the card, so it can sit in front of a real app", () => {
    const { req, res } = fakeReqRes("/api/anything");
    expect(handler(req, res)).toBe(false);
  });
});

describe("cardUrlCandidates", () => {
  it("turns a bare domain into both well-known paths, over https", () => {
    expect(cardUrlCandidates("example.com")).toEqual([
      "https://example.com/.well-known/agent.json",
      "https://example.com/.well-known/agent-card.json",
    ]);
  });

  it("never downgrades to plaintext http on its own", () => {
    expect(cardUrlCandidates("example.com").every((u) => u.startsWith("https://"))).toBe(true);
  });

  it("uses a direct card url as-is", () => {
    expect(cardUrlCandidates("https://example.com/.well-known/agent-card.json")).toEqual([
      "https://example.com/.well-known/agent-card.json",
    ]);
  });

  it("rejects empty input", () => {
    expect(() => cardUrlCandidates("   ")).toThrow(AgentCardError);
  });
});

describe("discoverAgent", () => {
  const served = riparAgentCard({
    name: "Ripar Skills Agent",
    description: "Reads Ripar's on-chain registries",
    url: "https://agent-1785821796525.ripar.io",
    agentId: 1,
    payTo: PAY_TO,
  });

  /** Serves the card only at the legacy path, and 404s the modern one. */
  function stubFetch(card: unknown, onlyPath = "/.well-known/agent.json") {
    return (async (url: string) => {
      if (new URL(url).pathname === onlyPath) {
        return new Response(JSON.stringify(card), { status: 200 });
      }
      return new Response("nope", { status: 404, statusText: "Not Found" });
    }) as unknown as typeof fetch;
  }

  /** A registry stub whose agent 1 is registered to `domain`. */
  function stubRegistry(domain: string) {
    const value = Buffer.from(
      ABIType.from("(uint64,string,address,uint64,uint64)").encode([1n, domain, PAY_TO, 1n, 1n])
    ).toString("base64");
    return new RiparRegistry({
      fetch: (async () =>
        new Response(JSON.stringify({ value }), { status: 200 })) as unknown as typeof fetch,
    });
  }

  it("finds a card at the legacy path when the modern one 404s", async () => {
    const result = await discoverAgent("agent-1785821796525.ripar.io", {
      fetch: stubFetch(served),
      registry: stubRegistry("agent-1785821796525.ripar.io"),
    });
    expect(result.source).toBe(
      "https://agent-1785821796525.ripar.io/.well-known/agent.json"
    );
    expect(result.card.name).toBe("Ripar Skills Agent");
    expect(result.mcp!.tools).toEqual(TOOL_NAMES);
  });

  it("verifies the card against the chain when the domains agree", async () => {
    const result = await discoverAgent("agent-1785821796525.ripar.io", {
      fetch: stubFetch(served),
      registry: stubRegistry("agent-1785821796525.ripar.io"),
    });
    expect(result.verification.checked).toBe(true);
    expect(result.verification.verified).toBe(true);
    expect(result.verification.onChain).toMatchObject({ agentId: 1 });
  });

  it("refuses to verify a card served from a domain the registry does not match", async () => {
    // The card claims agent 1, but it is being served from impostor.example.
    const impostor = riparAgentCard({
      name: "Impostor",
      description: "Claims to be agent 1",
      url: "https://impostor.example",
      agentId: 1,
      payTo: PAY_TO,
    });
    const result = await discoverAgent("impostor.example", {
      fetch: stubFetch(impostor),
      registry: stubRegistry("agent-1785821796525.ripar.io"),
    });
    expect(result.verification.checked).toBe(true);
    expect(result.verification.verified).toBe(false);
    expect(result.verification.reason).toMatch(/impersonating/);
  });

  it("skips verification when asked, and says so instead of implying success", async () => {
    const result = await discoverAgent("agent-1785821796525.ripar.io", {
      fetch: stubFetch(served),
      verifyOnChain: false,
    });
    expect(result.verification.checked).toBe(false);
    expect(result.verification.verified).toBe(false);
  });

  it("throws with every attempted url when no card is anywhere", async () => {
    const dead = (async () =>
      new Response("", { status: 404, statusText: "Not Found" })) as unknown as typeof fetch;
    await expect(discoverAgent("nothing.example", { fetch: dead })).rejects.toThrow(
      /No agent card at nothing\.example/
    );
    try {
      await discoverAgent("nothing.example", { fetch: dead });
    } catch (err) {
      expect((err as AgentCardError).issues).toHaveLength(2);
    }
  });

  it("rejects a served document that is not a valid card", async () => {
    await expect(
      discoverAgent("bad.example", { fetch: stubFetch({ name: "no skills here" }) })
    ).rejects.toThrow(AgentCardError);
  });
});
