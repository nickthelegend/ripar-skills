/**
 * Bidding, key rotation, and the guard that stands between them and a
 * transaction the chain would reject.
 *
 * `place_bid`, `accept_bid` and `rotate_address` were AHEAD of the chain for
 * most of this project's life: they compiled, and no deployed registry routed
 * them. Registries 769444119 / 769444120 / 769444121, deployed 2026-08-05,
 * route all 36 compiled methods, so that gap is closed.
 *
 * The file still has two jobs, and the second is still the important one:
 *
 *   1. When the method IS routed, the composed transaction has to be right —
 *      right selector, right args, right boxes, right foreign apps.
 *   2. When it is NOT, the tool has to REFUSE, in a sentence that names the
 *      method and says what to do instead. Not compose-and-hope, not a generic
 *      failure, and above all not a mock that returns a plausible transaction.
 *
 * The second half used to be free, because the live registries really were
 * missing those methods. It now has to be provoked with PRE_BIDDING_VALIDATION
 * and PRE_ROTATION_IDENTITY below — a guard nothing ever forces to say no is a
 * guard nobody has tested, and anyone pointing an old config at a current tool
 * still lands on that path.
 *
 * The stub algod below serves an approval program built from a chosen set of
 * selectors, which is how both halves get tested against the same code path
 * that runs in production. `test/live.test.ts` runs the same check against the
 * REAL programs, so a config pointed at an older generation is noticed there.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import algosdk from "algosdk";

import {
  BID_TYPE,
  bidBoxName,
  bidKeyFromBoxName,
  bidPrefixForJob,
  decodeBidBox,
  jobBoxName,
  uint64Bytes,
} from "../src/abi.js";
import { RiparRegistry } from "../src/registry.js";
import { REGISTRY_APP_IDS, resolveConfig, type RiparConfig } from "../src/config.js";
import {
  CONTRACT_METHODS,
  MethodNotDeployedError,
  clearDeployedCache,
  deploymentReport,
  isMethodDeployed,
  selectorOf,
} from "../src/deployed.js";
import {
  composeAcceptBid,
  composePlaceBid,
  composeRotateAddress,
  hashPitch,
} from "../src/unsigned.js";
import { getTool } from "../src/mcp/tools.js";

const APPS = REGISTRY_APP_IDS.testnet;

const CLIENT = "KBDRZK3BV2YFJJAVV3S5XQYDWU4RDDI6EDXXKMG3O4AEVPEDCETDKEISKQ";
const BIDDER = "UBB4PNTT7CI3IQS25ZMQR4DGVYYCBORNSBLU4WKUGX4BAZ3KN4O2KATPAU";
const STRANGER = "B2DGXU2QSRHXNZJMP5FFFU77W5NUMZTZ3X3MSO3PJC4ZQ75CSDL5EKULI4";
const FRESH = "7777777777777777777777777777777777777777777777777774MSJUVU";

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const nameB64 = (name: Uint8Array) => encodeURIComponent(`b64:${b64(name)}`);
const decode = (s: string) =>
  algosdk.decodeUnsignedTransaction(new Uint8Array(Buffer.from(s, "base64")));

const JOB_TYPE = "(uint64,address,uint64,uint64,uint64,byte[],byte[],uint64,uint64,uint64)";
const AGENT_TYPE = "(uint64,string,address,uint64,uint64)";

type StubJob = { jobId: number; client?: string; budgetMicro: number; statusCode: number };
type StubBid = {
  jobId: number;
  bidderAgentId: number;
  priceMicro: number;
  pitchHash?: Uint8Array;
  placedAt?: number;
};

function encodeJob(j: StubJob): string {
  return b64(
    algosdk.ABIType.from(JOB_TYPE).encode([
      BigInt(j.jobId),
      j.client ?? CLIENT,
      0n,
      0n,
      BigInt(j.budgetMicro),
      new Uint8Array(32).fill(7),
      new Uint8Array(0),
      BigInt(j.statusCode),
      1_785_861_990n,
      1_785_862_007n,
    ])
  );
}

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

function encodeBid(b: StubBid): string {
  return b64(
    algosdk.ABIType.from(BID_TYPE).encode([
      BigInt(b.jobId),
      BigInt(b.bidderAgentId),
      BigInt(b.priceMicro),
      b.pitchHash ?? new Uint8Array(32).fill(0xab),
      BigInt(b.placedAt ?? 1_785_862_100),
    ])
  );
}

/**
 * A stand-in approval program: the 4-byte selectors of the methods it routes,
 * separated by filler.
 *
 * The filler matters. A program that was nothing but concatenated selectors
 * would let an off-by-one search pass by accident, and the real thing has
 * thousands of unrelated opcodes around each literal.
 */
function programWith(signatures: string[]): string {
  const parts: number[] = [];
  for (const sig of signatures) {
    parts.push(0x80, 0x04); // pushbytes, length 4 — what puya actually emits
    parts.push(...selectorOf(sig));
    parts.push(0x12, 0x44, 0x22, 0x43); // == ; bnz ; int 1 ; return
  }
  return b64(new Uint8Array(parts));
}

/** Every method the LIVE registries really route today, per the deployed ABI.
 *
 *  Registries 769444119 / 769444120 / 769444121, deployed 2026-08-05, route all
 *  36 compiled methods. The bidding set and rotate_address were absent from
 *  every earlier generation, which is why the guard exists at all — keep this
 *  list matching the chain, because `deploymentReport` is asserted against it. */
const DEPLOYED_VALIDATION = [
  "post_job(byte[],uint64,uint64)uint64",
  "assign_job(uint64,uint64)bool",
  "fund_job(axfer,uint64)uint64",
  "release_escrow(uint64)uint64",
  "refund_escrow(uint64)uint64",
  "release_partial(uint64,uint64)uint64",
  "expire_job(uint64)bool",
  "place_bid(uint64,uint64,uint64,byte[])bool",
  "withdraw_bid(uint64,uint64)bool",
  "accept_bid(uint64,uint64)bool",
  "get_bid(uint64,uint64)(uint64,uint64,uint64,byte[],uint64)",
];
const DEPLOYED_IDENTITY = [
  "new_agent(string)uint64",
  "agent_address(uint64)address",
  "deregister_agent(uint64)bool",
  "rotate_address(uint64,address)bool",
];

/**
 * A registry generation from BEFORE 2026-08-05: escrow, but no bidding and no
 * rotation.
 *
 * The refusal path is the reason this guard exists, and it used to be exercised
 * for free because the live registries really were missing those methods. Now
 * that they route all 36, refusing can only be provoked deliberately — and a
 * guard nothing ever forces to say no is a guard nobody has tested. Anyone
 * pointing an old config at a current tool still lands here.
 */
const PRE_BIDDING_VALIDATION = [
  "post_job(byte[],uint64,uint64)uint64",
  "assign_job(uint64,uint64)bool",
  "fund_job(axfer,uint64)uint64",
  "release_escrow(uint64)uint64",
  "refund_escrow(uint64)uint64",
];
const PRE_ROTATION_IDENTITY = [
  "new_agent(string)uint64",
  "agent_address(uint64)address",
  "deregister_agent(uint64)bool",
];

function chain(opts: {
  jobs?: StubJob[];
  bids?: StubBid[];
  agents?: Record<number, { domain: string; address: string }>;
  validationMethods?: string[];
  identityMethods?: string[];
}) {
  const jobs = opts.jobs ?? [];
  const bids = opts.bids ?? [];
  const agents = opts.agents ?? {};
  const requests: string[] = [];

  const doFetch = (async (url: string, init?: RequestInit) => {
    requests.push(`${init?.method ?? "GET"} ${url}`);

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

    if (new RegExp(`/v2/applications/${APPS.validation}$`).test(url)) {
      return new Response(
        JSON.stringify({
          params: {
            "approval-program": programWith(opts.validationMethods ?? DEPLOYED_VALIDATION),
            "global-state": [
              { key: Buffer.from("job_count").toString("base64"), value: { uint: jobs.length, type: 2 } },
            ],
          },
        }),
        { status: 200 }
      );
    }
    if (new RegExp(`/v2/applications/${APPS.identity}$`).test(url)) {
      return new Response(
        JSON.stringify({
          params: { "approval-program": programWith(opts.identityMethods ?? DEPLOYED_IDENTITY) },
        }),
        { status: 200 }
      );
    }

    if (url.includes(`/applications/${APPS.validation}/boxes`)) {
      // The stub filters by prefix exactly as algod does. A stub that returned
      // every box would hide the whole point of the composite key: that "bids
      // on job 7" is a server-side filter and never sees job 8's.
      const prefixParam = decodeURIComponent(new URL(url).searchParams.get("prefix") ?? "");
      const raw = new Uint8Array(Buffer.from(prefixParam.replace(/^b64:/, ""), "base64"));
      const names = bids
        .map((b) => bidBoxName(b.jobId, b.bidderAgentId))
        .filter((n) => raw.every((byte, i) => n[i] === byte));
      return new Response(JSON.stringify({ boxes: names.map((n) => ({ name: b64(n) })) }), {
        status: 200,
      });
    }

    if (url.includes("/box?")) {
      for (const job of jobs) {
        if (url.includes(nameB64(jobBoxName(job.jobId)))) {
          return new Response(JSON.stringify({ value: encodeJob(job) }), { status: 200 });
        }
      }
      for (const bid of bids) {
        if (url.includes(nameB64(bidBoxName(bid.jobId, bid.bidderAgentId)))) {
          return new Response(JSON.stringify({ value: encodeBid(bid) }), { status: 200 });
        }
      }
      for (const [id, agent] of Object.entries(agents)) {
        const name = new Uint8Array([...Buffer.from("ag_"), ...uint64Bytes(Number(id))]);
        if (url.includes(nameB64(name))) {
          return new Response(
            JSON.stringify({ value: encodeAgent(Number(id), agent.domain, agent.address) }),
            { status: 200 }
          );
        }
        const adName = new Uint8Array([
          ...Buffer.from("ad_"),
          ...algosdk.decodeAddress(agent.address).publicKey,
        ]);
        if (url.includes(nameB64(adName))) {
          return new Response(
            JSON.stringify({ value: b64(uint64Bytes(Number(id))) }),
            { status: 200 }
          );
        }
      }
      return new Response("no box", { status: 404 });
    }

    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;

  const config: RiparConfig = resolveConfig({ fetch: doFetch });
  return { config, registry: new RiparRegistry({ fetch: doFetch }), requests };
}

const OPEN_JOB: StubJob = { jobId: 7, budgetMicro: 1_000_000, statusCode: 0 };
const AGENTS = {
  1: { domain: "ripar-agent.vercel.app", address: BIDDER },
  2: { domain: "client.ripar.io", address: CLIENT },
};

// The programs are cached per endpoint for the life of the process, so each
// test has to start from an empty cache or the first test's fixture answers
// every later one.
beforeEach(() => clearDeployedCache());

// ---------------------------------------------------------------------------

describe("bd_ box names", () => {
  it("is the prefix plus BOTH ids, 19 bytes, with no ARC-4 length prefix", () => {
    const name = bidBoxName(7, 1);
    expect(name.length).toBe(19);
    expect(Buffer.from(name.slice(0, 3)).toString("utf8")).toBe("bd_");
    // The key type is `Bytes`, so algopy stores the 16 bytes raw. An ARC-4
    // byte[] would prepend a 2-byte length and the box would never be found.
    expect(Buffer.from(name.slice(3, 11)).toString("hex")).toBe("0000000000000007");
    expect(Buffer.from(name.slice(11)).toString("hex")).toBe("0000000000000001");
  });

  it("puts the job id first, so one job's bids share a byte prefix", () => {
    const prefix = bidPrefixForJob(7);
    expect(prefix.length).toBe(11);
    for (const agentId of [1, 2, 999]) {
      const name = bidBoxName(7, agentId);
      expect(prefix.every((byte, i) => name[i] === byte)).toBe(true);
    }
    // ...and job 8's bids do not.
    expect(prefix.every((byte, i) => bidBoxName(8, 1)[i] === byte)).toBe(false);
  });

  it("round-trips both ids back out", () => {
    expect(bidKeyFromBoxName(bidBoxName(7, 1))).toEqual({ jobId: 7, bidderAgentId: 1 });
    expect(bidKeyFromBoxName(bidBoxName(123_456, 42))).toEqual({
      jobId: 123_456,
      bidderAgentId: 42,
    });
  });

  it("refuses a name that is not a bid box, rather than returning a number", () => {
    expect(() => bidKeyFromBoxName(jobBoxName(7))).toThrow(/Not a bd_/);
    // Right prefix, wrong length — an `es_`-shaped key with a `bd_` head.
    const short = new Uint8Array([...Buffer.from("bd_"), ...uint64Bytes(7)]);
    expect(() => bidKeyFromBoxName(short)).toThrow(/Not a bd_/);
  });
});

describe("decodeBidBox", () => {
  it("reads a Bid struct including the dynamic pitch hash", () => {
    const hash = new Uint8Array(32).fill(0x5d);
    const bid = decodeBidBox(
      new Uint8Array(Buffer.from(encodeBid({ jobId: 7, bidderAgentId: 1, priceMicro: 400_000, pitchHash: hash, placedAt: 1_785_862_100 }), "base64"))
    );
    expect(bid).toEqual({
      jobId: 7,
      bidderAgentId: 1,
      priceMicro: 400_000,
      pitchHash: "5d".repeat(32),
      placedAt: 1_785_862_100,
    });
  });

  it("does not read the price out of the middle of the pitch hash", () => {
    // The struct is dynamic: pitch_hash is a byte[] living in a tail addressed
    // by a 2-byte head offset. Decoding by hand-counted offsets is exactly the
    // bug this asserts against — a big price and a distinctive hash make a
    // mis-slice obvious.
    const bid = decodeBidBox(
      new Uint8Array(
        Buffer.from(
          encodeBid({ jobId: 1, bidderAgentId: 9, priceMicro: 999_999_999, pitchHash: new Uint8Array(32).fill(0xff) }),
          "base64"
        )
      )
    );
    expect(bid.priceMicro).toBe(999_999_999);
    expect(bid.pitchHash).toBe("ff".repeat(32));
  });
});

describe("listBids", () => {
  it("returns every bid on the job, cheapest first", async () => {
    const { registry } = chain({
      jobs: [OPEN_JOB],
      bids: [
        { jobId: 7, bidderAgentId: 1, priceMicro: 900_000 },
        { jobId: 7, bidderAgentId: 2, priceMicro: 400_000 },
        { jobId: 7, bidderAgentId: 3, priceMicro: 650_000 },
      ],
    });
    const bids = await registry.listBids(7);
    expect(bids.map((b) => b.bidderAgentId)).toEqual([2, 3, 1]);
    expect(bids.map((b) => b.priceMicro)).toEqual([400_000, 650_000, 900_000]);
  });

  it("breaks a price tie by who bid first", async () => {
    const { registry } = chain({
      jobs: [OPEN_JOB],
      bids: [
        { jobId: 7, bidderAgentId: 1, priceMicro: 500_000, placedAt: 2000 },
        { jobId: 7, bidderAgentId: 2, priceMicro: 500_000, placedAt: 1000 },
      ],
    });
    expect((await registry.listBids(7)).map((b) => b.bidderAgentId)).toEqual([2, 1]);
  });

  it("never returns another job's bids", async () => {
    const { registry } = chain({
      jobs: [OPEN_JOB, { jobId: 8, budgetMicro: 1, statusCode: 0 }],
      bids: [
        { jobId: 7, bidderAgentId: 1, priceMicro: 400_000 },
        { jobId: 8, bidderAgentId: 1, priceMicro: 100 },
      ],
    });
    const bids = await registry.listBids(7);
    expect(bids).toHaveLength(1);
    expect(bids[0]!.jobId).toBe(7);
  });

  it("is empty, not an error, on a job nobody bid on", async () => {
    const { registry } = chain({ jobs: [OPEN_JOB] });
    expect(await registry.listBids(7)).toEqual([]);
  });

  it("refuses a box whose key and value disagree instead of picking one", async () => {
    // The listing says this box is (job 7, agent 1); the value inside claims
    // agent 4. Preferring either would attribute a price to an agent that never
    // offered it.
    const { registry } = chain({
      jobs: [OPEN_JOB],
      bids: [{ jobId: 7, bidderAgentId: 1, priceMicro: 400_000 }],
    });
    const original = registry.readBox.bind(registry);
    registry.readBox = async (appId: number, name: Uint8Array) => {
      const value = await original(appId, name);
      if (name[0] === 0x62 && name[1] === 0x64) {
        return new Uint8Array(
          Buffer.from(encodeBid({ jobId: 7, bidderAgentId: 4, priceMicro: 400_000 }), "base64")
        );
      }
      return value;
    };
    await expect(registry.listBids(7)).rejects.toThrow(/key and the value disagree/);
  });
});

// ---------------------------------------------------------------------------

describe("the deployed-method guard", () => {
  it("finds a selector the live program really routes", async () => {
    const { config } = chain({});
    expect(
      await isMethodDeployed(config, APPS.validation, "fund_job(axfer,uint64)uint64")
    ).toBe(true);
  });

  it("does not find one it does not", async () => {
    const { config } = chain({ validationMethods: PRE_BIDDING_VALIDATION });
    expect(
      await isMethodDeployed(config, APPS.validation, CONTRACT_METHODS.place_bid.signature)
    ).toBe(false);
  });

  it("distinguishes methods whose names differ only in signature", async () => {
    // The selector hashes the whole signature string, so these are different
    // methods to the router even though a human reads one name.
    const { config } = chain({ validationMethods: ["accept_bid(uint64,uint64)bool"] });
    expect(await isMethodDeployed(config, APPS.validation, "accept_bid(uint64,uint64)bool")).toBe(true);
    expect(await isMethodDeployed(config, APPS.validation, "accept_bid(uint64)bool")).toBe(false);
  });

  it("reads the app record once and reuses it", async () => {
    const { config, requests } = chain({});
    await isMethodDeployed(config, APPS.validation, "fund_job(axfer,uint64)uint64");
    await isMethodDeployed(config, APPS.validation, "release_escrow(uint64)uint64");
    const appReads = requests.filter((r) => r.endsWith(`/v2/applications/${APPS.validation}`));
    expect(appReads).toHaveLength(1);
  });

  it("reports the whole gap between the source tree and the chain", async () => {
    const { config } = chain({});
    const report = await deploymentReport(config);
    const byName = Object.fromEntries(report.methods.map((m) => [m.name, m]));
    expect(byName.fund_job!.onChain).toBe(true);
    expect(byName.place_bid!.onChain).toBe(true);
    expect(byName.rotate_address!.onChain).toBe(true);
    // `deployed` in the table is documentation; `onChain` is the read. They
    // agree here, and if they ever stop the table is what is wrong.
    for (const m of report.methods) expect(m.onChain).toBe(m.expectedOnChain);
  });

  it("still reports a gap when the chain is behind the table", async () => {
    // The whole point of the report is naming what the source tree expects and
    // the chain does not have. Now that the live registries route everything,
    // that gap has to be provoked deliberately or this stops testing anything.
    const { config } = chain({ validationMethods: ["fund_job(axfer,uint64)uint64"] });
    const report = await deploymentReport(config);
    const byName = Object.fromEntries(report.methods.map((m) => [m.name, m]));
    expect(byName.fund_job!.onChain).toBe(true);
    expect(byName.place_bid!.onChain).toBe(false);
    expect(byName.place_bid!.expectedOnChain).toBe(true);
    const drifted = report.methods.filter((m) => m.onChain !== m.expectedOnChain);
    expect(drifted.length).toBeGreaterThan(0);
  });

  it("refuses to guess when the app cannot be read at all", async () => {
    const config = resolveConfig({
      fetch: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
    });
    await expect(
      isMethodDeployed(config, APPS.validation, CONTRACT_METHODS.place_bid.signature)
    ).rejects.toThrow(/503/);
  });
});

// ---------------------------------------------------------------------------

describe("composePlaceBid", () => {
  const live = { validationMethods: [...DEPLOYED_VALIDATION, CONTRACT_METHODS.place_bid.signature] };

  it("REFUSES against a pre-bidding registry, and says what to do instead", async () => {
    const { config } = chain({ jobs: [OPEN_JOB], agents: AGENTS, validationMethods: PRE_BIDDING_VALIDATION });
    const err = await composePlaceBid(config, {
      sender: BIDDER,
      jobId: 7,
      bidderAgentId: 1,
      priceMicro: 400_000,
      pitch: "I will do it",
    }).catch((e) => e);

    expect(err).toBeInstanceOf(MethodNotDeployedError);
    expect(err.message).toMatch(new RegExp(`place_bid.*is not deployed on app ${REGISTRY_APP_IDS.testnet.validation}`));
    expect(err.message).toMatch(/assign_job/);
    // The selector is in the message so the claim can be checked by hand
    // against the program on an explorer.
    expect(err.message).toMatch(new RegExp(Buffer.from(selectorOf(CONTRACT_METHODS.place_bid.signature)).toString("hex")));
  });

  it("refuses BEFORE reading the job, so a refusal costs one request", async () => {
    const { config, requests } = chain({ jobs: [OPEN_JOB], agents: AGENTS, validationMethods: PRE_BIDDING_VALIDATION });
    await composePlaceBid(config, {
      sender: BIDDER,
      jobId: 7,
      bidderAgentId: 1,
      priceMicro: 400_000,
      pitch: "x",
    }).catch(() => {});
    expect(requests.filter((r) => r.includes("/box?"))).toHaveLength(0);
  });

  it("hashes the pitch and puts ONLY the digest on chain", async () => {
    const { config } = chain({ jobs: [OPEN_JOB], agents: AGENTS, ...live });
    const pitch = "I will summarise the corpus in under an hour.";
    const tx = await composePlaceBid(config, {
      sender: BIDDER,
      jobId: 7,
      bidderAgentId: 1,
      priceMicro: 400_000,
      pitch,
    });

    expect(tx.args.pitchHash).toBe(hashPitch(pitch));
    expect(tx.args.pitchStoredOnChain).toBe(false);
    expect(tx.summary).toMatch(/PITCH TEXT STAYS OFF CHAIN/);

    // The words themselves appear NOWHERE in the composed transaction — not in
    // the args, not in the summary, and not in the encoded app args.
    const serialised = JSON.stringify(tx);
    expect(serialised).not.toContain("summarise the corpus");
    const raw = decode(tx.unsignedTxnBase64);
    const appArgs = raw.applicationCall!.appArgs!;
    expect(Buffer.from(appArgs[4]!).toString("utf8")).not.toContain("corpus");
  });

  it("commits to a PLAIN sha256 the counterparty can recompute independently", async () => {
    const { config } = chain({ jobs: [OPEN_JOB], agents: AGENTS, ...live });
    const tx = await composePlaceBid(config, {
      sender: BIDDER,
      jobId: 7,
      bidderAgentId: 1,
      priceMicro: 400_000,
      pitch: "hello",
    });

    // Computed HERE, by node's own sha256 over the utf-8 bytes — deliberately
    // not by calling hashPitch. A test that hashes with the same function it is
    // checking passes for any hash at all, including one nobody else can
    // reproduce, and the entire value of the commitment is that the client CAN
    // reproduce it from the words the bidder shows them later.
    const independent = createHash("sha256").update(Buffer.from("hello", "utf8")).digest("hex");
    expect(independent).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
    expect(hashPitch("hello")).toBe(independent);
    expect(tx.args.pitchHash).toBe(independent);

    const raw = decode(tx.unsignedTxnBase64);
    // ARC-4 byte[] is a 2-byte length prefix then the bytes.
    const encoded = raw.applicationCall!.appArgs![4]!;
    expect(encoded.length).toBe(34);
    expect(Buffer.from(encoded.slice(2)).toString("hex")).toBe(independent);
  });

  it("hashes the utf-8 bytes, so a non-ASCII pitch commits to what a peer computes", async () => {
    // The digest is an agreement between two parties. If this side hashed
    // latin1 or utf-16, an honest pitch containing a non-ASCII character would
    // fail the client's check and look like a lie.
    const pitch = "résumé — 90% coverage";
    const independent = createHash("sha256").update(Buffer.from(pitch, "utf8")).digest("hex");
    expect(hashPitch(pitch)).toBe(independent);
    expect(hashPitch(pitch)).not.toBe(
      createHash("sha256").update(Buffer.from(pitch, "latin1")).digest("hex")
    );
  });

  it("takes a digest directly, but never both", async () => {
    const { config } = chain({ jobs: [OPEN_JOB], agents: AGENTS, ...live });
    const digest = "a".repeat(64);
    const tx = await composePlaceBid(config, {
      sender: BIDDER,
      jobId: 7,
      bidderAgentId: 1,
      priceMicro: 400_000,
      pitchHash: digest,
    });
    expect(tx.args.pitchHash).toBe(digest);

    await expect(
      composePlaceBid(config, {
        sender: BIDDER,
        jobId: 7,
        bidderAgentId: 1,
        priceMicro: 400_000,
        pitch: "text",
        pitchHash: digest,
      })
    ).rejects.toThrow(/exactly one/);
    await expect(
      composePlaceBid(config, { sender: BIDDER, jobId: 7, bidderAgentId: 1, priceMicro: 400_000 })
    ).rejects.toThrow(/exactly one/);
  });

  it("declares the bid box, the job box and the bidder's foreign agent box", async () => {
    const { config } = chain({ jobs: [OPEN_JOB], agents: AGENTS, ...live });
    const tx = await composePlaceBid(config, {
      sender: BIDDER,
      jobId: 7,
      bidderAgentId: 1,
      priceMicro: 400_000,
      pitch: "x",
    });
    expect(tx.boxes).toEqual(["jb_7", "bd_0x00000000000000070000000000000001", `ag_1@${APPS.identity}`]);
    const raw = decode(tx.unsignedTxnBase64);
    expect(raw.applicationCall!.foreignApps!.map(Number)).toContain(APPS.identity);
    // One inner call — _agent_address resolves the bidder — so the outer fee
    // has to cover two minimum fees, not one.
    expect(tx.fee).toBe(2000);
  });

  it("refuses a bid on a job that is no longer open", async () => {
    const { config } = chain({
      jobs: [{ jobId: 7, budgetMicro: 1_000_000, statusCode: 1 }],
      agents: AGENTS,
      ...live,
    });
    await expect(
      composePlaceBid(config, { sender: BIDDER, jobId: 7, bidderAgentId: 1, priceMicro: 4, pitch: "x" })
    ).rejects.toThrow(/bids close when the job is assigned|is assigned/);
  });

  it("refuses a bid placed on another agent's behalf", async () => {
    const { config } = chain({ jobs: [OPEN_JOB], agents: AGENTS, ...live });
    await expect(
      composePlaceBid(config, {
        sender: STRANGER,
        jobId: 7,
        bidderAgentId: 1,
        priceMicro: 400_000,
        pitch: "x",
      })
    ).rejects.toThrow(/Only the bidding agent may place its own bid/);
  });

  it("refuses the client bidding on their own job", async () => {
    const { config } = chain({ jobs: [OPEN_JOB], agents: AGENTS, ...live });
    await expect(
      composePlaceBid(config, {
        sender: CLIENT,
        jobId: 7,
        bidderAgentId: 2,
        priceMicro: 400_000,
        pitch: "x",
      })
    ).rejects.toThrow(/is the client of job 7 and cannot bid/);
  });

  it("refuses a zero price and a non-digest hash", async () => {
    const { config } = chain({ jobs: [OPEN_JOB], agents: AGENTS, ...live });
    await expect(
      composePlaceBid(config, { sender: BIDDER, jobId: 7, bidderAgentId: 1, priceMicro: 0, pitch: "x" })
    ).rejects.toThrow(/positive integer/);
    await expect(
      composePlaceBid(config, {
        sender: BIDDER,
        jobId: 7,
        bidderAgentId: 1,
        priceMicro: 1,
        pitchHash: "abcd",
      })
    ).rejects.toThrow(/32-byte sha256 digest, got 2 bytes/);
  });
});

// ---------------------------------------------------------------------------

describe("composeAcceptBid", () => {
  const live = {
    validationMethods: [...DEPLOYED_VALIDATION, CONTRACT_METHODS.accept_bid.signature],
  };

  it("REFUSES against a pre-bidding registry", async () => {
    const { config } = chain({ jobs: [OPEN_JOB], agents: AGENTS, validationMethods: PRE_BIDDING_VALIDATION });
    const err = await composeAcceptBid(config, { sender: CLIENT, jobId: 7, bidderAgentId: 1 }).catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(MethodNotDeployedError);
    expect(err.message).toMatch(new RegExp(`accept_bid\\(uint64,uint64\\)bool is not deployed on app ${REGISTRY_APP_IDS.testnet.validation}`));
    expect(err.message).toMatch(/assign_job/);
  });

  it("says the budget is rewritten, in the summary AND in the args", async () => {
    const { config } = chain({
      jobs: [OPEN_JOB],
      bids: [{ jobId: 7, bidderAgentId: 1, priceMicro: 400_000 }],
      agents: AGENTS,
      ...live,
    });
    const tx = await composeAcceptBid(config, { sender: CLIENT, jobId: 7, bidderAgentId: 1 });

    expect(tx.summary).toMatch(/ACCEPTING REWRITES THE JOB'S BUDGET/);
    // Both numbers, so a signer can see which one survives.
    expect(tx.summary).toContain("1.000000");
    expect(tx.summary).toContain("0.400000");
    expect(tx.args.budgetBeforeMicro).toBe(1_000_000);
    expect(tx.args.budgetAfterMicro).toBe(400_000);
    expect(tx.args.budgetAfterUsdc).toBe("0.400000");
  });

  it("flags a bid ABOVE the posted budget rather than burying it", async () => {
    const { config } = chain({
      jobs: [OPEN_JOB],
      bids: [{ jobId: 7, bidderAgentId: 1, priceMicro: 2_500_000 }],
      agents: AGENTS,
      ...live,
    });
    const tx = await composeAcceptBid(config, { sender: CLIENT, jobId: 7, bidderAgentId: 1 });
    expect(tx.summary).toMatch(/MORE than you posted/);
    expect(tx.args.budgetAfterMicro).toBe(2_500_000);
  });

  it("counts the cheaper bids that are being passed over", async () => {
    const { config } = chain({
      jobs: [OPEN_JOB],
      bids: [
        { jobId: 7, bidderAgentId: 1, priceMicro: 900_000 },
        { jobId: 7, bidderAgentId: 2, priceMicro: 400_000 },
        { jobId: 7, bidderAgentId: 3, priceMicro: 500_000 },
      ],
      agents: AGENTS,
      ...live,
    });
    const tx = await composeAcceptBid(config, { sender: CLIENT, jobId: 7, bidderAgentId: 1 });
    expect(tx.args.competingBids).toBe(3);
    expect(tx.args.cheaperBidsNotTaken).toBe(2);
    expect(tx.summary).toMatch(/losing bids are NOT swept/i);
  });

  it("refuses anyone but the client, and names who the client is", async () => {
    const { config } = chain({
      jobs: [OPEN_JOB],
      bids: [{ jobId: 7, bidderAgentId: 1, priceMicro: 400_000 }],
      agents: AGENTS,
      ...live,
    });
    await expect(
      composeAcceptBid(config, { sender: STRANGER, jobId: 7, bidderAgentId: 1 })
    ).rejects.toThrow(new RegExp(`client is ${CLIENT}`));
  });

  it("declares the job box, the bid box it reads, and the bidder's foreign agent box", async () => {
    // The bid box is the one that is easy to forget, and forgetting it does not
    // fail here — it fails on chain with an unavailable-box error naming
    // neither the box nor the method.
    const { config } = chain({
      jobs: [OPEN_JOB],
      bids: [{ jobId: 7, bidderAgentId: 1, priceMicro: 400_000 }],
      agents: AGENTS,
      ...live,
    });
    const tx = await composeAcceptBid(config, { sender: CLIENT, jobId: 7, bidderAgentId: 1 });
    expect(tx.boxes).toEqual([
      "jb_7",
      "bd_0x00000000000000070000000000000001",
      `ag_1@${APPS.identity}`,
    ]);
    const boxes = decode(tx.unsignedTxnBase64).applicationCall!.boxes!;
    expect(boxes.map((b) => Buffer.from(b.name).toString("hex"))).toContain(
      Buffer.from(bidBoxName(7, 1)).toString("hex")
    );
  });

  it("refuses a bid that does not exist, and lists the ones that do", async () => {
    const { config } = chain({
      jobs: [OPEN_JOB],
      bids: [{ jobId: 7, bidderAgentId: 2, priceMicro: 400_000 }],
      agents: AGENTS,
      ...live,
    });
    await expect(
      composeAcceptBid(config, { sender: CLIENT, jobId: 7, bidderAgentId: 1 })
    ).rejects.toThrow(/Agent 1 has no bid on job 7.*agents 2/s);
  });
});

// ---------------------------------------------------------------------------

describe("the ripar_list_bids tool", () => {
  const run = (config: RiparConfig, registry: RiparRegistry, args: Record<string, unknown>) =>
    getTool("ripar_list_bids")!.run(args, { registry, config }) as Promise<Record<string, any>>;

  it("says bidding is NOT deployed when the program does not route place_bid", async () => {
    const { config, registry } = chain({ jobs: [OPEN_JOB], validationMethods: PRE_BIDDING_VALIDATION });
    const out = await run(config, registry, { jobId: 7 });

    expect(out.biddingDeployed).toBe(false);
    expect(out.bids).toEqual([]);
    // An empty list with no explanation reads as "nobody bid". It has to say
    // that no bid COULD exist here, or a reader draws the wrong conclusion
    // about the job rather than about the registry.
    expect(out.notes.join(" ")).toMatch(new RegExp(`place_bid is NOT in app ${REGISTRY_APP_IDS.testnet.validation}'s approval program`));
    expect(out.notes.join(" ")).toMatch(/naming an agent directly/);
  });

  it("says bidding IS deployed when the program routes it", async () => {
    const { config, registry } = chain({
      jobs: [OPEN_JOB],
      bids: [{ jobId: 7, bidderAgentId: 1, priceMicro: 400_000 }],
      validationMethods: [...DEPLOYED_VALIDATION, CONTRACT_METHODS.place_bid.signature],
    });
    const out = await run(config, registry, { jobId: 7 });
    expect(out.biddingDeployed).toBe(true);
    expect(out.notes.join(" ")).toMatch(/bids are real here/);
    expect(out.count).toBe(1);
    expect(out.bids[0].priceUsdc).toBe("0.400000");
    expect(out.bids[0].undercutsBudget).toBe(true);
  });

  it("marks bids on a closed job as no longer acceptable", async () => {
    const { config, registry } = chain({
      jobs: [{ jobId: 7, budgetMicro: 1_000_000, statusCode: 1 }],
      bids: [{ jobId: 7, bidderAgentId: 1, priceMicro: 400_000 }],
      validationMethods: [...DEPLOYED_VALIDATION, CONTRACT_METHODS.place_bid.signature],
    });
    const out = await run(config, registry, { jobId: 7 });
    expect(out.bids[0].stillAcceptable).toBe(false);
    expect(out.notes.join(" ")).toMatch(/record of what was offered, not live offers/);
    // The kept-losing-bids rule has to be stated wherever bids are read, since
    // that is the only place someone could mistake a rejected bid for a live one.
    expect(out.notes.join(" ")).toMatch(/NOT swept/);
  });

  it("says the pitch text is off chain", async () => {
    const { config, registry } = chain({
      jobs: [OPEN_JOB],
      bids: [{ jobId: 7, bidderAgentId: 1, priceMicro: 400_000 }],
      validationMethods: [...DEPLOYED_VALIDATION, CONTRACT_METHODS.place_bid.signature],
    });
    const out = await run(config, registry, { jobId: 7 });
    expect(out.notes.join(" ")).toMatch(/pitch text is off chain/);
    expect(out.bids[0].pitchHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports a job that does not exist as not found, rather than as having no bids", async () => {
    const { config, registry } = chain({ jobs: [] });
    expect(await run(config, registry, { jobId: 99 })).toEqual({
      found: false,
      reason: "no job 99 in the registry",
    });
  });
});

describe("composeRotateAddress", () => {
  const live = {
    identityMethods: [...DEPLOYED_IDENTITY, CONTRACT_METHODS.rotate_address.signature],
  };

  it("REFUSES against a pre-rotation IdentityRegistry, and does not call deregistering equivalent", async () => {
    const { config } = chain({ agents: AGENTS, identityMethods: PRE_ROTATION_IDENTITY });
    const err = await composeRotateAddress(config, {
      sender: BIDDER,
      agentId: 1,
      newAddress: FRESH,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(MethodNotDeployedError);
    expect(err.message).toMatch(new RegExp(`rotate_address\\(uint64,address\\)bool is not deployed on app ${REGISTRY_APP_IDS.testnet.identity}`));
    expect(err.message).toMatch(/NO KEY RECOVERY ON CHAIN TODAY/);
    // The fallback is offered AND its cost is stated. An alternative presented
    // without its cost is advice to lose the identity.
    expect(err.message).toMatch(/deregister_agent/);
    expect(err.message).toMatch(/loses the id/);
  });

  it("says the OLD address stops resolving", async () => {
    const { config } = chain({ agents: AGENTS, ...live });
    const tx = await composeRotateAddress(config, { sender: BIDDER, agentId: 1, newAddress: FRESH });
    expect(tx.summary).toMatch(/THE OLD ADDRESS STOPS RESOLVING/);
    expect(tx.summary).toContain(BIDDER);
    expect(tx.args.oldAddressStopsResolving).toBe(true);
    expect(tx.args.oldAddress).toBe(BIDDER);
    expect(tx.args.newAddress).toBe(FRESH);
  });

  it("says the id and the reputation survive", async () => {
    const { config } = chain({ agents: AGENTS, ...live });
    const tx = await composeRotateAddress(config, { sender: BIDDER, agentId: 1, newAddress: FRESH });
    expect(tx.args.idIsPreserved).toBe(true);
    expect(tx.args.reputationFollowsTheId).toBe(true);
    expect(tx.nextSteps.join(" ")).toMatch(/must resolve to nothing/);
    // The card is the loose end a rotation leaves behind.
    expect(tx.nextSteps.join(" ")).toMatch(/agent\.json/);
  });

  it("declares BOTH reverse-index boxes — the one it deletes and the one it creates", async () => {
    const { config } = chain({ agents: AGENTS, ...live });
    const tx = await composeRotateAddress(config, { sender: BIDDER, agentId: 1, newAddress: FRESH });
    const raw = decode(tx.unsignedTxnBase64);
    const boxes = raw.applicationCall!.boxes!.map((b) => Buffer.from(b.name).toString("hex"));
    const ad = (addr: string) =>
      Buffer.concat([
        Buffer.from("ad_"),
        Buffer.from(algosdk.decodeAddress(addr).publicKey),
      ]).toString("hex");
    expect(boxes).toContain(ad(BIDDER));
    expect(boxes).toContain(ad(FRESH));
    expect(boxes).toHaveLength(3);
  });

  it("encodes the new address as 32 raw bytes, not as base32 text", async () => {
    const { config } = chain({ agents: AGENTS, ...live });
    const tx = await composeRotateAddress(config, { sender: BIDDER, agentId: 1, newAddress: FRESH });
    const arg = decode(tx.unsignedTxnBase64).applicationCall!.appArgs![2]!;
    expect(arg.length).toBe(32);
    expect(algosdk.encodeAddress(arg)).toBe(FRESH);
  });

  it("refuses anyone but the current holder — and says why that makes it a race", async () => {
    const { config } = chain({ agents: AGENTS, ...live });
    await expect(
      composeRotateAddress(config, { sender: STRANGER, agentId: 1, newAddress: FRESH })
    ).rejects.toThrow(/Only the current address may rotate.*race/s);
  });

  it("refuses a rotation to the address that already holds it", async () => {
    const { config } = chain({ agents: AGENTS, ...live });
    await expect(
      composeRotateAddress(config, { sender: BIDDER, agentId: 1, newAddress: BIDDER })
    ).rejects.toThrow(/already agent 1's controlling address.*hide a typo/s);
  });

  it("refuses a destination that already controls an agent", async () => {
    const { config } = chain({ agents: AGENTS, ...live });
    await expect(
      composeRotateAddress(config, { sender: BIDDER, agentId: 1, newAddress: CLIENT })
    ).rejects.toThrow(/already controls agent 2/);
  });

  it("refuses an address that is not an address, before touching the chain", async () => {
    const { config } = chain({ agents: AGENTS, ...live });
    await expect(
      composeRotateAddress(config, { sender: BIDDER, agentId: 1, newAddress: "X".repeat(58) })
    ).rejects.toThrow(/not a valid Algorand address/);
  });
});
