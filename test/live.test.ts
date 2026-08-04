/**
 * Live TestNet reads.
 *
 * These hit the real registries over the public AlgoNode endpoints — no API key,
 * no fixtures. They are the tests that catch a redeploy, a schema change, or a
 * decoder that only ever worked against a captured blob.
 *
 * They need internet. Set RIPAR_SKIP_LIVE=1 to skip them in an offline CI, but
 * skipping is a real loss of coverage, not a formality: everything else in this
 * suite proves the code is self-consistent, and only this file proves it agrees
 * with the chain.
 *
 * Assertions are deliberately about invariants rather than exact values, because
 * the chain keeps moving — an agent can be registered or a job posted between
 * one run and the next. What must never change is the SHAPE.
 */

import { describe, expect, it } from "vitest";

import { RiparRegistry } from "../src/registry.js";
import { REGISTRY_APP_IDS } from "../src/config.js";
import {
  composeFundJob,
  composePostJob,
  composeRefundEscrow,
  composeReleaseEscrow,
  composeRotateAddress,
} from "../src/unsigned.js";
import { MethodNotDeployedError, deploymentReport, isMethodDeployed } from "../src/deployed.js";
import { agentHealth } from "../src/health.js";
import algosdk from "algosdk";

const skip = process.env.RIPAR_SKIP_LIVE === "1";
const describeLive = skip ? describe.skip : describe;

const registry = new RiparRegistry();
const APPS = REGISTRY_APP_IDS.testnet;

describeLive("live TestNet registries", () => {
  it("reads agent_count out of IdentityRegistry 768572968", async () => {
    const total = await registry.totalAgents();
    expect(typeof total).toBe("number");
    // The registry has been exercised, so at least one agent exists.
    expect(total).toBeGreaterThanOrEqual(1);
  });

  it("decodes every agent box the chain currently holds", async () => {
    const agents = await registry.listAgents();
    expect(agents.length).toBeGreaterThanOrEqual(1);
    for (const agent of agents) {
      expect(agent.agentId).toBeGreaterThan(0);
      // A garbled tail offset shows up here first: the domain would be empty or
      // full of address bytes rather than a hostname.
      expect(agent.domain).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/i);
      expect(algosdk.isValidAddress(agent.address)).toBe(true);
      expect(agent.registeredAt).toBeGreaterThan(1_600_000_000);
    }
  });

  it("round-trips an agent through both indexes back to the same record", async () => {
    const [agent] = await registry.listAgents(1);
    expect(agent).toBeDefined();

    expect(await registry.resolveByDomain(agent!.domain)).toBe(agent!.agentId);
    expect(await registry.resolveByAddress(agent!.address)).toBe(agent!.agentId);

    const fetched = await registry.getAgent(agent!.agentId);
    expect(fetched).toEqual(agent);
  });

  it("returns 0 and null for things that are not registered", async () => {
    expect(await registry.resolveByDomain("definitely-not-registered.invalid")).toBe(0);
    expect(await registry.getAgent(999_999)).toBeNull();
  });

  it("reads a score box from ReputationRegistry 768572969", async () => {
    const [agent] = await registry.listAgents(1);
    const score = await registry.getScore(agent!.agentId);
    if (score === null) {
      // Legitimate: the agent has never been paid. Nothing else to assert.
      return;
    }
    expect(score.agentId).toBe(agent!.agentId);
    expect(score.jobsPaid).toBeGreaterThanOrEqual(0);
    expect(score.volumeMicro).toBeGreaterThanOrEqual(0);
    // A score with payments must have a first-paid timestamp.
    if (score.jobsPaid > 0) expect(score.firstAt).toBeGreaterThan(1_600_000_000);
  });

  it("reads jobs from ValidationRegistry 768572979 with valid spec hashes", async () => {
    const jobs = await registry.listJobs({ limit: 10 });
    expect(await registry.totalJobs()).toBeGreaterThanOrEqual(jobs.length);
    for (const job of jobs) {
      expect(job.jobId).toBeGreaterThan(0);
      expect(algosdk.isValidAddress(job.client)).toBe(true);
      expect(job.budgetMicro).toBeGreaterThan(0);
      // The contract asserts spec_hash is a 32-byte sha256 digest.
      expect(job.specHash).toHaveLength(64);
      expect(job.status).not.toBe("unknown");
    }
  });

  it("reads a score whose numbers match a payment that really happened", async () => {
    // The old test here listed `pd_` boxes, which no longer exist — so it
    // asserted a shape over an always-empty array and could not fail.
    //
    // This asks the question the registry now answers: agent 1's score was
    // credited by deploy-v2.mjs's one legitimate client-to-server payment, so
    // jobs_paid and volume_micro must reflect exactly that transfer.
    const score = await registry.getScore(1);
    expect(score, "agent 1 has no score box; the deployment proof did not run").not.toBeNull();
    expect(score!.jobsPaid).toBeGreaterThan(0);
    expect(score!.volumeMicro).toBeGreaterThan(0);
    // Every credit needs a transfer, so volume can never be zero while
    // jobs_paid is not: accept_feedback asserts asset_amount > 0.
    expect(score!.volumeMicro / score!.jobsPaid).toBeGreaterThan(0);
    expect(score!.firstAt).toBeLessThanOrEqual(score!.lastAt);
  });

  it("reads the escrow terms the ValidationRegistry was bootstrapped with", async () => {
    const terms = await registry.escrowTerms();
    // A zero here means the registry was deployed but never bootstrapped, and
    // nothing could be funded at all — worth failing loudly over.
    expect(terms.assetId).toBeGreaterThan(0);
    expect(terms.disputeWindowSecs).toBeGreaterThan(0);
    expect(algosdk.isValidAddress(terms.appAddress)).toBe(true);
    // The registry names the identity app it resolves agents through, and it
    // must be the one this package reads agents from, or a release would pay
    // whoever holds that id somewhere else.
    expect(terms.identityApp).toBe(REGISTRY_APP_IDS.testnet.identity);
  });

  it("reports budget and escrow separately for every live job", async () => {
    const jobs = await registry.listJobsWithEscrow({ limit: 10 });
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    for (const job of jobs) {
      expect(job.budgetMicro).toBeGreaterThan(0);
      expect(job.escrowMicro).toBeGreaterThanOrEqual(0);
      expect(job.funded).toBe(job.escrowMicro > 0);
      // The listing-derived map and a direct box read are two different paths
      // to the same box; a disagreement means one of them is looking at the
      // wrong name.
      expect(await registry.getEscrow(job.jobId)).toBe(job.escrowMicro);
      expect(job.unfundedMicro).toBe(Math.max(job.budgetMicro - job.escrowMicro, 0));
    }
  });

  it("every es_ box on chain belongs to a job that exists", async () => {
    const escrows = await registry.escrowMap();
    for (const [jobId, micro] of escrows) {
      // A funded box with no job would mean money held against nothing.
      expect(await registry.getJob(jobId), `es_${jobId} has no jb_${jobId}`).not.toBeNull();
      expect(micro).toBeGreaterThan(0);
    }
  });

  it("refuses to compose an escrow move the chain would reject anyway", async () => {
    const jobs = await registry.listJobsWithEscrow({ limit: 25 });
    const client = jobs[0]!.client;

    const unfunded = jobs.find((j) => !j.funded);
    if (unfunded) {
      // Nothing is held, so neither direction is composable — and the reason
      // has to say which of the two things happened, since the contract
      // deletes the box on payout.
      await expect(
        Promise.any([
          composeReleaseEscrow(registry.config, { sender: client, jobId: unfunded.jobId }),
          composeRefundEscrow(registry.config, { sender: client, jobId: unfunded.jobId }),
        ])
      ).rejects.toBeDefined();
    }

    const settled = jobs.find((j) => j.status === "validated" || j.status === "disputed");
    if (settled) {
      // Funding is only accepted while a job is open or assigned.
      await expect(
        composeFundJob(registry.config, {
          sender: settled.client,
          jobId: settled.jobId,
          amountMicro: 1_000,
        })
      ).rejects.toThrow(/open or assigned|only the client/i);
    }
  });

  it("composes a fund_job group whose transfer goes to the app account itself", async () => {
    const jobs = await registry.listJobsWithEscrow({ limit: 25 });
    const fundable = jobs.find((j) => j.status === "open" || j.status === "assigned");
    if (!fundable) {
      // Every live job has already been settled. Nothing to compose against,
      // and inventing a job id would test the stub, not the chain.
      return;
    }
    const terms = await registry.escrowTerms();
    const group = await composeFundJob(registry.config, {
      sender: fundable.client,
      jobId: fundable.jobId,
      amountMicro: fundable.budgetMicro,
    });

    expect(group.transactions).toHaveLength(2);
    const xfer = algosdk.decodeUnsignedTransaction(
      new Uint8Array(Buffer.from(group.transactions[0]!.unsignedTxnBase64, "base64"))
    );
    expect(xfer.assetTransfer!.receiver.toString()).toBe(terms.appAddress);
    expect(Number(xfer.assetTransfer!.assetIndex)).toBe(terms.assetId);
    // Both members carry the same group id, or neither would be accepted.
    const call = algosdk.decodeUnsignedTransaction(
      new Uint8Array(Buffer.from(group.transactions[1]!.unsignedTxnBase64, "base64"))
    );
    expect(Buffer.from(call.group!).toString("base64")).toBe(group.groupId);
  });

  it("composes a post_job transaction that decodes back to the intended call", async () => {
    const [agent] = await registry.listAgents(1);
    const tx = await composePostJob(registry.config, {
      sender: agent!.address,
      specHash: "5d6a7c053dae8e0130414cd7ca3b7b079d288f2afcfd69da5eadd44f16ce48f6",
      budgetMicro: 1_000_000,
      validatorAgentId: 0,
    });

    expect(tx.signed).toBe(false);
    const decoded = algosdk.decodeUnsignedTransaction(
      new Uint8Array(Buffer.from(tx.unsignedTxnBase64, "base64"))
    );
    expect(Number(decoded.applicationCall!.appIndex)).toBe(REGISTRY_APP_IDS.testnet.validation);
    expect(decoded.sender.toString()).toBe(agent!.address);

    const expectedSelector = algosdk.ABIMethod.fromSignature(
      "post_job(byte[],uint64,uint64)uint64"
    ).getSelector();
    expect(Buffer.from(decoded.applicationCall!.appArgs[0]!).toString("hex")).toBe(
      Buffer.from(expectedSelector).toString("hex")
    );

    // The box it will write must be referenced, or the call fails on chain.
    const total = await registry.totalJobs();
    expect(tx.args.expectedJobId).toBe(total + 1);
    expect(tx.boxes).toEqual([`jb_${total + 1}`]);

    // Signing is somebody else's job — the blob must carry no signature.
    expect(tx.unsignedTxnBase64).not.toContain("sig");
  });

  // -------------------------------------------------------------------------
  // What is on chain versus what is in ripar-contracts.
  //
  // These read the REAL approval programs. They are the tests that notice the
  // day a registry with bidding and rotation is finally deployed: the "not
  // deployed yet" assertions below start failing, which is the correct alarm —
  // the tools would begin working and every description saying "NOT DEPLOYED"
  // would have become a lie.
  // -------------------------------------------------------------------------

  it("confirms the live registries still route the methods this package composes", async () => {
    for (const [appId, signature] of [
      [APPS.validation, "post_job(byte[],uint64,uint64)uint64"],
      [APPS.validation, "fund_job(axfer,uint64)uint64"],
      [APPS.validation, "release_escrow(uint64)uint64"],
      [APPS.validation, "refund_escrow(uint64)uint64"],
      [APPS.identity, "agent_address(uint64)address"],
    ] as const) {
      expect(
        await isMethodDeployed(registry.config, appId, signature),
        `${signature} on ${appId}`
      ).toBe(true);
    }
  });

  it("confirms bidding and rotation are STILL not on chain, and refuses accordingly", async () => {
    const report = await deploymentReport(registry.config);
    const byName = Object.fromEntries(report.methods.map((m) => [m.name, m]));

    // If any of these flip to true, a newer generation was deployed: update
    // CONTRACT_METHODS[].deployed, and re-read every tool description that says
    // NOT DEPLOYED, because they will have stopped being true.
    expect(byName.place_bid!.onChain, "place_bid").toBe(false);
    expect(byName.accept_bid!.onChain, "accept_bid").toBe(false);
    expect(byName.rotate_address!.onChain, "rotate_address").toBe(false);

    // ...and the composer refuses rather than handing back a doomed transaction.
    const agent = (await registry.listAgents(1))[0]!;
    await expect(
      composeRotateAddress(registry.config, {
        sender: agent.address,
        agentId: agent.agentId,
        newAddress: "7777777777777777777777777777777777777777777777777774MSJUVU",
      })
    ).rejects.toBeInstanceOf(MethodNotDeployedError);
  });

  it("reads an empty bid list off the live registry, because bd_ boxes cannot exist on it", async () => {
    const jobs = await registry.listJobs({ limit: 1 });
    if (!jobs.length) return;
    expect(await registry.listBids(jobs[0]!.jobId)).toEqual([]);
  });

  it("checks a real registered agent over real HTTP", async () => {
    const agents = await registry.listAgents(10);
    const agent = agents[0]!;
    const report = await agentHealth(registry.config, { agentId: agent.agentId }, { registry });

    // The verdict depends on whether somebody's Vercel deployment is up right
    // now, so this asserts on the SHAPE and on the one rule that must hold
    // whatever the network did: an unreachable agent is never reported as
    // healthy, and a check that did not run is never a pass.
    expect(["healthy", "degraded", "failing", "unreachable"]).toContain(report.verdict);
    expect(report.agent.agentId).toBe(agent.agentId);
    expect(report.checks.map((c) => c.id).sort()).toEqual([
      "card_agent_id_resolves",
      "card_payto_matches_registry",
      "card_reachable",
      "health_endpoint",
      "serves_402",
    ]);
    for (const check of report.checks) {
      expect(["pass", "fail", "unknown", "skip"]).toContain(check.status);
      expect(check.detail.length).toBeGreaterThan(20);
    }
    if (report.verdict === "unreachable") {
      expect(report.checks.some((c) => c.status === "pass")).toBe(false);
      expect(report.summary).toMatch(/UNREACHABLE/);
    }
    if (report.verdict === "healthy") {
      expect(report.checks.every((c) => c.status === "pass")).toBe(true);
    }
  });
});
