/**
 * MCP resources and prompts, over the real protocol.
 *
 * These drive the actual MCP client against the actual server on an in-memory
 * transport, because the interesting failures are protocol-shaped: a resource
 * that never appears in `resources/list`, a template with no list callback so a
 * client can only show a URI pattern, a prompt whose arguments the SDK rejects.
 * None of those show up in a unit test of the handler.
 *
 * The chain is stubbed. What is being tested is the surface, not the decoding —
 * `live.test.ts` reads the same boxes off TestNet.
 */

import { describe, expect, it } from "vitest";
import algosdk from "algosdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createRiparMcpServer } from "../src/mcp/server.js";
import { RESOURCE_URIS } from "../src/mcp/resources.js";
import { PROMPTS, PROMPTS_REFERENCE_TOOLS } from "../src/mcp/prompts.js";
import { TOOL_NAMES } from "../src/mcp/tools.js";
import { RiparRegistry } from "../src/registry.js";
import { REGISTRY_APP_IDS } from "../src/config.js";
import { escrowBoxName, jobBoxName, uint64Bytes } from "../src/abi.js";

const APPS = REGISTRY_APP_IDS.testnet;
const CLIENT_ADDR = "KBDRZK3BV2YFJJAVV3S5XQYDWU4RDDI6EDXXKMG3O4AEVPEDCETDKEISKQ";
const ESCROW_ASSET = 768_547_363;

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const agentBox = (id: number, domain: string) =>
  b64(
    algosdk.ABIType.from("(uint64,string,address,uint64,uint64)").encode([
      BigInt(id),
      domain,
      CLIENT_ADDR,
      1_785_861_974n,
      1_785_861_974n,
    ])
  );
const jobBox = (id: number, budget: number, status: number) =>
  b64(
    algosdk.ABIType.from(
      "(uint64,address,uint64,uint64,uint64,byte[],byte[],uint64,uint64,uint64)"
    ).encode([
      BigInt(id),
      CLIENT_ADDR,
      1n,
      2n,
      BigInt(budget),
      new Uint8Array(32).fill(7),
      new Uint8Array(32).fill(9),
      BigInt(status),
      1_785_861_990n,
      1_785_862_007n,
    ])
  );

/** Two agents, two jobs, one of them funded. */
function stubbedRegistry() {
  return new RiparRegistry({
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
                g("agent_count", 2),
                g("job_count", 2),
                g("escrow_asset", ESCROW_ASSET),
                g("dispute_window", 20),
                g("identity_app", APPS.identity),
                g("reputation_app", APPS.reputation),
              ],
            },
          }),
          { status: 200 }
        );
      }

      if (url.includes("/boxes")) {
        const prefix = decodeURIComponent(new URL(url).searchParams.get("prefix") ?? "");
        const of = (names: Uint8Array[]) =>
          new Response(
            JSON.stringify({ boxes: names.map((n) => ({ name: b64(n) })) }),
            { status: 200 }
          );
        if (prefix.includes(Buffer.from("ag_").toString("base64"))) {
          return of([
            new Uint8Array([...Buffer.from("ag_"), ...uint64Bytes(1)]),
            new Uint8Array([...Buffer.from("ag_"), ...uint64Bytes(2)]),
          ]);
        }
        if (prefix.includes(Buffer.from("es_").toString("base64"))) {
          return of([escrowBoxName(2)]);
        }
        if (prefix.includes(Buffer.from("jb_").toString("base64"))) {
          return of([jobBoxName(1), jobBoxName(2)]);
        }
        return of([]);
      }

      if (url.includes("/box?")) {
        const name = decodeURIComponent(new URL(url).searchParams.get("name") ?? "");
        const is = (n: Uint8Array) => name === `b64:${b64(n)}`;
        if (is(new Uint8Array([...Buffer.from("ag_"), ...uint64Bytes(1)]))) {
          return new Response(
            JSON.stringify({ value: agentBox(1, "ripar-agent.vercel.app") }),
            { status: 200 }
          );
        }
        if (is(new Uint8Array([...Buffer.from("ag_"), ...uint64Bytes(2)]))) {
          return new Response(JSON.stringify({ value: agentBox(2, "client.ripar.io") }), {
            status: 200,
          });
        }
        if (is(jobBoxName(1))) {
          return new Response(JSON.stringify({ value: jobBox(1, 1_000_000, 3) }), { status: 200 });
        }
        if (is(jobBoxName(2))) {
          return new Response(JSON.stringify({ value: jobBox(2, 500_000, 0) }), { status: 200 });
        }
        if (is(escrowBoxName(2))) {
          return new Response(JSON.stringify({ value: b64(uint64Bytes(500_000)) }), {
            status: 200,
          });
        }
        return new Response("no box", { status: 404 });
      }

      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch,
  });
}

async function connect() {
  const server = createRiparMcpServer({ registry: stubbedRegistry() });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const read = async (client: Client, uri: string) => {
  const result = await client.readResource({ uri });
  return JSON.parse((result.contents[0] as { text: string }).text);
};

// ---------------------------------------------------------------------------

describe("resources/list", () => {
  it("advertises the resources capability at all", async () => {
    const client = await connect();
    // Without this a client never calls resources/list, so everything below
    // would be unreachable however correct the handlers are.
    expect(client.getServerCapabilities()?.resources).toBeDefined();
  });

  it("lists the fixed documents", async () => {
    const client = await connect();
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain(RESOURCE_URIS.agents);
    expect(uris).toContain(RESOURCE_URIS.jobs);
    expect(uris).toContain(RESOURCE_URIS.registries);
  });

  it("enumerates the templated ones from the chain, so ids never have to be guessed", async () => {
    const client = await connect();
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    // Both agents and both jobs, listed individually because the templates
    // carry a list callback that reads the registry.
    expect(uris).toContain("ripar://agent/1");
    expect(uris).toContain("ripar://agent/2");
    expect(uris).toContain("ripar://job/1");
    expect(uris).toContain("ripar://job/2");

    const agent = resources.find((r) => r.uri === "ripar://agent/1")!;
    expect(agent.title).toContain("ripar-agent.vercel.app");
    // A job's listing entry carries both money numbers, so the difference is
    // visible in a picker before anything is opened.
    const job = resources.find((r) => r.uri === "ripar://job/2")!;
    expect(job.title).toMatch(/budget 0\.500000/);
    expect(job.title).toMatch(/escrow 0\.500000/);
  });

  it("offers the templates themselves, for ids that are not listed yet", async () => {
    const client = await connect();
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual(
      expect.arrayContaining([RESOURCE_URIS.agent, RESOURCE_URIS.job])
    );
  });
});

describe("resources/read", () => {
  it("ripar://agents returns the roster with card urls", async () => {
    const body = await read(await connect(), RESOURCE_URIS.agents);
    expect(body.total).toBe(2);
    expect(body.agents[0].domain).toBe("ripar-agent.vercel.app");
    expect(body.agents[0].cardUrl).toBe(
      "https://ripar-agent.vercel.app/.well-known/agent.json"
    );
  });

  it("ripar://jobs reports budget and escrow separately for every job", async () => {
    const body = await read(await connect(), RESOURCE_URIS.jobs);
    const unfunded = body.jobs.find((j: { jobId: number }) => j.jobId === 1);
    const funded = body.jobs.find((j: { jobId: number }) => j.jobId === 2);

    // Job 1 has a budget and no money behind it. That is the case the whole
    // feature exists for.
    expect(unfunded.budgetUsdc).toBe("1.000000");
    expect(unfunded.escrowUsdc).toBe("0.000000");
    expect(unfunded.funded).toBe(false);

    expect(funded.escrowUsdc).toBe("0.500000");
    expect(funded.fullyFunded).toBe(true);
    expect(body.escrow.fundedJobs).toBe(1);
    expect(body.escrow.totalEscrowedUsdc).toBe("0.500000");
    expect(body.escrow.assetId).toBe(ESCROW_ASSET);
  });

  it("ripar://job/2 carries the escrow and links to the agents on it", async () => {
    const body = await read(await connect(), "ripar://job/2");
    expect(body.found).toBe(true);
    expect(body.job.escrowMicro).toBe(500_000);
    expect(body.server).toBe("ripar://agent/1");
    expect(body.validator).toBe("ripar://agent/2");
    // Job 2 is still open, so no verdict exists and there is no window to
    // report. Quoting one would be a deadline computed from nothing.
    expect(body.escrow.anyoneMayReleaseAfter).toBeUndefined();
  });

  it("ripar://job/1 explains the release window, because it has a verdict", async () => {
    const body = await read(await connect(), "ripar://job/1");
    expect(body.job.status).toBe("validated");
    // updated_at 1785862007 + a 20 second window.
    expect(body.escrow.anyoneMayReleaseAfter).toBe(
      new Date((1_785_862_007 + 20) * 1000).toISOString()
    );
  });

  it("ripar://agent/1 carries the jobs it is on, with their escrow", async () => {
    const body = await read(await connect(), "ripar://agent/1");
    expect(body.found).toBe(true);
    expect(body.agent.domain).toBe("ripar-agent.vercel.app");
    // No sc_ box in the stub, so it has never been paid — null, not zeros.
    expect(body.score).toBeNull();
    expect(body.scoreNote).toMatch(/never been paid/);
    expect(body.jobs.map((j: { jobId: number }) => j.jobId)).toEqual([2, 1]);
  });

  it("says an unknown id is unknown instead of inventing a record", async () => {
    const body = await read(await connect(), "ripar://agent/99");
    expect(body.found).toBe(false);
    expect(body.reason).toMatch(/no record/i);
  });

  it("ripar://registries reads the escrow terms off the contract's global state", async () => {
    const body = await read(await connect(), RESOURCE_URIS.registries);
    expect(body.apps.validation.appId).toBe(APPS.validation);
    expect(body.escrow.assetId).toBe(ESCROW_ASSET);
    expect(body.escrow.disputeWindowSecs).toBe(20);
    expect(body.escrow.heldBy).toBe(
      algosdk.getApplicationAddress(APPS.validation).toString()
    );
    expect(body.bootstrappedTo.identityApp).toBe(APPS.identity);
  });

  it("fails a read that cannot be answered, rather than answering emptily", async () => {
    const client = await connect();
    await expect(client.readResource({ uri: "ripar://job/not-a-number" })).rejects.toThrow();
  });
});

describe("prompts", () => {
  it("advertises the prompts capability", async () => {
    const client = await connect();
    expect(client.getServerCapabilities()?.prompts).toBeDefined();
  });

  it("lists every prompt with its arguments", async () => {
    const client = await connect();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(
      [...PROMPTS.map((p) => p.name)].sort()
    );
    for (const prompt of prompts) {
      expect(prompt.description, prompt.name).toBeTruthy();
      expect(prompt.arguments?.length, prompt.name).toBeGreaterThan(0);
    }
  });

  it("names only tools this server actually registers", () => {
    // A prompt that sends a model after a tool that does not exist gets
    // improvisation instead of a chain read — which, for "has this agent been
    // paid", means an invented track record.
    for (const name of PROMPTS_REFERENCE_TOOLS) {
      expect(TOOL_NAMES, `prompt references ${name}`).toContain(name);
    }
  });

  it("renders vet_agent with the agent substituted in, in the order that matters", async () => {
    const client = await connect();
    const result = await client.getPrompt({
      name: "vet_agent",
      arguments: { agent: "ripar-agent.vercel.app", endpoint: "https://paid.example/run" },
    });
    const text = (result.messages[0]!.content as { text: string }).text;
    // The opening line specifically, not just somewhere in the body: a prompt
    // that says "vet the agent" and only names the real one four steps down
    // reads as a generic instruction, and a model will treat it as one.
    expect(text.split("\n")[0]).toContain("ripar-agent.vercel.app");
    expect(text).toContain("https://paid.example/run");
    // Reputation before settlements: the point of the flow is that the score is
    // checked against money that moved, not read on its own.
    expect(text.indexOf("ripar_get_reputation")).toBeLessThan(text.indexOf("ripar_settlements"));
    // And it has to be allowed to conclude no.
    expect(text).toMatch(/not enough evidence/i);
  });

  it("drops the endpoint step when no endpoint was given", async () => {
    const client = await connect();
    const result = await client.getPrompt({
      name: "vet_agent",
      arguments: { agent: "1" },
    });
    const text = (result.messages[0]!.content as { text: string }).text;
    expect(text).not.toContain("undefined");
  });

  it("post_and_fund_job says a budget is not money until it is funded", async () => {
    const client = await connect();
    const result = await client.getPrompt({
      name: "post_and_fund_job",
      arguments: {
        sender: CLIENT_ADDR,
        specHash: "07".repeat(32),
        budgetUsdc: "2.50",
      },
    });
    const text = (result.messages[0]!.content as { text: string }).text;
    expect(text).toContain("2.50");
    expect(text).toMatch(/commits NO money/);
    expect(text).toContain("ripar_fund_job");
    // Composing is not submitting, and the flow has to say so.
    expect(text).toMatch(/unsigned/i);
  });

  it("settle_job_escrow states the release rule including the dispute-window path", async () => {
    const client = await connect();
    const result = await client.getPrompt({
      name: "settle_job_escrow",
      arguments: { jobId: "2", sender: CLIENT_ADDR },
    });
    const text = (result.messages[0]!.content as { text: string }).text;
    expect(text).toMatch(/validated -> release/);
    expect(text).toMatch(/disputed or cancelled -> refund/);
    expect(text).toMatch(/dispute window/i);
    expect(text).toContain("ripar_settle_escrow");
  });

  it("rejects a prompt whose required arguments are missing", async () => {
    const client = await connect();
    await expect(
      client.getPrompt({ name: "settle_job_escrow", arguments: { jobId: "2" } })
    ).rejects.toThrow();
  });
});
