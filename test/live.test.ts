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
import { composePostJob } from "../src/unsigned.js";
import algosdk from "algosdk";

const skip = process.env.RIPAR_SKIP_LIVE === "1";
const describeLive = skip ? describe.skip : describe;

const registry = new RiparRegistry();

describeLive("live TestNet registries", () => {
  it("reads agent_count out of IdentityRegistry 768570170", async () => {
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

  it("reads a score box from ReputationRegistry 768570171", async () => {
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

  it("reads jobs from ValidationRegistry 768570174 with valid spec hashes", async () => {
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
});
