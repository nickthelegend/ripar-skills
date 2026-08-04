/**
 * `ripar_agent_health` — the check somebody runs before paying a stranger.
 *
 * Every case here is one of the four ways a registered agent and its own card
 * can disagree, and the assertion is always about the WORDS as much as the
 * status, because this report is read by a model that then advises a human
 * about money. "unverified" quietly rounded to "fine" is the exact failure this
 * tool exists to prevent, so:
 *
 *   - an unreachable agent must come back `unreachable`, not `healthy` and not
 *     a vague "could not check";
 *   - a payTo that does not match the registry must come back `fail` and the
 *     summary must say not to pay;
 *   - a check that could not RUN must be `unknown`, and `unknown` must never
 *     produce a `healthy` verdict.
 *
 * The fetch is injected, which is the ONLY thing these tests replace. There is
 * no fixture mode inside the module, no "assume healthy" branch, and no cached
 * verdict — `test/live.test.ts` runs the same function against the real agent
 * over the real internet.
 */

import { describe, expect, it } from "vitest";
import algosdk from "algosdk";

import { agentHealth } from "../src/health.js";
import { REGISTRY_APP_IDS, resolveConfig } from "../src/config.js";
import { RiparRegistry } from "../src/registry.js";
import { uint64Bytes } from "../src/abi.js";

const APPS = REGISTRY_APP_IDS.testnet;
const AGENT_ADDRESS = "KBDRZK3BV2YFJJAVV3S5XQYDWU4RDDI6EDXXKMG3O4AEVPEDCETDKEISKQ";
const OTHER_ADDRESS = "B2DGXU2QSRHXNZJMP5FFFU77W5NUMZTZ3X3MSO3PJC4ZQ75CSDL5EKULI4";
const DOMAIN = "agent.example";

const AGENT_TYPE = "(uint64,string,address,uint64,uint64)";
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const nameB64 = (n: Uint8Array) => encodeURIComponent(`b64:${b64(n)}`);

function encodeAgent(agentId: number, domain: string, address: string): string {
  return b64(
    algosdk.ABIType.from(AGENT_TYPE).encode([
      BigInt(agentId),
      domain,
      address,
      1_785_861_974n,
      1_785_861_974n,
    ])
  );
}

type CardOpts = {
  agentId?: number | null;
  payTo?: string | null;
  price?: string;
  endpoint?: string;
};

function card(opts: CardOpts = {}) {
  const extensions: unknown[] = [];
  if (opts.payTo !== null) {
    extensions.push({
      uri: "https://ripar.io/a2a/ext/x402/v1",
      params: {
        network: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe",
        payTo: opts.payTo ?? AGENT_ADDRESS,
        asset: { id: 10458941, symbol: "USDC", decimals: 6 },
        prices: { summarize: opts.price ?? "10000" },
      },
    });
  }
  if (opts.agentId !== null) {
    extensions.push({
      uri: "https://ripar.io/a2a/ext/registry/v1",
      params: { chain: "algorand:testnet", agentId: opts.agentId ?? 1, identityApp: APPS.identity },
    });
  }
  return {
    name: "Example Agent",
    description: "Text utilities.",
    version: "0.1.0",
    url: opts.endpoint ?? `https://${DOMAIN}/a2a`,
    preferredTransport: "JSONRPC",
    protocolVersion: "1.0",
    capabilities: { streaming: true, extensions },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [{ id: "summarize", name: "Summarize", description: "Summarise text.", tags: ["text"] }],
  };
}

/**
 * A world with one registered agent and a configurable HTTP surface.
 *
 * `http` maps a URL to a Response (or an Error to throw). Anything not listed
 * 404s, which is what a real host does — and is how "no /health endpoint" gets
 * tested rather than assumed.
 */
function world(opts: {
  registryAddress?: string;
  http?: Record<string, () => Response | Promise<Response>>;
  onFetch?: (url: string) => void;
}) {
  const address = opts.registryAddress ?? AGENT_ADDRESS;
  const http = opts.http ?? {};

  const doFetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    opts.onFetch?.(u);

    if (u.includes("/v2/applications/")) {
      if (u.includes("/box?")) {
        const agName = new Uint8Array([...Buffer.from("ag_"), ...uint64Bytes(1)]);
        if (u.includes(nameB64(agName))) {
          return new Response(JSON.stringify({ value: encodeAgent(1, DOMAIN, address) }), {
            status: 200,
          });
        }
        const dmName = new Uint8Array([...Buffer.from("dm_"), ...Buffer.from(DOMAIN)]);
        if (u.includes(nameB64(dmName))) {
          return new Response(JSON.stringify({ value: b64(uint64Bytes(1)) }), { status: 200 });
        }
        return new Response("no box", { status: 404 });
      }
      return new Response(JSON.stringify({ params: { "global-state": [] } }), { status: 200 });
    }

    const handler = http[u];
    if (handler) return handler();
    void init;
    return new Response("<!DOCTYPE html>not found", { status: 404 });
  }) as unknown as typeof fetch;

  return {
    config: resolveConfig({ fetch: doFetch }),
    registry: new RiparRegistry({ fetch: doFetch }),
  };
}

const CARD_URL = `https://${DOMAIN}/.well-known/agent.json`;
const HEALTH_URL = `https://${DOMAIN}/health`;
const A2A_URL = `https://${DOMAIN}/a2a`;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A 402 with the requirements in the `payment-required` header, body empty. */
const headerChallenge = (payTo = AGENT_ADDRESS) =>
  new Response("{}", {
    status: 402,
    headers: {
      "content-type": "application/json",
      "payment-required": Buffer.from(
        JSON.stringify({
          x402Version: 2,
          accepts: [
            {
              scheme: "exact",
              network: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
              amount: "10000",
              asset: "10458941",
              payTo,
            },
          ],
        })
      ).toString("base64"),
    },
  });

const healthy = (over: Record<string, () => Response> = {}) => ({
  [CARD_URL]: () => json(card()),
  [HEALTH_URL]: () => json({ ok: true }),
  [A2A_URL]: () => headerChallenge(),
  ...over,
});

const find = (r: Awaited<ReturnType<typeof agentHealth>>, id: string) =>
  r.checks.find((c) => c.id === id)!;

// ---------------------------------------------------------------------------

describe("a healthy agent", () => {
  it("passes every check and says so", async () => {
    const { config, registry } = world({ http: healthy() });
    const report = await agentHealth(config, { agentId: 1 }, { registry });

    expect(report.verdict).toBe("healthy");
    expect(report.checks.every((c) => c.status === "pass")).toBe(true);
    expect(report.agent).toMatchObject({ agentId: 1, domain: DOMAIN, address: AGENT_ADDRESS });
    expect(report.summary).toMatch(/Everything checkable checked out/);
  });

  it("reads a 402 challenge out of the payment-required HEADER", async () => {
    // The live Ripar agent answers exactly this way: challenge in the header,
    // `{}` in the body. A checker that only read the body would call a correct
    // paywall broken.
    const { config, registry } = world({ http: healthy() });
    const check = find(await agentHealth(config, { agentId: 1 }, { registry }), "serves_402");
    expect(check.status).toBe("pass");
    expect(check.detail).toMatch(/challenge read from the header/);
  });

  it("resolves the agent by domain and by address, not just by id", async () => {
    const { config, registry } = world({ http: healthy() });
    for (const input of [{ domain: DOMAIN }, { agentId: 1 }]) {
      const report = await agentHealth(config, input, { registry });
      expect(report.agent.agentId).toBe(1);
    }
  });

  it("makes real requests to the card, the health path and the priced endpoint", async () => {
    const seen: string[] = [];
    const { config, registry } = world({ http: healthy(), onFetch: (u) => seen.push(u) });
    await agentHealth(config, { agentId: 1 }, { registry });
    expect(seen).toContain(CARD_URL);
    expect(seen).toContain(HEALTH_URL);
    expect(seen).toContain(A2A_URL);
  });
});

describe("an unreachable agent", () => {
  it("is reported as unreachable — never as a pass and never as agreement", async () => {
    const { config, registry } = world({
      http: {
        [CARD_URL]: () => {
          throw new Error("getaddrinfo ENOTFOUND agent.example");
        },
      },
    });
    const report = await agentHealth(config, { agentId: 1 }, { registry });

    expect(report.verdict).toBe("unreachable");
    expect(report.checks.some((c) => c.status === "pass")).toBe(false);
    expect(report.summary).toMatch(/UNREACHABLE/);
    expect(report.summary).toMatch(/not the same as failing/);
    expect(report.summary).toMatch(/certainly not agreement/);
  });

  it("still names the agent the registry holds, so the reader knows what is down", async () => {
    const { config, registry } = world({
      http: {
        [CARD_URL]: () => {
          throw new Error("connect ECONNREFUSED");
        },
      },
    });
    const report = await agentHealth(config, { agentId: 1 }, { registry });
    expect(report.agent.domain).toBe(DOMAIN);
    expect(report.agent.address).toBe(AGENT_ADDRESS);
    expect(find(report, "card_reachable").status).toBe("fail");
    // The comparisons that had nothing to compare against are `unknown`, which
    // is emphatically not `pass`.
    expect(find(report, "card_payto_matches_registry").status).toBe("unknown");
    expect(find(report, "card_agent_id_resolves").status).toBe("unknown");
  });
});

describe("an agent whose card does not match the registry", () => {
  it("FAILS when the card asks for payment at a different address", async () => {
    const { config, registry } = world({
      http: healthy({ [CARD_URL]: () => json(card({ payTo: OTHER_ADDRESS })) }),
    });
    const report = await agentHealth(config, { agentId: 1 }, { registry });
    const check = find(report, "card_payto_matches_registry");

    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/DIFFERENT ACCOUNT/);
    expect(check.detail).toContain(OTHER_ADDRESS);
    expect(check.detail).toContain(AGENT_ADDRESS);
    expect(check.detail).toMatch(/Do not pay/);
    expect(report.verdict).toBe("failing");
    expect(report.summary).toMatch(/Do not pay this agent/);
  });

  it("FAILS when the card claims an agent id that belongs to somebody else", async () => {
    const { config, registry } = world({
      http: healthy({ [CARD_URL]: () => json(card({ agentId: 99 })) }),
    });
    const report = await agentHealth(config, { agentId: 1 }, { registry });
    const check = find(report, "card_agent_id_resolves");

    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/claims to be agent 99/);
    expect(check.detail).toMatch(/impersonation/);
    expect(report.verdict).toBe("failing");
  });

  it("FAILS when the card makes no on-chain claim at all", async () => {
    const { config, registry } = world({
      http: healthy({ [CARD_URL]: () => json(card({ agentId: null })) }),
    });
    const check = find(await agentHealth(config, { agentId: 1 }, { registry }), "card_agent_id_resolves");
    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/NO on-chain identity claim/);
  });

  it("FAILS when the live challenge pays somewhere the card does not advertise", async () => {
    // The card says pay X, the endpoint's own 402 says pay Y. Whichever is
    // right, they cannot both be, and a caller following the challenge would
    // pay an address the registry never vouched for.
    const { config, registry } = world({
      http: healthy({ [A2A_URL]: () => headerChallenge(OTHER_ADDRESS) }),
    });
    const check = find(await agentHealth(config, { agentId: 1 }, { registry }), "serves_402");
    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/disagree about who gets the money/);
  });
});

describe("an agent whose paywall is not what its card says", () => {
  it("FAILS when a priced endpoint answers 200 to an unpaid request", async () => {
    const { config, registry } = world({
      http: healthy({ [A2A_URL]: () => json({ result: "here you go, free" }) }),
    });
    const check = find(await agentHealth(config, { agentId: 1 }, { registry }), "serves_402");
    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/answered 200, not 402/);
    expect(check.detail).toMatch(/paywall is off or the price on the card is fiction/);
  });

  it("FAILS when the 402 carries no readable requirements anywhere", async () => {
    const { config, registry } = world({
      http: healthy({ [A2A_URL]: () => json({ error: "pay up" }, 402) }),
    });
    const check = find(await agentHealth(config, { agentId: 1 }, { registry }), "serves_402");
    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/no readable payment requirements/);
  });

  it("SKIPS the paywall check for an agent that charges nothing", async () => {
    const { config, registry } = world({
      http: healthy({ [CARD_URL]: () => json(card({ price: "0" })) }),
    });
    const report = await agentHealth(config, { agentId: 1 }, { registry });
    const check = find(report, "serves_402");
    expect(check.status).toBe("skip");
    // A free agent is not a broken one — a skip must not drag the verdict down.
    expect(report.verdict).toBe("healthy");
  });

  it("marks the paywall UNKNOWN, not free, when the endpoint cannot be reached", async () => {
    const { config, registry } = world({
      http: healthy({
        [A2A_URL]: () => {
          throw new Error("socket hang up");
        },
      }),
    });
    const report = await agentHealth(config, { agentId: 1 }, { registry });
    const check = find(report, "serves_402");
    expect(check.status).toBe("unknown");
    expect(check.detail).toMatch(/not a pass/);
    expect(check.detail).toMatch(/not evidence the endpoint is free/);
    // Unknown must never read as healthy.
    expect(report.verdict).toBe("degraded");
  });
});

describe("the liveness probe", () => {
  it("tries /api/health when /health is not there", async () => {
    // The live Ripar agent's health route is at /api/health. Probing only
    // /health would report a working agent as having none.
    const { config, registry } = world({
      http: {
        [CARD_URL]: () => json(card()),
        [`https://${DOMAIN}/api/health`]: () => json({ ok: true }),
        [A2A_URL]: () => headerChallenge(),
      },
    });
    const check = find(await agentHealth(config, { agentId: 1 }, { registry }), "health_endpoint");
    expect(check.status).toBe("pass");
    expect(check.detail).toContain("/api/health");
  });

  it("is UNKNOWN, not fail, when no health path answers — and says a served card proves nothing", async () => {
    const { config, registry } = world({
      http: { [CARD_URL]: () => json(card()), [A2A_URL]: () => headerChallenge() },
    });
    const report = await agentHealth(config, { agentId: 1 }, { registry });
    const check = find(report, "health_endpoint");

    expect(check.status).toBe("unknown");
    expect(check.detail).toMatch(/liveness is UNVERIFIED/);
    expect(check.detail).toMatch(/CDN keeps serving a static document/);
    expect(report.verdict).toBe("degraded");
    expect(report.summary).toMatch(/Unverified, not verified/);
    // Every path it tried is reported, so the answer stays checkable.
    expect((check.evidence!.tried as unknown[]).length).toBe(2);
  });
});

describe("refusals", () => {
  it("refuses a domain that is not registered, rather than grading a card against itself", async () => {
    const { config, registry } = world({ http: healthy() });
    await expect(
      agentHealth(config, { domain: "stranger.example" }, { registry })
    ).rejects.toThrow(/not registered in the IdentityRegistry/);
  });

  it("refuses an agent id the registry does not have", async () => {
    const { config, registry } = world({ http: healthy() });
    await expect(agentHealth(config, { agentId: 42 }, { registry })).rejects.toThrow(
      /No agent 42 in the IdentityRegistry/
    );
  });

  it("refuses to run with nothing to look up", async () => {
    const { config, registry } = world({ http: healthy() });
    await expect(agentHealth(config, {}, { registry })).rejects.toThrow(
      /needs one of agentId, domain, or address/
    );
  });
});
