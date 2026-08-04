/**
 * Registry decoder tests.
 *
 * The fixtures are not invented. Every base64 blob below was captured from
 * Algorand TestNet with
 *
 *   curl "https://testnet-api.algonode.cloud/v2/applications/768547159/box?name=b64:YWdfAAAAAAAAAAE="
 *
 * so a decoder that drifts from what the deployed contracts actually write
 * fails here, offline, instead of returning confident nonsense at runtime.
 */

import { describe, expect, it } from "vitest";
import algosdk from "algosdk";

import {
  AGENT_INFO_TYPE,
  JOB_TYPE,
  SCORE_TYPE,
  addressBoxName,
  agentBoxName,
  base32TxIdToBytes,
  decodeAgentBox,
  decodeJobBox,
  decodeScoreBox,
  decodeUint64Box,
  domainBoxName,
  fromHex,
  jobBoxName,
  paidBoxName,
  scoreBoxName,
  uint64Bytes,
} from "../src/abi.js";
import { RiparRegistry, microToUsdc } from "../src/registry.js";
import { REGISTRY_APP_IDS, jobStatusName } from "../src/config.js";

const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");

/** IdentityRegistry 768547159, box `ag_` + uint64(1). */
const AGENT_1_BOX =
  "AAAAAAAAAAEAOqBDx7Zz+JG0QlruWQjwZq4wILotkFdOWVQ1+BBnam8dAAAAAGpxemIAAAAAanF6YgAcYWdlbnQtMTc4NTgyMTc5NjUyNS5yaXBhci5pbw==";
/** ReputationRegistry 768559198, box `sc_` + uint64(1). */
const SCORE_1_BOX =
  "AAAAAAAAAAEAAAAAAAAAAQAAAAAAACcQAAAAAAAAAAAAAAAAAAAAAAAAAABqcXpyAAAAAGpxenI=";
/** ValidationRegistry 768547172, box `jb_` + uint64(1). */
const JOB_1_BOX =
  "AAAAAAAAAAGgQ8e2c/iRtEJa7lkI8GauMCC6LZBXTllUNfgQZ2pvHQAAAAAAAAABAAAAAAAAAAAAAAAAACYloABcAH4AAAAAAAAAAQAAAABqcXpoAAAAAGpxem0AIF1qfAU9ro4BMEFM18o7ewedKI8q/P1p2l6t1E8Wzkj2AAA=";
/** `dm_agent-1785821796525.ripar.io` and `ad_<pubkey>` both hold a bare uint64. */
const POINTER_BOX = "AAAAAAAAAAE=";

const AGENT_1_ADDRESS = "UBB4PNTT7CI3IQS25ZMQR4DGVYYCBORNSBLU4WKUGX4BAZ3KN4O2KATPAU";
const AGENT_1_DOMAIN = "agent-1785821796525.ripar.io";

describe("AgentInfo decoding", () => {
  it("reads every field out of a real IdentityRegistry box", () => {
    const agent = decodeAgentBox(b64(AGENT_1_BOX));
    expect(agent).toEqual({
      agentId: 1,
      domain: AGENT_1_DOMAIN,
      address: AGENT_1_ADDRESS,
      registeredAt: 1785821794,
      updatedAt: 1785821794,
    });
  });

  it("finds the domain in the ARC-4 tail, not at a flat offset", () => {
    // The head is 58 bytes: 8 (id) + 2 (offset) + 32 (address) + 8 + 8. Bytes
    // 8..9 are the OFFSET to the domain, not the domain. A decoder that treated
    // the struct as a flat concatenation would read the domain out of the
    // address, so pinning both the offset and the resulting string is what
    // makes this test catch that mistake.
    const raw = b64(AGENT_1_BOX);
    const declaredOffset = (raw[8]! << 8) | raw[9]!;
    expect(declaredOffset).toBe(58);

    const tail = raw.slice(declaredOffset);
    const declaredLength = (tail[0]! << 8) | tail[1]!;
    expect(declaredLength).toBe(AGENT_1_DOMAIN.length);
    expect(Buffer.from(tail.slice(2)).toString("utf8")).toBe(AGENT_1_DOMAIN);

    // And the address really does sit between them.
    expect(decodeAgentBox(raw).address).toBe(AGENT_1_ADDRESS);
  });

  it("round-trips a domain long enough to move every later field", () => {
    const longDomain = `${"a".repeat(180)}.example.com`;
    const encoded = algosdk.ABIType.from(AGENT_INFO_TYPE).encode([
      42n,
      longDomain,
      AGENT_1_ADDRESS,
      1n,
      2n,
    ]);
    const decoded = decodeAgentBox(encoded);
    expect(decoded.domain).toBe(longDomain);
    expect(decoded.address).toBe(AGENT_1_ADDRESS);
    expect(decoded.agentId).toBe(42);
    expect(decoded.updatedAt).toBe(2);
  });
});

describe("Score decoding", () => {
  it("reads a real ReputationRegistry box", () => {
    const score = decodeScoreBox(b64(SCORE_1_BOX));
    expect(score).toEqual({
      agentId: 1,
      jobsPaid: 1,
      volumeMicro: 10_000,
      validated: 0,
      disputed: 0,
      firstAt: 1785821810,
      lastAt: 1785821810,
    });
  });

  it("is a fixed 56 bytes, so a short read is corruption rather than a default", () => {
    expect(b64(SCORE_1_BOX).length).toBe(56);
    expect(() => decodeScoreBox(b64(SCORE_1_BOX).slice(0, 40))).toThrow();
  });

  it("keeps field order: volume is field 3, not swapped with the counters", () => {
    const encoded = algosdk.ABIType.from(SCORE_TYPE).encode([7n, 3n, 999n, 5n, 2n, 100n, 200n]);
    expect(decodeScoreBox(encoded)).toEqual({
      agentId: 7,
      jobsPaid: 3,
      volumeMicro: 999,
      validated: 5,
      disputed: 2,
      firstAt: 100,
      lastAt: 200,
    });
  });
});

describe("Job decoding", () => {
  it("reads a real ValidationRegistry box, including both dynamic hashes", () => {
    const job = decodeJobBox(b64(JOB_1_BOX));
    expect(job.jobId).toBe(1);
    expect(job.client).toBe(AGENT_1_ADDRESS);
    expect(job.serverAgentId).toBe(1);
    expect(job.validatorAgentId).toBe(0);
    expect(job.budgetMicro).toBe(2_500_000);
    expect(job.specHash).toBe(
      "5d6a7c053dae8e0130414cd7ca3b7b079d288f2afcfd69da5eadd44f16ce48f6"
    );
    // The contract asserts spec_hash is a 32-byte sha256 digest.
    expect(job.specHash).toHaveLength(64);
    // Not yet submitted, so result_hash is genuinely empty.
    expect(job.resultHash).toBe("");
    expect(job.statusCode).toBe(1);
    expect(job.status).toBe("assigned");
  });

  it("maps every status code the contract can write", () => {
    expect(jobStatusName(0)).toBe("open");
    expect(jobStatusName(1)).toBe("assigned");
    expect(jobStatusName(2)).toBe("submitted");
    expect(jobStatusName(3)).toBe("validated");
    // 4 is DISPUTED in validation_registry.py — a failing verdict, not an error.
    expect(jobStatusName(4)).toBe("disputed");
    expect(jobStatusName(5)).toBe("cancelled");
    expect(jobStatusName(99)).toBe("unknown");
  });

  it("keeps the two byte[] fields apart when both are populated", () => {
    const spec = fromHex("11".repeat(32));
    const result = fromHex("22".repeat(32));
    const encoded = algosdk.ABIType.from(JOB_TYPE).encode([
      9n,
      AGENT_1_ADDRESS,
      3n,
      4n,
      1_000_000n,
      spec,
      result,
      3n,
      10n,
      20n,
    ]);
    const job = decodeJobBox(encoded);
    expect(job.specHash).toBe("11".repeat(32));
    expect(job.resultHash).toBe("22".repeat(32));
    expect(job.status).toBe("validated");
  });
});

describe("pointer boxes", () => {
  it("decodes dm_ and ad_ boxes as a bare uint64 agent id", () => {
    expect(decodeUint64Box(b64(POINTER_BOX))).toBe(1);
  });
});

describe("box names", () => {
  it("encodes uint64 keys as 8 raw big-endian bytes behind the prefix", () => {
    expect(hex(agentBoxName(1))).toBe("61675f0000000000000001");
    expect(hex(scoreBoxName(1))).toBe("73635f0000000000000001");
    expect(hex(jobBoxName(2))).toBe("6a625f0000000000000002");
    expect(hex(uint64Bytes(258))).toBe("0000000000000102");
  });

  it("matches the box names algod actually returns", () => {
    // These are the exact names from GET /v2/applications/768547159/boxes.
    expect(Buffer.from(agentBoxName(1)).toString("base64")).toBe("YWdfAAAAAAAAAAE=");
    expect(Buffer.from(domainBoxName(AGENT_1_DOMAIN)).toString("base64")).toBe(
      "ZG1fYWdlbnQtMTc4NTgyMTc5NjUyNS5yaXBhci5pbw=="
    );
    expect(Buffer.from(addressBoxName(AGENT_1_ADDRESS)).toString("base64")).toBe(
      "YWRfoEPHtnP4kbRCWu5ZCPBmrjAgui2QV05ZVDX4EGdqbx0="
    );
  });

  it("writes a domain key as raw UTF-8, with no ARC-4 length prefix", () => {
    const name = domainBoxName("a.io");
    // "dm_" + "a.io" and nothing else. An ARC-4 string would insert 0x00 0x04.
    expect(name.length).toBe(3 + 4);
    expect(Buffer.from(name).toString("utf8")).toBe("dm_a.io");
  });

  it("writes an address key as the 32-byte public key, not the 58-char string", () => {
    const name = addressBoxName(AGENT_1_ADDRESS);
    expect(name.length).toBe(3 + 32);
    expect(hex(name.slice(3))).toBe(hex(algosdk.decodeAddress(AGENT_1_ADDRESS).publicKey));
  });

  it("converts a printed txid to the exact raw bytes the pd_ box is keyed by", () => {
    // Captured live: GET /v2/applications/768559198/boxes returned the box name
    // cGRf0Ut5G6mdZtIITc44djsiUNC2wjtE+x68lFJW2S5pycg=, whose 32-byte tail is
    // the transaction Algorand prints as PRINTED_TXID below.
    const boxName = b64("cGRf0Ut5G6mdZtIITc44djsiUNC2wjtE+x68lFJW2S5pycg=");
    const rawTxid = boxName.slice(3);
    const PRINTED_TXID = "2FFXSG5JTVTNECCNZY4HMOZCKDILNQR3IT5R5PEUKJLNSLTJZHEA";

    expect(hex(rawTxid)).toBe(
      "d14b791ba99d66d2084dce38763b2250d0b6c23b44fb1ebc945256d92e69c9c8"
    );
    expect(hex(base32TxIdToBytes(PRINTED_TXID))).toBe(hex(rawTxid));
    // And going the whole way: the printed id rebuilds the exact box name.
    expect(Buffer.from(paidBoxName(PRINTED_TXID)).toString("base64")).toBe(
      "cGRf0Ut5G6mdZtIITc44djsiUNC2wjtE+x68lFJW2S5pycg="
    );
  });

  it("accepts a payment id as printed base32 or as hex, and rejects the wrong length", () => {
    const txId = "2FFXSG5JTVTNECCNZY4HMOZCKDILNQR3IT5R5PEUKJLNSLTJZHEA";
    const fromBase32 = paidBoxName(txId);
    expect(fromBase32.length).toBe(3 + 32);
    const asHex = hex(fromBase32.slice(3));
    expect(hex(paidBoxName(asHex).slice(3))).toBe(asHex);
    // Short hex is a caller mistake, and the message has to say which mistake.
    expect(() => paidBoxName("00ff")).toThrow(/32 bytes/);
  });
});

describe("USDC formatting", () => {
  it("never loses precision on base units", () => {
    expect(microToUsdc(2_500_000)).toBe("2.500000");
    expect(microToUsdc(10_000)).toBe("0.010000");
    expect(microToUsdc(1)).toBe("0.000001");
    expect(microToUsdc(0)).toBe("0.000000");
  });
});

describe("RiparRegistry wiring", () => {
  it("defaults to the live TestNet app ids", () => {
    const r = new RiparRegistry();
    expect(r.config.appIds).toEqual(REGISTRY_APP_IDS.testnet);
    expect(r.config.algod).toBe("https://testnet-api.algonode.cloud");
    expect(r.config.indexer).toBe("https://testnet-idx.algonode.cloud");
  });

  it("refuses to read a network with no deployed registry instead of using app 0", async () => {
    const r = new RiparRegistry({ network: "mainnet" });
    await expect(r.totalAgents()).rejects.toThrow(/TestNet only/i);
  });

  it("treats a 404 box as absent and any other failure as an error", async () => {
    const notFound = new RiparRegistry({
      fetch: (async () =>
        new Response("", { status: 404 })) as unknown as typeof fetch,
    });
    expect(await notFound.getAgent(999)).toBeNull();
    expect(await notFound.getScore(999)).toBeNull();

    const broken = new RiparRegistry({
      fetch: (async () =>
        new Response("nope", { status: 503, statusText: "Service Unavailable" })) as unknown as typeof fetch,
    });
    // The important half: a failed read must NOT look like "no such agent".
    await expect(broken.getAgent(1)).rejects.toThrow(/503/);
  });

  it("filters box listings by prefix so sc_ boxes never leak into pd_ results", async () => {
    const registry = new RiparRegistry({
      fetch: (async (url: string) => {
        if (url.includes("/boxes")) {
          return new Response(
            JSON.stringify({
              boxes: [
                { name: "cGRf0Ut5G6mdZtIITc44djsiUNC2wjtE+x68lFJW2S5pycg=" },
                { name: "c2NfAAAAAAAAAAE=" },
              ],
            }),
            { status: 200 }
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as unknown as typeof fetch,
    });
    const counted = await registry.countedPaymentIds();
    expect(counted).toEqual(["d14b791ba99d66d2084dce38763b2250d0b6c23b44fb1ebc945256d92e69c9c8"]);
  });

  /**
   * algod's `max=` is not a truncating limit — it answers HTTP 400 "Result
   * limit exceeded" once an app holds more boxes than the number given. So the
   * listing has to follow `next-token`, and it has to ask with `limit=`.
   */
  it("follows next-token instead of asking for a max it would be refused for", async () => {
    const pages: Record<string, unknown> = {
      "1": { boxes: [{ name: "cGRfAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }], "next-token": "b64:cursor" },
      "2": { boxes: [{ name: "cGRf0Ut5G6mdZtIITc44djsiUNC2wjtE+x68lFJW2S5pycg=" }] },
    };
    const urls: string[] = [];
    const registry = new RiparRegistry({
      fetch: (async (url: string) => {
        urls.push(url);
        const page = url.includes("next=") ? "2" : "1";
        return new Response(JSON.stringify(pages[page]), { status: 200 });
      }) as unknown as typeof fetch,
    });

    const counted = await registry.countedPaymentIds();
    expect(counted).toHaveLength(2);
    expect(urls).toHaveLength(2);
    // `max=` is the parameter that 400s; it must never be sent.
    expect(urls.every((u) => !u.includes("max="))).toBe(true);
    expect(urls[0]).toContain("limit=");
    // The prefix is pushed to the server rather than filtered after the fact.
    expect(urls[0]).toContain(`prefix=${encodeURIComponent("b64:cGRf")}`);
    expect(urls[1]).toContain("next=");
  });

  it("throws rather than returning a partial list when the cursor never ends", async () => {
    const registry = new RiparRegistry({
      fetch: (async () =>
        new Response(
          JSON.stringify({ boxes: [{ name: "cGRfAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }], "next-token": "b64:forever" }),
          { status: 200 }
        )) as unknown as typeof fetch,
    });
    await expect(registry.countedPaymentIds()).rejects.toThrow(/partial list/i);
  });

  /**
   * The settlement join is only meaningful if BOTH halves were read. A failed
   * `pd_` listing that came back as an empty set would mark every real payment
   * uncredited and invent a reputation gap that is not there.
   */
  it("refuses to report a settlement join when the credited-payments read failed", async () => {
    const registry = new RiparRegistry({
      fetch: (async (url: string) => {
        if (url.includes("/boxes")) {
          return new Response("nope", { status: 503, statusText: "Service Unavailable" });
        }
        if (url.includes("/box?")) return new Response(JSON.stringify({ value: "AAAAAAAAAAE=" }), { status: 200 });
        return new Response(JSON.stringify({ transactions: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await expect(registry.settlements({ address: AGENT_1_ADDRESS })).rejects.toThrow(
      /could not read the reputationregistry/i
    );
  });
});

describe("settlements: the join between transfers and credited payments", () => {
  const PAID_TXID = "2FFXSG5JTVTNECCM3Y4HMOZCKDILNQR3IT5R5PEUKJLNSLTJZHEA";
  const UNPAID_TXID = "AAFXSG5JTVTNECCM3Y4HMOZCKDILNQR3IT5R5PEUKJLNSLTJZHEA";

  function stubbed() {
    const creditedName = Buffer.from(paidBoxName(PAID_TXID)).toString("base64");
    return new RiparRegistry({
      fetch: (async (url: string) => {
        if (url.includes("/v2/applications/") && url.includes("/box?")) {
          // ad_ lookup -> agent 1
          return new Response(JSON.stringify({ value: "AAAAAAAAAAE=" }), { status: 200 });
        }
        if (url.includes("/boxes")) {
          return new Response(JSON.stringify({ boxes: [{ name: creditedName }] }), { status: 200 });
        }
        if (url.includes("/v2/accounts/")) {
          return new Response(
            JSON.stringify({
              transactions: [
                {
                  id: PAID_TXID,
                  sender: "CLIENTADDRESS",
                  "confirmed-round": 100,
                  "round-time": 1_700_000_000,
                  "asset-transfer-transaction": { amount: 10_000, receiver: AGENT_1_ADDRESS },
                },
                {
                  id: UNPAID_TXID,
                  sender: "CLIENTADDRESS",
                  "confirmed-round": 101,
                  "round-time": 1_700_000_100,
                  "asset-transfer-transaction": { amount: 25_000, receiver: AGENT_1_ADDRESS },
                },
              ],
            }),
            { status: 200 }
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as unknown as typeof fetch,
    });
  }

  it("marks exactly the payments the registry has already credited", async () => {
    const result = await stubbed().settlements({ address: AGENT_1_ADDRESS });
    const byId = Object.fromEntries(result.transfers.map((t) => [t.txId, t]));

    expect(byId[PAID_TXID]!.countedInReputation).toBe(true);
    expect(byId[UNPAID_TXID]!.countedInReputation).toBe(false);

    expect(result.totals).toEqual({
      received: 2,
      sent: 0,
      receivedUsdc: "0.035000",
      countedReceived: 1,
    });
    expect(result.asset.id).toBe(10458941);
    expect(result.agentId).toBe(1);
  });

  it("needs an address or an agent id and says so rather than returning nothing", async () => {
    await expect(stubbed().settlements({})).rejects.toThrow(/address or an agentId/);
  });
});
