/**
 * Registry decoder tests.
 *
 * The fixtures are not invented. Every base64 blob below was captured from
 * Algorand TestNet with
 *
 *   curl "https://testnet-api.algonode.cloud/v2/applications/768571941/box?name=b64:YWdfAAAAAAAAAAE="
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
  scoreBoxName,
  uint64Bytes,
} from "../src/abi.js";
import { RiparRegistry, microToUsdc } from "../src/registry.js";
import { REGISTRY_APP_IDS, jobStatusName } from "../src/config.js";

const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");

/** IdentityRegistry 768571941, box `ag_` + uint64(1). */
const AGENT_1_BOX =
  "AAAAAAAAAAEAOlBHHKthrrBUpBWu5dvDA7U5EY0eIO91MNt3AEq8gxEmAAAAAGpyEKcAAAAAanIQpwAWcmlwYXItYWdlbnQudmVyY2VsLmFwcA==";
/** ReputationRegistry 768571942, box `sc_` + uint64(1). */
const SCORE_1_BOX =
  "AAAAAAAAAAEAAAAAAAAAAQAAAAAAACcQAAAAAAAAAAAAAAAAAAAAAAAAAABqchCyAAAAAGpyELI=";
/** ValidationRegistry 768571946, box `jb_` + uint64(1). */
const JOB_1_BOX =
  "AAAAAAAAAAFQRxyrYa6wVKQVruXbwwO1ORGNHiDvdTDbdwBKvIMRJgAAAAAAAAABAAAAAAAAAAIAAAAAAA9CQABcAH4AAAAAAAAAAwAAAABqchC3AAAAAGpyEMgAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHACAJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQ==";
/** `dm_agent-1785821796525.ripar.io` and `ad_<pubkey>` both hold a bare uint64. */
const POINTER_BOX = "AAAAAAAAAAE=";

const AGENT_1_ADDRESS = "KBDRZK3BV2YFJJAVV3S5XQYDWU4RDDI6EDXXKMG3O4AEVPEDCETDKEISKQ";
const AGENT_1_DOMAIN = "ripar-agent.vercel.app";

describe("AgentInfo decoding", () => {
  it("reads every field out of a real IdentityRegistry box", () => {
    const agent = decodeAgentBox(b64(AGENT_1_BOX));
    expect(agent).toEqual({
      agentId: 1,
      domain: AGENT_1_DOMAIN,
      address: AGENT_1_ADDRESS,
      registeredAt: 1785860263,
      updatedAt: 1785860263,
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
      firstAt: 1785860274,
      lastAt: 1785860274,
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
    expect(job.validatorAgentId).toBe(2);
    expect(job.budgetMicro).toBe(1_000_000);
    // deploy-v2.mjs drove this job through the whole lifecycle while proving
    // the authorisation fixes, so both hashes are populated and it ended
    // VALIDATED — judged by agent 2, the named validator, and by nobody else.
    expect(job.specHash).toBe("07".repeat(32));
    // The contract asserts spec_hash is a 32-byte sha256 digest.
    expect(job.specHash).toHaveLength(64);
    expect(job.resultHash).toBe("09".repeat(32));
    expect(job.statusCode).toBe(3);
    expect(job.status).toBe("validated");
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
    // These are the exact names from GET /v2/applications/768571941/boxes.
    expect(Buffer.from(agentBoxName(1)).toString("base64")).toBe("YWdfAAAAAAAAAAE=");
    expect(Buffer.from(domainBoxName(AGENT_1_DOMAIN)).toString("base64")).toBe(
      "ZG1fcmlwYXItYWdlbnQudmVyY2VsLmFwcA=="
    );
    expect(Buffer.from(addressBoxName(AGENT_1_ADDRESS)).toString("base64")).toBe(
      "YWRfUEccq2GusFSkFa7l28MDtTkRjR4g73Uw23cASryDESY="
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

  /* The two tests that stood here covered paidBoxName(), which built a
   * `pd_` + txid box name. Both the helper and the box are gone: the
   * ReputationRegistry kept one per counted payment as replay protection, but
   * keying it on the txid was circular (the name depends on the txid, which
   * depends on the group id, which depends on the app call, which must declare
   * the box) and unnecessary — the payment is a transaction in the same group,
   * so consensus already rejects a duplicate.
   *
   * scoreBoxName and agentBoxName below still cover the uint64 box-name path
   * these shared. */

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

  it("filters box listings by prefix so ag_ boxes never leak into sc_ results", async () => {
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
    const counted = await registry.listBoxNames(registry.config.appIds.reputation!, "sc_");
    // Only the sc_ box comes back; the ag_ one is filtered out.
      expect(counted).toHaveLength(1);
      expect(Buffer.from(counted[0]!).toString("base64")).toBe("c2NfAAAAAAAAAAE=");
  });

  /**
   * algod's `max=` is not a truncating limit — it answers HTTP 400 "Result
   * limit exceeded" once an app holds more boxes than the number given. So the
   * listing has to follow `next-token`, and it has to ask with `limit=`.
   */
  it("follows next-token instead of asking for a max it would be refused for", async () => {
    const pages: Record<string, unknown> = {
      "1": { boxes: [{ name: "c2NfAAAAAAAAAAE=" }], "next-token": "b64:cursor" },
      "2": { boxes: [{ name: "c2NfAAAAAAAAAAI=" }] },
    };
    const urls: string[] = [];
    const registry = new RiparRegistry({
      fetch: (async (url: string) => {
        urls.push(url);
        const page = url.includes("next=") ? "2" : "1";
        return new Response(JSON.stringify(pages[page]), { status: 200 });
      }) as unknown as typeof fetch,
    });

    const counted = await registry.listBoxNames(registry.config.appIds.reputation!, "sc_");
    expect(counted).toHaveLength(2);
    expect(urls).toHaveLength(2);
    // `max=` is the parameter that 400s; it must never be sent.
    expect(urls.every((u) => !u.includes("max="))).toBe(true);
    expect(urls[0]).toContain("limit=");
    // The prefix is pushed to the server rather than filtered after the fact.
    expect(urls[0]).toContain(`prefix=${encodeURIComponent("b64:c2Nf")}`);
    expect(urls[1]).toContain("next=");
  });

  it("throws rather than returning a partial list when the cursor never ends", async () => {
    const registry = new RiparRegistry({
      fetch: (async () =>
        new Response(
          JSON.stringify({ boxes: [{ name: "c2NfAAAAAAAAAAE=" }], "next-token": "b64:forever" }),
          { status: 200 }
        )) as unknown as typeof fetch,
    });
    await expect(
        registry.listBoxNames(registry.config.appIds.reputation!, "sc_")
      ).rejects.toThrow(/partial list/i);
  });

  /* The test that stood here checked that a failed `pd_` listing threw rather
   * than coming back as an empty set and marking every real payment
   * uncredited. settlements() no longer makes that listing — the box is gone —
   * so there is nothing left to fail in that particular way.
   *
   * The read it DOES make is the score box, and a missing one is null rather
   * than zeros: never paid and paid-but-scored-nothing are different claims.
   * Covered below. */
});

describe("settlements: transfers, plus the score the chain records", () => {
  const TXID_A = "2FFXSG5JTVTNECCM3Y4HMOZCKDILNQR3IT5R5PEUKJLNSLTJZHEA";
  const TXID_B = "AAFXSG5JTVTNECCM3Y4HMOZCKDILNQR3IT5R5PEUKJLNSLTJZHEA";

  // agent_id 1, jobs_paid 3, volume 35000, validated 0, disputed 0, timestamps.
  const SCORE_BOX = "AAAAAAAAAAEAAAAAAAAAAwAAAAAAAIi4AAAAAAAAAAAAAAAAAAAAAAAAAABlU/EAAAAAAGVT8WQ=";

  /**
   * There used to be a per-transfer `countedInReputation` flag, joined from a
   * `pd_` box the ReputationRegistry wrote for every credited payment. That box
   * is gone, so the flag cannot be computed — and computing it as false for
   * everything would have reported every payment as an uncredited gap, which is
   * a lie in the shape of an answer.
   *
   * What replaces it is the score, which is what the chain actually records
   * about credited work.
   */
  function stubbed(opts: { score?: string | null } = {}) {
    const score = opts.score === undefined ? SCORE_BOX : opts.score;
    return new RiparRegistry({
      fetch: (async (url: string) => {
        if (url.includes("/box?")) {
          // sc_ is the score read; anything else is the ad_ -> agent 1 index.
          if (url.includes(encodeURIComponent("b64:c2Nf"))) {
            if (score === null) return new Response("no box", { status: 404 });
            return new Response(JSON.stringify({ value: score }), { status: 200 });
          }
          return new Response(JSON.stringify({ value: "AAAAAAAAAAE=" }), { status: 200 });
        }
        if (url.includes("/v2/accounts/")) {
          return new Response(
            JSON.stringify({
              transactions: [
                {
                  id: TXID_A,
                  sender: "CLIENTADDRESS",
                  "confirmed-round": 100,
                  "round-time": 1_700_000_000,
                  "asset-transfer-transaction": { amount: 10_000, receiver: AGENT_1_ADDRESS },
                },
                {
                  id: TXID_B,
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

  it("reports the transfers and the agent's score alongside them", async () => {
    const result = await stubbed().settlements({ address: AGENT_1_ADDRESS });

    expect(result.transfers).toHaveLength(2);
    expect(result.totals).toEqual({ received: 2, sent: 0, receivedUsdc: "0.035000" });
    expect(result.asset.id).toBe(10458941);
    expect(result.agentId).toBe(1);
    expect(result.score?.jobsPaid).toBe(3);

    // No transfer carries a credit flag, because the chain records none.
    expect(result.transfers.every((t) => !("countedInReputation" in t))).toBe(true);
  });

  it("returns a null score rather than zeros when the agent has never been paid", async () => {
    // A missing box and a box of zeros are different claims: never paid, versus
    // paid and scored nothing. Only the first is true here.
    const result = await stubbed({ score: null }).settlements({ address: AGENT_1_ADDRESS });
    expect(result.score).toBeNull();
  });

  it("needs an address or an agent id and says so rather than returning nothing", async () => {
    await expect(stubbed().settlements({})).rejects.toThrow(/address or an agentId/);
  });
});
