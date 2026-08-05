/**
 * Escrow: reading what is actually held, and composing the calls that move it.
 *
 * The chain is stubbed here so the arithmetic and the transaction SHAPE can be
 * asserted exactly — `test/live.test.ts` reads the same boxes off TestNet, and
 * the resource arrays below were checked against the real AVM by running the
 * composed transactions through algod's simulate endpoint, where a missing box
 * or foreign app fails with "unavailable" and a short fee fails with "group fee
 * too small" long before any assert in the contract is reached.
 *
 * The distinction under test throughout: a BUDGET is a claim, an ESCROW is
 * money. Nothing here may let the first read as the second.
 */

import { describe, expect, it } from "vitest";
import algosdk from "algosdk";

import { escrowBoxName, idFromBoxName, jobBoxName, uint64Bytes } from "../src/abi.js";
import { RiparRegistry, withEscrow, type Job } from "../src/index.js";
import { REGISTRY_APP_IDS } from "../src/config.js";
import {
  composeFundJob,
  composeRefundEscrow,
  composeReleaseEscrow,
} from "../src/unsigned.js";

const APPS = REGISTRY_APP_IDS.testnet;
const VALIDATION_APP_ADDRESS = algosdk.getApplicationAddress(APPS.validation).toString();

const CLIENT = "KBDRZK3BV2YFJJAVV3S5XQYDWU4RDDI6EDXXKMG3O4AEVPEDCETDKEISKQ";
const STRANGER = "B2DGXU2QSRHXNZJMP5FFFU77W5NUMZTZ3X3MSO3PJC4ZQ75CSDL5EKULI4";
const ASSIGNEE = "UBB4PNTT7CI3IQS25ZMQR4DGVYYCBORNSBLU4WKUGX4BAZ3KN4O2KATPAU";

const ESCROW_ASSET = 10_458_941;
const DISPUTE_WINDOW = 20;

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const nameB64 = (name: Uint8Array) => encodeURIComponent(`b64:${b64(name)}`);

const JOB_TYPE = "(uint64,address,uint64,uint64,uint64,byte[],byte[],uint64,uint64,uint64)";
const AGENT_TYPE = "(uint64,string,address,uint64,uint64)";

type StubJob = {
  jobId: number;
  client?: string;
  serverAgentId?: number;
  validatorAgentId?: number;
  budgetMicro: number;
  statusCode: number;
  updatedAt?: number;
};

function encodeJob(j: StubJob): string {
  return b64(
    algosdk.ABIType.from(JOB_TYPE).encode([
      BigInt(j.jobId),
      j.client ?? CLIENT,
      BigInt(j.serverAgentId ?? 0),
      BigInt(j.validatorAgentId ?? 0),
      BigInt(j.budgetMicro),
      new Uint8Array(32).fill(7),
      new Uint8Array(32).fill(9),
      BigInt(j.statusCode),
      1_785_861_990n,
      BigInt(j.updatedAt ?? 1_785_862_007),
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

/**
 * A stub algod holding exactly the boxes and globals named. Anything not named
 * 404s, which is what the real node does — and what makes "absent means zero"
 * a property this suite can actually test rather than assume.
 */
function chain(opts: {
  jobs?: StubJob[];
  escrows?: Record<number, number>;
  agents?: Record<number, { domain: string; address: string }>;
  escrowAsset?: number;
}) {
  const jobs = opts.jobs ?? [];
  const escrows = opts.escrows ?? {};
  const agents = opts.agents ?? {};
  const requests: string[] = [];

  const registry = new RiparRegistry({
    fetch: (async (url: string, init?: RequestInit) => {
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
        const g = (key: string, uint: number) => ({
          key: Buffer.from(key, "utf8").toString("base64"),
          value: { uint, type: 2 },
        });
        return new Response(
          JSON.stringify({
            params: {
              "global-state": [
                g("job_count", jobs.length),
                g("escrow_asset", opts.escrowAsset ?? ESCROW_ASSET),
                g("dispute_window", DISPUTE_WINDOW),
                g("identity_app", APPS.identity),
                g("reputation_app", APPS.reputation),
              ],
            },
          }),
          { status: 200 }
        );
      }

      if (url.includes(`/applications/${APPS.validation}/boxes`)) {
        // algod filters by prefix server-side, and the difference matters here:
        // a stub that returned every box would let a `jb_` listing come back
        // full of `es_` names and the client-side filter would hide the bug.
        const prefix = decodeURIComponent(new URL(url).searchParams.get("prefix") ?? "");
        const names = prefix.includes(Buffer.from("es_").toString("base64"))
          ? Object.keys(escrows).map((id) => b64(escrowBoxName(Number(id))))
          : jobs.map((j) => b64(jobBoxName(j.jobId)));
        return new Response(
          JSON.stringify({ boxes: names.map((name) => ({ name })) }),
          { status: 200 }
        );
      }

      if (url.includes("/box?")) {
        for (const job of jobs) {
          if (url.includes(nameB64(jobBoxName(job.jobId)))) {
            return new Response(JSON.stringify({ value: encodeJob(job) }), { status: 200 });
          }
        }
        for (const [id, micro] of Object.entries(escrows)) {
          if (url.includes(nameB64(escrowBoxName(Number(id))))) {
            return new Response(
              JSON.stringify({ value: b64(uint64Bytes(micro)) }),
              { status: 200 }
            );
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
        }
        return new Response("no box", { status: 404 });
      }

      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch,
  });

  return { registry, requests };
}

const openJob: StubJob = { jobId: 3, budgetMicro: 1_000_000, statusCode: 0 };
const validatedJob: StubJob = {
  jobId: 4,
  budgetMicro: 1_000_000,
  statusCode: 3,
  serverAgentId: 1,
  updatedAt: 1_785_862_007,
};
const disputedJob: StubJob = { jobId: 5, budgetMicro: 400_000, statusCode: 4, serverAgentId: 1 };

const AGENTS = { 1: { domain: "ripar-agent.vercel.app", address: ASSIGNEE } };

const decode = (b: string) =>
  algosdk.decodeUnsignedTransaction(new Uint8Array(Buffer.from(b, "base64")));

// ---------------------------------------------------------------------------

describe("es_ box names", () => {
  it("is the job id behind the prefix, the same shape as jb_", () => {
    expect(Buffer.from(escrowBoxName(2)).toString("hex")).toBe("65735f0000000000000002");
    // Same id, different box: the two live side by side on the same app.
    expect(escrowBoxName(2)).not.toEqual(jobBoxName(2));
  });

  it("reads the id back out of a listed name", () => {
    expect(idFromBoxName(escrowBoxName(7), "es_")).toBe(7);
    expect(idFromBoxName(jobBoxName(65_536), "jb_")).toBe(65_536);
  });

  it("refuses a name that is not the prefix asked for, rather than guessing", () => {
    // A jb_ name read as an es_ one would attach an escrow to the wrong thing.
    expect(() => idFromBoxName(jobBoxName(7), "es_")).toThrow(/not a es_/i);
    expect(() => idFromBoxName(new Uint8Array([1, 2, 3]), "es_")).toThrow();
  });
});

describe("withEscrow", () => {
  const base = { budgetMicro: 1_000_000 } as Job;

  it("keeps budget and escrow as separate facts", () => {
    const j = withEscrow(base, 0);
    expect(j.budgetUsdc).toBe("1.000000");
    expect(j.escrowUsdc).toBe("0.000000");
    // The whole point: a budget is not money.
    expect(j.funded).toBe(false);
    expect(j.fullyFunded).toBe(false);
    expect(j.unfundedMicro).toBe(1_000_000);
  });

  it("calls a partly funded job funded but not fully funded", () => {
    const j = withEscrow(base, 250_000);
    expect(j.funded).toBe(true);
    expect(j.fullyFunded).toBe(false);
    expect(j.unfundedMicro).toBe(750_000);
  });

  it("never reports a negative shortfall on an over-funded job", () => {
    // fund_job adds to whatever is held, so escrow above budget is reachable.
    const j = withEscrow(base, 1_500_000);
    expect(j.fullyFunded).toBe(true);
    expect(j.unfundedMicro).toBe(0);
  });
});

describe("reading escrow off the chain", () => {
  it("reports 0 for a job with no es_ box, because absent is the contract's zero", async () => {
    const { registry } = chain({ jobs: [openJob] });
    expect(await registry.getEscrow(3)).toBe(0);
    const job = await registry.getJobWithEscrow(3);
    expect(job!.budgetMicro).toBe(1_000_000);
    expect(job!.escrowMicro).toBe(0);
    expect(job!.funded).toBe(false);
  });

  it("reads a funded job's amount out of the bare uint64 the box holds", async () => {
    const { registry } = chain({ jobs: [openJob], escrows: { 3: 250_000 } });
    expect(await registry.getEscrow(3)).toBe(250_000);
    expect((await registry.getJobWithEscrow(3))!.escrowUsdc).toBe("0.250000");
  });

  it("builds the funded map from the listing, so unfunded jobs cost no read", async () => {
    const { registry, requests } = chain({
      jobs: [openJob, validatedJob],
      escrows: { 4: 500_000 },
    });
    const map = await registry.escrowMap();
    expect([...map.entries()]).toEqual([[4, 500_000]]);
    // One es_ box exists, so exactly one es_ box read happened.
    expect(requests.filter((r) => r.includes(nameB64(escrowBoxName(3))))).toHaveLength(0);
  });

  it("joins jobs to escrow in one pass", async () => {
    const { registry } = chain({ jobs: [openJob, validatedJob], escrows: { 4: 500_000 } });
    const jobs = await registry.listJobsWithEscrow({});
    expect(jobs.map((j) => [j.jobId, j.escrowMicro])).toEqual([
      [4, 500_000],
      [3, 0],
    ]);
  });

  it("reads the escrow terms out of global state rather than a constant", async () => {
    const { registry } = chain({ jobs: [openJob] });
    const terms = await registry.escrowTerms();
    expect(terms.assetId).toBe(ESCROW_ASSET);
    expect(terms.disputeWindowSecs).toBe(DISPUTE_WINDOW);
    expect(terms.identityApp).toBe(APPS.identity);
    // Derived from the app id, so it is not a number anyone can substitute.
    expect(terms.appAddress).toBe(VALIDATION_APP_ADDRESS);
  });
});

describe("composing fund_job", () => {
  it("returns a two-transaction group in the order the contract reads it", async () => {
    const { registry } = chain({ jobs: [openJob] });
    const group = await composeFundJob(registry.config, {
      sender: CLIENT,
      jobId: 3,
      amountMicro: 1_000_000,
    });

    expect(group.signed).toBe(false);
    expect(group.transactions).toHaveLength(2);
    // Transaction 0 is the money. fund_job reads the amount off it, so a group
    // with the app call first would not be the same call at all.
    expect(group.transactions[0]!.kind).toBe("axfer");
    expect(group.transactions[1]!.kind).toBe("appl");

    const xfer = decode(group.transactions[0]!.unsignedTxnBase64);
    expect(xfer.assetTransfer!.receiver.toString()).toBe(VALIDATION_APP_ADDRESS);
    expect(Number(xfer.assetTransfer!.amount)).toBe(1_000_000);
    expect(Number(xfer.assetTransfer!.assetIndex)).toBe(ESCROW_ASSET);

    const call = decode(group.transactions[1]!.unsignedTxnBase64);
    expect(Number(call.applicationCall!.appIndex)).toBe(APPS.validation);
    expect(Buffer.from(call.applicationCall!.appArgs[0]!).toString("hex")).toBe(
      Buffer.from(
        algosdk.ABIMethod.fromSignature("fund_job(axfer,uint64)uint64").getSelector()
      ).toString("hex")
    );
    // The axfer is a transaction argument, matched by position in the group —
    // it is not encoded into appArgs, so the job id is the only one there.
    expect(call.applicationCall!.appArgs).toHaveLength(2);
    expect(group.transactions[1]!.boxes).toEqual(["jb_3", "es_3"]);
  });

  it("groups them, so neither half can be signed and submitted alone", async () => {
    const { registry } = chain({ jobs: [openJob] });
    const group = await composeFundJob(registry.config, {
      sender: CLIENT,
      jobId: 3,
      amountMicro: 1_000_000,
    });
    const xfer = decode(group.transactions[0]!.unsignedTxnBase64);
    const call = decode(group.transactions[1]!.unsignedTxnBase64);

    expect(xfer.group).toBeDefined();
    expect(Buffer.from(xfer.group!).toString("base64")).toBe(group.groupId);
    expect(Buffer.from(call.group!).toString("base64")).toBe(group.groupId);

    // A group id commits to the ORDER, so recomputing it over [transfer, call]
    // is what pins that the two were grouped that way round. An ARC-4
    // transaction argument is read from the position before the app call, so a
    // group assembled the other way is a different call entirely — and every
    // other assertion here would still pass. The field has to be cleared first:
    // the id is computed over transactions that do not yet carry one.
    xfer.group = undefined;
    call.group = undefined;
    expect(b64(algosdk.computeGroupID([xfer, call]))).toBe(group.groupId);
  });

  it("says what the money does, in both directions, in the summary", async () => {
    const { registry } = chain({ jobs: [openJob], escrows: { 3: 250_000 } });
    const group = await composeFundJob(registry.config, {
      sender: CLIENT,
      jobId: 3,
      amountMicro: 750_000,
    });
    expect(group.args.escrowBeforeMicro).toBe(250_000);
    expect(group.args.escrowAfterMicro).toBe(1_000_000);
    expect(group.args.fullyFundsBudget).toBe(true);
    expect(group.summary).toContain(VALIDATION_APP_ADDRESS);
    expect(group.summary).toMatch(/release_escrow/);
    expect(group.summary).toMatch(/refund_escrow/);
  });

  it("refuses for anyone but the client, before a fee is spent", async () => {
    const { registry } = chain({ jobs: [openJob] });
    await expect(
      composeFundJob(registry.config, { sender: STRANGER, jobId: 3, amountMicro: 1 })
    ).rejects.toThrow(/only the client may fund/i);
  });

  it("refuses once the job is past funding", async () => {
    const { registry } = chain({ jobs: [validatedJob] });
    await expect(
      composeFundJob(registry.config, { sender: CLIENT, jobId: 4, amountMicro: 1 })
    ).rejects.toThrow(/open or assigned/i);
  });

  it("refuses a zero transfer, which would escrow nothing", async () => {
    const { registry } = chain({ jobs: [openJob] });
    await expect(
      composeFundJob(registry.config, { sender: CLIENT, jobId: 3, amountMicro: 0 })
    ).rejects.toThrow(/positive integer/i);
  });

  it("refuses when the registry was never bootstrapped, rather than sending to asset 0", async () => {
    const { registry } = chain({ jobs: [openJob], escrowAsset: 0 });
    await expect(
      composeFundJob(registry.config, { sender: CLIENT, jobId: 3, amountMicro: 1 })
    ).rejects.toThrow(/never bootstrapped/i);
  });
});

describe("composing release_escrow", () => {
  const funded = { jobs: [validatedJob], escrows: { 4: 500_000 }, agents: AGENTS };

  it("carries the resources the inner calls need, and the fee for both of them", async () => {
    const { registry } = chain(funded);
    const tx = await composeReleaseEscrow(registry.config, { sender: CLIENT, jobId: 4 });

    expect(tx.method).toBe("release_escrow(uint64)uint64");
    // The ag_ box belongs to the IDENTITY app: box references are shared across
    // the group by app id, and the inner call reads it there.
    expect(tx.boxes).toEqual(["jb_4", "es_4", `ag_1@${APPS.identity}`]);

    const call = decode(tx.unsignedTxnBase64).applicationCall!;
    expect(call.foreignApps.map(Number)).toEqual([APPS.identity]);
    expect(call.foreignAssets.map(Number)).toEqual([ESCROW_ASSET]);
    expect(call.accounts.map((a) => a.toString())).toEqual([ASSIGNEE]);
    // agent_address() by inner app call, then the transfer — both submitted
    // with fee 0, so the outer call funds three transactions in total.
    expect(tx.fee).toBe(3000);
  });

  it("names the agent about to be paid, not just its id", async () => {
    const { registry } = chain(funded);
    const tx = await composeReleaseEscrow(registry.config, { sender: CLIENT, jobId: 4 });
    expect(tx.summary).toContain(ASSIGNEE);
    expect(tx.summary).toContain("ripar-agent.vercel.app");
    expect(tx.args.escrowUsdc).toBe("0.500000");
  });

  it("tells the client it may release now", async () => {
    const { registry } = chain(funded);
    const tx = await composeReleaseEscrow(registry.config, { sender: CLIENT, jobId: 4 });
    expect(tx.args.senderIsClient).toBe(true);
    expect(tx.nextSteps[0]).toMatch(/accepts this immediately/i);
  });

  it("gives a stranger the exact time the dispute window closes", async () => {
    const { registry } = chain(funded);
    const tx = await composeReleaseEscrow(registry.config, { sender: STRANGER, jobId: 4 });
    expect(tx.args.senderIsClient).toBe(false);
    // The window runs from the verdict, which is the job's updated_at.
    expect(tx.args.disputeWindowClosesAt).toBe(validatedJob.updatedAt! + DISPUTE_WINDOW);
    // That job's verdict is long past, so anyone may release it by now.
    expect(tx.args.anyoneMayReleaseNow).toBe(true);
    expect(tx.nextSteps[0]).toMatch(/anyone may release/i);
  });

  it("refuses a job that has not passed, and points at the right call", async () => {
    const { registry } = chain({ jobs: [disputedJob], escrows: { 5: 400_000 }, agents: AGENTS });
    await expect(
      composeReleaseEscrow(registry.config, { sender: CLIENT, jobId: 5 })
    ).rejects.toThrow(/refund_escrow/);
  });

  it("refuses when nothing is held, saying which of the two reasons it is", async () => {
    const { registry } = chain({ jobs: [validatedJob], agents: AGENTS });
    await expect(
      composeReleaseEscrow(registry.config, { sender: CLIENT, jobId: 4 })
    ).rejects.toThrow(/never funded, or it was already paid out/i);
  });

  it("refuses when the assignee cannot be resolved, because the contract could not either", async () => {
    const { registry } = chain({ jobs: [validatedJob], escrows: { 4: 500_000 } });
    await expect(
      composeReleaseEscrow(registry.config, { sender: CLIENT, jobId: 4 })
    ).rejects.toThrow(/IdentityRegistry has no such record/i);
  });
});

describe("composing refund_escrow", () => {
  const funded = { jobs: [disputedJob], escrows: { 5: 400_000 } };

  it("pays the client, and funds the one inner transfer it makes", async () => {
    const { registry } = chain(funded);
    const tx = await composeRefundEscrow(registry.config, { sender: STRANGER, jobId: 5 });

    expect(tx.method).toBe("refund_escrow(uint64)uint64");
    expect(tx.args.payee).toBe(CLIENT);
    // No agent is resolved on a refund, so there is no identity app and no ag_
    // box — one inner transfer, and the fee covers exactly two transactions.
    expect(tx.boxes).toEqual(["jb_5", "es_5"]);
    const call = decode(tx.unsignedTxnBase64).applicationCall!;
    expect(call.foreignApps.map(Number)).toEqual([]);
    expect(call.accounts.map((a) => a.toString())).toEqual([CLIENT]);
    expect(tx.fee).toBe(2000);
  });

  it("says a stranger may sign it, because the destination is not the sender", async () => {
    const { registry } = chain(funded);
    const tx = await composeRefundEscrow(registry.config, { sender: STRANGER, jobId: 5 });
    expect(tx.args.senderIsClient).toBe(false);
    expect(tx.nextSteps[0]).toMatch(/anyone may sign/i);
    expect(tx.summary).toContain(CLIENT);
  });

  it("refuses a job that passed, and points at the right call", async () => {
    const { registry } = chain({ jobs: [validatedJob], escrows: { 4: 1 }, agents: AGENTS });
    await expect(
      composeRefundEscrow(registry.config, { sender: CLIENT, jobId: 4 })
    ).rejects.toThrow(/release_escrow/);
  });

  it("refuses a job that is still live", async () => {
    const { registry } = chain({ jobs: [openJob] });
    await expect(
      composeRefundEscrow(registry.config, { sender: CLIENT, jobId: 3 })
    ).rejects.toThrow(/still live/i);
  });
});

describe("neither composer submits anything", () => {
  it("makes no POST while composing a funding group or a release", async () => {
    const { registry, requests } = chain({
      jobs: [openJob, validatedJob],
      escrows: { 4: 500_000 },
      agents: AGENTS,
    });
    await composeFundJob(registry.config, { sender: CLIENT, jobId: 3, amountMicro: 1_000 });
    await composeReleaseEscrow(registry.config, { sender: CLIENT, jobId: 4 });
    expect(requests.filter((r) => r.startsWith("POST"))).toEqual([]);
  });
});
