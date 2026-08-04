/**
 * Skill tests.
 *
 * A skill is only useful if its three parts agree: the id in the A2A card, the
 * id in the price table, and the id the MCP tool dispatches on. These tests
 * pin that agreement, plus the input validation that keeps a malformed call
 * from reaching the chain.
 */

import { describe, expect, it } from "vitest";

import {
  SKILLS,
  getSkill,
  skillInputJsonSchema,
  skillPriceTable,
  skillPriceUsdc,
  skillsAsCardSkills,
  skillsManifest,
  postJobSkill,
  reputationReportSkill,
  resolveAgentSkill,
  settlementAuditSkill,
} from "../src/skills.js";
import { RiparRegistry } from "../src/registry.js";
import { resolveConfig } from "../src/config.js";

const AGENT_1_BOX =
  "AAAAAAAAAAEAOqBDx7Zz+JG0QlruWQjwZq4wILotkFdOWVQ1+BBnam8dAAAAAGpxemIAAAAAanF6YgAcYWdlbnQtMTc4NTgyMTc5NjUyNS5yaXBhci5pbw==";
const SCORE_1_BOX =
  "AAAAAAAAAAEAAAAAAAAAAQAAAAAAACcQAAAAAAAAAAAAAAAAAAAAAAAAAABqcXpyAAAAAGpxenI=";
const AGENT_1_ADDRESS = "UBB4PNTT7CI3IQS25ZMQR4DGVYYCBORNSBLU4WKUGX4BAZ3KN4O2KATPAU";

function ctxWith(boxes: Record<string, string | null>) {
  const registry = new RiparRegistry({
    fetch: (async (url: string) => {
      const match = /name=([^&]+)/.exec(url);
      if (match) {
        const name = decodeURIComponent(match[1]!).replace(/^b64:/, "");
        const value = boxes[name];
        if (value === undefined || value === null) {
          return new Response("", { status: 404 });
        }
        return new Response(JSON.stringify({ value }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch,
  });
  return { registry, config: registry.config };
}

describe("the four shipped skills", () => {
  it("ships exactly four, each with a stable namespaced id", () => {
    expect(SKILLS).toHaveLength(4);
    expect(SKILLS.map((s) => s.id)).toEqual([
      "ripar.identity.resolve",
      "ripar.reputation.report",
      "ripar.settlement.audit",
      "ripar.validation.post-job",
    ]);
    expect(SKILLS.every((s) => s.id.startsWith("ripar."))).toBe(true);
  });

  it("gives each one an input schema and a price", () => {
    for (const skill of SKILLS) {
      const schema = skillInputJsonSchema(skill);
      expect(schema.type, skill.id).toBe("object");
      expect(Object.keys(schema.properties as object).length, skill.id).toBeGreaterThan(0);
      expect(Number.isInteger(skill.priceMicro), skill.id).toBe(true);
      expect(skill.priceMicro, skill.id).toBeGreaterThanOrEqual(0);
    }
  });

  it("prices reads that cost nothing to serve at zero, and work above it", () => {
    expect(resolveAgentSkill.priceMicro).toBe(0);
    expect(skillPriceUsdc(resolveAgentSkill)).toBe("0.000000");
    expect(reputationReportSkill.priceMicro).toBe(10_000);
    expect(skillPriceUsdc(reputationReportSkill)).toBe("0.010000");
    expect(settlementAuditSkill.priceMicro).toBe(20_000);
    expect(postJobSkill.priceMicro).toBe(50_000);
  });

  it("flags the one skill that returns something to be signed", () => {
    expect(postJobSkill.producesUnsignedTx).toBe(true);
    expect(SKILLS.filter((s) => s.producesUnsignedTx)).toHaveLength(1);
  });

  it("describes each skill well enough for another agent to route on it", () => {
    for (const skill of SKILLS) {
      expect(skill.description.length, skill.id).toBeGreaterThan(80);
      expect(skill.tags.length, skill.id).toBeGreaterThan(0);
      expect(skill.examples.length, skill.id).toBeGreaterThan(0);
    }
  });

  it("resolves by id", () => {
    expect(getSkill("ripar.reputation.report")).toBe(reputationReportSkill);
    expect(getSkill("nope")).toBeUndefined();
  });
});

describe("card and price table stay in step", () => {
  it("prices every advertised skill and advertises every priced skill", () => {
    const cardSkills = skillsAsCardSkills();
    const prices = skillPriceTable();
    expect(cardSkills.map((s) => s.id).sort()).toEqual(Object.keys(prices).sort());
  });

  it("carries the description and tags onto the card", () => {
    const card = skillsAsCardSkills().find((s) => s.id === "ripar.reputation.report")!;
    expect(card.name).toBe(reputationReportSkill.name);
    expect(card.description).toBe(reputationReportSkill.description);
    expect(card.tags).toEqual(reputationReportSkill.tags);
  });

  it("keeps price OFF the card skill object, where A2A has no field for it", () => {
    for (const card of skillsAsCardSkills()) {
      expect(card).not.toHaveProperty("price");
      expect(card).not.toHaveProperty("priceMicro");
    }
  });

  it("publishes a manifest with USDC and a schema per skill", () => {
    const manifest = skillsManifest("testnet");
    expect(manifest.asset).toEqual({ id: 10458941, symbol: "USDC", decimals: 6 });
    expect(manifest.skills).toHaveLength(4);
    expect(manifest.skills.find((s) => s.id === "ripar.validation.post-job")!.priceUsdc).toBe(
      "0.050000"
    );
    expect(manifest.skills.every((s) => (s.inputSchema as any).type === "object")).toBe(true);
  });

  it("uses the mainnet USDC id when asked for mainnet", () => {
    expect(skillsManifest("mainnet").asset.id).toBe(31566704);
  });
});

describe("ripar.identity.resolve", () => {
  it("returns the record when the agent exists", async () => {
    const ctx = ctxWith({
      // ag_ + uint64(1)
      "YWdfAAAAAAAAAAE=": AGENT_1_BOX,
    });
    const result = (await resolveAgentSkill.run({ agentId: 1 }, ctx)) as any;
    expect(result.found).toBe(true);
    expect(result.resolvedVia).toBe("id");
    expect(result.agent.domain).toBe("agent-1785821796525.ripar.io");
    expect(result.cardUrl).toBe("https://agent-1785821796525.ripar.io/.well-known/agent.json");
  });

  it("resolves through the dm_ index and says which route it took", async () => {
    const ctx = ctxWith({
      "ZG1fYWdlbnQtMTc4NTgyMTc5NjUyNS5yaXBhci5pbw==": "AAAAAAAAAAE=",
      "YWdfAAAAAAAAAAE=": AGENT_1_BOX,
    });
    const result = (await resolveAgentSkill.run(
      { domain: "agent-1785821796525.ripar.io" },
      ctx
    )) as any;
    expect(result.found).toBe(true);
    expect(result.resolvedVia).toBe("domain");
    expect(result.agent.agentId).toBe(1);
  });

  it("reports the registry's literal 0 as 'not found', not as an error", async () => {
    const result = (await resolveAgentSkill.run({ domain: "nobody.example" }, ctxWith({}))) as any;
    expect(result.found).toBe(false);
    expect(result.reason).toMatch(/returned 0/);
  });

  it("refuses to guess when given more than one lookup key", async () => {
    await expect(
      resolveAgentSkill.run({ agentId: 1, domain: "x.example" }, ctxWith({}))
    ).rejects.toThrow(/exactly one/);
    await expect(resolveAgentSkill.run({}, ctxWith({}))).rejects.toThrow(/exactly one/);
  });
});

describe("ripar.reputation.report", () => {
  it("distinguishes 'never been paid' from 'paid and scored zero'", async () => {
    const noScore = ctxWith({ "YWdfAAAAAAAAAAE=": AGENT_1_BOX });
    const result = (await reputationReportSkill.run({ agentId: 1 }, noScore)) as any;
    expect(result.found).toBe(true);
    expect(result.score).toBeNull();
    expect(result.summary).toMatch(/never been paid/);
  });

  it("summarises a real score box in USDC", async () => {
    const ctx = ctxWith({
      "YWdfAAAAAAAAAAE=": AGENT_1_BOX,
      "c2NfAAAAAAAAAAE=": SCORE_1_BOX,
    });
    const result = (await reputationReportSkill.run({ agentId: 1 }, ctx)) as any;
    expect(result.score.jobsPaid).toBe(1);
    expect(result.volumeUsdc).toBe("0.010000");
    expect(result.averagePaymentUsdc).toBe("0.010000");
    expect(result.summary).toBe("agent 1 has been paid 1 time(s) totalling 0.010000 USDC");
    // Nothing has been validated, so there is no dispute rate to report.
    expect(result.validation.disputeRate).toBeNull();
    expect(result.validation.note).toMatch(/no validator/);
  });

  it("says so when the agent is not registered at all", async () => {
    const result = (await reputationReportSkill.run({ agentId: 99 }, ctxWith({}))) as any;
    expect(result.found).toBe(false);
    expect(result.reason).toMatch(/not registered/);
  });
});

describe("ripar.settlement.audit", () => {
  it("reports what could be credited, and how", async () => {
    const registry = new RiparRegistry({
      fetch: (async (url: string) => {
        if (url.includes("/box?")) {
            // sc_ is the score read; anything else is the ad_ -> agent 1 index.
            // A bare uint64 is not a valid Score, so they cannot share a stub.
            const value = url.includes(encodeURIComponent("b64:c2Nf"))
              ? "AAAAAAAAAAEAAAAAAAAAAQAAAAAAACcQAAAAAAAAAAAAAAAAAAAAAAAAAABqcgkIAAAAAGpyCQg="
              : "AAAAAAAAAAE=";
            return new Response(JSON.stringify({ value }), { status: 200 });
          }
        if (url.includes("/boxes")) return new Response(JSON.stringify({ boxes: [] }), { status: 200 });
        if (url.includes("/v2/accounts/")) {
          return new Response(
            JSON.stringify({
              transactions: [
                {
                  id: "2FFXSG5JTVTNECCNZY4HMOZCKDILNQR3IT5R5PEUKJLNSLTJZHEA",
                  sender: "SOMECLIENT",
                  "asset-transfer-transaction": { amount: 10_000, receiver: AGENT_1_ADDRESS },
                },
              ],
            }),
            { status: 200 }
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as unknown as typeof fetch,
    });

    const result = (await settlementAuditSkill.run(
      { address: AGENT_1_ADDRESS, limit: 25 },
      { registry, config: registry.config }
    )) as any;

    expect(result.creditable.count).toBe(1);
    expect(result.creditable.totalUsdc).toBe("0.010000");
    // The CURRENT signature. accept_feedback takes the settling transfer as a
    // transaction in the group, not a txid and an amount as arguments — a
    // caller following the old one is rejected outright.
    expect(result.creditable.nextStep).toMatch(/accept_feedback\(payment: axfer/);
    // And it must not claim these are UNcredited. The chain records no
    // per-payment credit flag, so that is not a knowable thing to say.
    expect(result.creditable.note).toMatch(/could be credited, not what has not been/i);
    expect(result.score?.jobsPaid).toBe(1);
  });

  /**
   * Every agent's transfer history opens with a zero-amount opt-in it sent to
   * itself. `accept_feedback` asserts `amount_micro > 0` and that payer and
   * payee differ, so crediting one is impossible — reporting it as a gap gave
   * the caller a next step it could not follow.
   */
  it("does not count a zero-amount self opt-in as creditable", async () => {
    const registry = new RiparRegistry({
      fetch: (async (url: string) => {
        if (url.includes("/box?")) {
            // sc_ is the score read; anything else is the ad_ -> agent 1 index.
            // A bare uint64 is not a valid Score, so they cannot share a stub.
            const value = url.includes(encodeURIComponent("b64:c2Nf"))
              ? "AAAAAAAAAAEAAAAAAAAAAQAAAAAAACcQAAAAAAAAAAAAAAAAAAAAAAAAAABqcgkIAAAAAGpyCQg="
              : "AAAAAAAAAAE=";
            return new Response(JSON.stringify({ value }), { status: 200 });
          }
        if (url.includes("/boxes")) return new Response(JSON.stringify({ boxes: [] }), { status: 200 });
        if (url.includes("/v2/accounts/")) {
          return new Response(
            JSON.stringify({
              transactions: [
                {
                  // The ASA opt-in: from itself, to itself, for nothing.
                  id: "UUCUYI2QUSXNS7JFEVNSMOWDW4BRVMBOC4IEC2YQIUYKTKEJ2BYQ",
                  sender: AGENT_1_ADDRESS,
                  "asset-transfer-transaction": { amount: 0, receiver: AGENT_1_ADDRESS },
                },
              ],
            }),
            { status: 200 }
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as unknown as typeof fetch,
    });

    const result = (await settlementAuditSkill.run(
      { address: AGENT_1_ADDRESS, limit: 25 },
      { registry, config: registry.config }
    )) as any;

    expect(result.creditable.count).toBe(0);
    expect(result.creditable.nextStep).not.toMatch(/accept_feedback/);
    // It is reported as ineligible rather than silently dropped: the caller
    // sees the transfer and why it can never be credited.
    expect(result.ineligible.count).toBe(1);
    expect(result.ineligible.count).toBe(1);
    expect(result.ineligible.reason).toMatch(/opt-in/i);
  });
});

describe("ripar.validation.post-job input guards", () => {
  const config = resolveConfig({
    fetch: (async () => {
      throw new Error("the guards must fire before anything hits the network");
    }) as unknown as typeof fetch,
  });
  const ctx = { registry: new RiparRegistry(), config };

  it("rejects a spec hash that is not 32 bytes", async () => {
    await expect(
      postJobSkill.run(
        { sender: AGENT_1_ADDRESS, specHash: "aabb", budgetMicro: 1, validatorAgentId: 0 },
        ctx
      )
    ).rejects.toThrow(/32-byte sha256 digest/);
  });

  it("rejects a zero budget, which the contract would reject anyway", async () => {
    await expect(
      postJobSkill.run(
        {
          sender: AGENT_1_ADDRESS,
          specHash: "11".repeat(32),
          budgetMicro: 0,
          validatorAgentId: 0,
        },
        ctx
      )
    ).rejects.toThrow(/positive integer/);
  });

  it("rejects a spec hash that is not hex at all", async () => {
    await expect(
      postJobSkill.run(
        { sender: AGENT_1_ADDRESS, specHash: "zzzz", budgetMicro: 1, validatorAgentId: 0 },
        ctx
      )
    ).rejects.toThrow(/Not hex/);
  });
});
