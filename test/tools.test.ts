/**
 * MCP tool tests.
 *
 * Two layers. The first asserts on the tool specs directly — names, JSON
 * Schema, read/write annotations — because those are the contract an MCP
 * client sees before it calls anything. The second boots the real server over
 * an in-memory transport and drives it with the real MCP client, so a schema
 * the SDK would reject fails here rather than in someone's Claude Desktop.
 */

import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { TOOLS, TOOL_NAMES, getTool, toolJsonSchema, toolCatalogue } from "../src/mcp/tools.js";
import { createRiparMcpServer, SERVER_NAME } from "../src/mcp/server.js";
import { RiparRegistry } from "../src/registry.js";

const REQUIRED_TOOLS = [
  "ripar_search_agents",
  "ripar_get_agent",
  "ripar_get_reputation",
  "ripar_list_jobs",
  "ripar_post_job",
  "ripar_fund_job",
  "ripar_settle_escrow",
  "ripar_quote_endpoint",
  "ripar_call_endpoint",
  "ripar_settlements",
] as const;

const props = (name: string) =>
  (toolJsonSchema(getTool(name)!).properties ?? {}) as Record<string, unknown>;
const required = (name: string) => (toolJsonSchema(getTool(name)!).required ?? []) as string[];

describe("the tool set", () => {
  it("exposes exactly the ten advertised tools", () => {
    expect([...TOOL_NAMES].sort()).toEqual([...REQUIRED_TOOLS].sort());
  });

  it("gives every tool a title and a description long enough to route on", () => {
    for (const tool of TOOLS) {
      expect(tool.title.length).toBeGreaterThan(0);
      // A model picks a tool from this string; a one-liner is not enough.
      expect(tool.description.length).toBeGreaterThan(80);
    }
  });

  it("has no duplicate names", () => {
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
  });
});

describe("read/write annotations", () => {
  it("marks the six chain reads read-only", () => {
    for (const name of [
      "ripar_search_agents",
      "ripar_get_agent",
      "ripar_get_reputation",
      "ripar_list_jobs",
      "ripar_settlements",
      "ripar_quote_endpoint",
    ]) {
      expect(getTool(name)!.annotations.readOnlyHint, name).toBe(true);
    }
  });

  it("does NOT mark the four tools that can move money or state read-only", () => {
    // A client is entitled to prompt for confirmation on exactly these.
    for (const name of [
      "ripar_call_endpoint",
      "ripar_post_job",
      "ripar_fund_job",
      "ripar_settle_escrow",
    ]) {
      expect(getTool(name)!.annotations.readOnlyHint, name).toBe(false);
    }
  });

  it("marks every tool open-world, because all of them touch the network", () => {
    expect(TOOLS.every((t) => t.annotations.openWorldHint)).toBe(true);
  });
});

describe("tool input schemas", () => {
  it("ripar_search_agents takes an optional query and a bounded limit", () => {
    const schema = toolJsonSchema(getTool("ripar_search_agents")!);
    expect(Object.keys(schema.properties as object).sort()).toEqual([
      "limit",
      "query",
      "withReputation",
    ]);
    // Everything is optional: listing all agents must not require a query.
    expect(schema.required ?? []).toEqual([]);
    expect((props("ripar_search_agents").limit as any).maximum).toBe(100);
  });

  it("ripar_get_agent accepts all three lookup keys, none of them mandatory", () => {
    expect(Object.keys(props("ripar_get_agent")).sort()).toEqual([
      "address",
      "agentId",
      "domain",
      "includeJobs",
      "includeReputation",
    ]);
    expect(required("ripar_get_agent")).toEqual([]);
    // An Algorand address is exactly 58 characters; anything else is a typo.
    expect((props("ripar_get_agent").address as any).minLength).toBe(58);
    expect((props("ripar_get_agent").address as any).maxLength).toBe(58);
  });

  it("ripar_get_reputation requires an agent id", () => {
    expect(required("ripar_get_reputation")).toEqual(["agentId"]);
    const agentId = props("ripar_get_reputation").agentId as any;
    expect(agentId.type).toBe("integer");
    // Agent ids start at 1 — the contract uses 0 as its "not found" value.
    expect(agentId.exclusiveMinimum).toBe(0);
  });

  it("ripar_list_jobs constrains status to the contract's own lifecycle", () => {
    expect((props("ripar_list_jobs").status as any).enum).toEqual([
      "open",
      "assigned",
      "submitted",
      "validated",
      "disputed",
      "cancelled",
    ]);
    expect(required("ripar_list_jobs")).toEqual([]);
  });

  it("ripar_post_job requires everything a transaction cannot be composed without", () => {
    expect(required("ripar_post_job").sort()).toEqual(["budgetMicro", "sender", "specHash"]);
    // The contract asserts budget > 0; the schema says so before the fee is spent.
    expect((props("ripar_post_job").budgetMicro as any).exclusiveMinimum).toBe(0);
    // The optional one defaults, rather than being silently absent.
    expect((props("ripar_post_job").validatorAgentId as any).default).toBe(0);
    expect((props("ripar_post_job").validatorAgentId as any).minimum).toBe(0);
    expect((props("ripar_post_job").sender as any).minLength).toBe(58);
  });

  it("ripar_fund_job requires the client, the job and an amount above zero", () => {
    expect(required("ripar_fund_job").sort()).toEqual(["amountMicro", "jobId", "sender"]);
    // The contract asserts asset_amount > 0; the schema says so before the fee.
    expect((props("ripar_fund_job").amountMicro as any).exclusiveMinimum).toBe(0);
    expect((props("ripar_fund_job").sender as any).minLength).toBe(58);
    expect((props("ripar_fund_job").jobId as any).exclusiveMinimum).toBe(0);
  });

  it("ripar_settle_escrow offers exactly the two directions the contract has", () => {
    expect(required("ripar_settle_escrow").sort()).toEqual(["action", "jobId", "sender"]);
    // Not free text: the contract has release_escrow and refund_escrow, and a
    // third word would compose a call that does not exist.
    expect((props("ripar_settle_escrow").action as any).enum).toEqual(["release", "refund"]);
  });

  it("says out loud, in both escrow tools, who may sign and when", () => {
    const settle = getTool("ripar_settle_escrow")!.description;
    // The dispute-window path is the non-obvious rule, and the one a caller
    // most needs before it decides whether to wait.
    expect(settle).toMatch(/dispute window/i);
    expect(settle).toMatch(/anyone/i);
    expect(settle.toLowerCase()).toContain("client");
    // Funding is a group, and a caller that signs one half has done nothing.
    expect(getTool("ripar_fund_job")!.description).toMatch(/group/i);
  });

  it("ripar_quote_endpoint and ripar_call_endpoint both require a real url", () => {
    for (const name of ["ripar_quote_endpoint", "ripar_call_endpoint"]) {
      expect(required(name), name).toContain("url");
      expect((props(name).url as any).format, name).toBe("uri");
      expect((props(name).method as any).enum, name).toEqual(["GET", "POST"]);
    }
  });

  it("only ripar_call_endpoint can carry a payment, and it is never required", () => {
    expect(props("ripar_call_endpoint")).toHaveProperty("paymentHeader");
    expect(required("ripar_call_endpoint")).not.toContain("paymentHeader");
    expect(props("ripar_quote_endpoint")).not.toHaveProperty("paymentHeader");
  });

  it("ripar_settlements can be addressed by agent id or by address", () => {
    expect(Object.keys(props("ripar_settlements")).sort()).toEqual(["address", "agentId", "limit"]);
    expect(required("ripar_settlements")).toEqual([]);
  });

  it("describes every property, since the description is all a model has to go on", () => {
    for (const tool of TOOLS) {
      const schema = toolJsonSchema(tool);
      for (const [key, value] of Object.entries((schema.properties ?? {}) as object)) {
        expect((value as any).description, `${tool.name}.${key}`).toBeTruthy();
      }
    }
  });
});

describe("toolCatalogue", () => {
  it("mirrors the tool set, for embedding in an A2A card", () => {
    const catalogue = toolCatalogue();
    expect(catalogue.map((t) => t.name)).toEqual(TOOL_NAMES);
    expect(catalogue.filter((t) => t.readOnly)).toHaveLength(6);
    // Six reads and four that compose or spend: a client showing a
    // confirmation prompt for the second group is showing it for four things.
    expect(catalogue.filter((t) => !t.readOnly)).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// The real server, over the real protocol.
// ---------------------------------------------------------------------------

async function connect(registry?: RiparRegistry) {
  const server = createRiparMcpServer(registry ? { registry } : {});
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe("the MCP server over an in-memory transport", () => {
  it("lists all ten tools with their schemas", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...REQUIRED_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description).toBeTruthy();
    }
  });

  it("reports the server identity a client shows the user", async () => {
    const { client } = await connect();
    expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
    expect(client.getInstructions()).toMatch(/holds no private key/);
  });

  it("rejects a call whose arguments do not match the schema", async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: "ripar_get_reputation",
      arguments: { agentId: "not a number" },
    });
    expect(result.isError).toBe(true);
  });

  it("returns a real chain read as JSON content", async () => {
    // The `ag_` box for agent 1, captured from IdentityRegistry 768572968 — a
    // real record, served without a network so the assertions can be exact.
    const registry = new RiparRegistry({
      fetch: (async (url: string) => {
        if (url.includes("/box?")) {
          return new Response(
            JSON.stringify({
              value:
                "AAAAAAAAAAEAOlBHHKthrrBUpBWu5dvDA7U5EY0eIO91MNt3AEq8gxEmAAAAAGpyF1YAAAAAanIXVgAWcmlwYXItYWdlbnQudmVyY2VsLmFwcA==",
            }),
            { status: 200 }
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as unknown as typeof fetch,
    });
    const { client } = await connect(registry);
    const result = (await client.callTool({
      name: "ripar_get_agent",
      arguments: { agentId: 1, includeReputation: false },
    })) as { content: { type: string; text: string }[]; isError?: boolean };

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.found).toBe(true);
    expect(parsed.agent.domain).toBe("ripar-agent.vercel.app");
    expect(parsed.cardUrl).toBe("https://ripar-agent.vercel.app/.well-known/agent.json");
  });

  it("reports escrow next to budget on ripar_list_jobs, for one job and for the list", async () => {
    // jb_1 with a 1.0 budget and no es_ box: the unfunded case, which is the
    // one a bidding agent has to be able to see.
    const JOB_BOX =
      "AAAAAAAAAAFQRxyrYa6wVKQVruXbwwO1ORGNHiDvdTDbdwBKvIMRJgAAAAAAAAABAAAAAAAAAAIAAAAAAA9CQABcAH4AAAAAAAAAAwAAAABqchdmAAAAAGpyF3cAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHACAJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQ==";
    const registry = new RiparRegistry({
      fetch: (async (url: string) => {
        if (/\/v2\/applications\/\d+$/.test(url)) {
          const g = (key: string, uint: number) => ({
            key: Buffer.from(key, "utf8").toString("base64"),
            value: { uint, type: 2 },
          });
          return new Response(
            JSON.stringify({
              params: {
                "global-state": [
                  g("job_count", 1),
                  g("escrow_asset", 768_547_363),
                  g("dispute_window", 20),
                  g("identity_app", 768_572_968),
                  g("reputation_app", 768_572_969),
                ],
              },
            }),
            { status: 200 }
          );
        }
        if (url.includes("/boxes")) {
          const prefix = decodeURIComponent(new URL(url).searchParams.get("prefix") ?? "");
          // Only a jb_ box exists. No es_ box means nothing is escrowed.
          const boxes = prefix.includes(Buffer.from("jb_").toString("base64"))
            ? [{ name: "amJfAAAAAAAAAAE=" }]
            : [];
          return new Response(JSON.stringify({ boxes }), { status: 200 });
        }
        if (url.includes("/box?")) {
          return url.includes(encodeURIComponent("b64:amJf"))
            ? new Response(JSON.stringify({ value: JOB_BOX }), { status: 200 })
            : new Response("no box", { status: 404 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as unknown as typeof fetch,
    });

    const { client } = await connect(registry);
    const call = async (args: Record<string, unknown>) => {
      const result = (await client.callTool({ name: "ripar_list_jobs", arguments: args })) as {
        content: { text: string }[];
        isError?: boolean;
      };
      expect(result.isError).toBeFalsy();
      return JSON.parse(result.content[0]!.text);
    };

    const list = await call({});
    expect(list.jobs[0].budgetUsdc).toBe("1.000000");
    expect(list.jobs[0].escrowUsdc).toBe("0.000000");
    expect(list.jobs[0].funded).toBe(false);
    expect(list.escrow.fundedJobs).toBe(0);
    expect(list.escrow.assetId).toBe(768_547_363);
    // The distinction is stated, not just numbered — this string is what a
    // model reads before it decides the budget means it will be paid.
    expect(list.escrow.note).toMatch(/budget is what the client says/i);

    const one = await call({ jobId: 1 });
    expect(one.job.escrowMicro).toBe(0);
    expect(one.job.budgetMicro).toBe(1_000_000);
    expect(one.job.unfundedMicro).toBe(1_000_000);
  });

  it("surfaces a failed chain read as an error, never as an empty result", async () => {
    const registry = new RiparRegistry({
      fetch: (async () =>
        new Response("down", {
          status: 503,
          statusText: "Service Unavailable",
        })) as unknown as typeof fetch,
    });
    const { client } = await connect(registry);
    const result = (await client.callTool({
      name: "ripar_get_reputation",
      arguments: { agentId: 1 },
    })) as { content: { type: string; text: string }[]; isError?: boolean };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.error).toMatch(/503/);
    // The wording matters: a model must not read this as "no such agent".
    expect(parsed.note).toMatch(/not an empty result/);
  });

  it("returns an UNSIGNED transaction from ripar_post_job and submits nothing", async () => {
    const submitted: string[] = [];
    const registry = new RiparRegistry({
      fetch: (async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") submitted.push(url);
        if (url.endsWith("/v2/transactions/params")) {
          return new Response(
            JSON.stringify({
              fee: 0,
              "min-fee": 1000,
              "last-round": 65_000_000,
              "genesis-id": "testnet-v1.0",
              "genesis-hash": "SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
            }),
            { status: 200 }
          );
        }
        if (/\/v2\/applications\/\d+$/.test(url)) {
          // 41 is deliberately a number the live chain will not be at, so a
          // test that accidentally reached the real network would fail below
          // rather than pass on real data.
          return new Response(
            JSON.stringify({
              params: { "global-state": [{ key: "am9iX2NvdW50", value: { uint: 41 } }] },
            }),
            { status: 200 }
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as unknown as typeof fetch,
    });

    const { client } = await connect(registry);
    const result = (await client.callTool({
      name: "ripar_post_job",
      arguments: {
        sender: "UBB4PNTT7CI3IQS25ZMQR4DGVYYCBORNSBLU4WKUGX4BAZ3KN4O2KATPAU",
        specHash: "5d6a7c053dae8e0130414cd7ca3b7b079d288f2afcfd69da5eadd44f16ce48f6",
        budgetMicro: 2_500_000,
        validatorAgentId: 1,
      },
    })) as { content: { type: string; text: string }[]; isError?: boolean };

    expect(result.isError).toBeFalsy();
    const tx = JSON.parse(result.content[0]!.text);
    expect(tx.signed).toBe(false);
    expect(tx.unsignedTxnBase64).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(tx.method).toBe("post_job(byte[],uint64,uint64)uint64");
    // job_count is 41, so this composes job 42 and references the box it will
    // write — post_job stores jb_<count + 1>, a box that does not exist yet.
    expect(tx.args.expectedJobId).toBe(42);
    expect(tx.boxes).toEqual(["jb_42"]);
    expect(tx.summary).toContain("2.500000 USDC");
    expect(tx.nextSteps.join(" ")).toMatch(/holds no key/);
    // The whole point: nothing was broadcast.
    expect(submitted).toEqual([]);
  });

  it("hands back the 402 challenge instead of paying it", async () => {
    const registry = new RiparRegistry({
      fetch: (async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers as HeadersInit);
        // Assert the server did not invent a payment header.
        expect(headers.get("X-PAYMENT")).toBeNull();
        return new Response(
          JSON.stringify({
            x402Version: 2,
            accepts: [
              {
                scheme: "exact",
                network: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe",
                maxAmountRequired: "50000",
                payTo: "UBB4PNTT7CI3IQS25ZMQR4DGVYYCBORNSBLU4WKUGX4BAZ3KN4O2KATPAU",
                asset: "10458941",
              },
            ],
          }),
          { status: 402 }
        );
      }) as unknown as typeof fetch,
    });
    const { client } = await connect(registry);
    const result = (await client.callTool({
      name: "ripar_call_endpoint",
      arguments: { url: "https://paid.example/run" },
    })) as { content: { type: string; text: string }[] };

    const body = JSON.parse(result.content[0]!.text);
    expect(body.paymentRequired).toBe(true);
    expect(body.quote.price.amountAtomic).toBe("50000");
    expect(body.quote.price.amountDisplay).toBe("0.050000 USDC");
    expect(body.note).toMatch(/holds no key and cannot pay/);
  });
});
