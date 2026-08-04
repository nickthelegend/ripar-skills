/**
 * "Is this agent actually there, and is it the agent the registry says it is?"
 *
 * This is the check somebody runs before paying a stranger. Everything else in
 * this package reads the chain, and the chain is very good at telling you what
 * was WRITTEN — an agent id, a domain, a controlling address, a score. It
 * cannot tell you whether anything is still running at that domain, or whether
 * the document being served there agrees with the record.
 *
 * Those two can drift apart in ways that matter and that neither side notices:
 *
 *   - The agent is registered and dead. The score stays. A client picks it on
 *     reputation, posts work, and waits.
 *   - The card's `payTo` is not the registry's address. Either the operator
 *     rotated a key and forgot the card, or somebody copied a real agent's card
 *     and changed one field. Both look identical from the chain, and both mean
 *     paying the wrong account.
 *   - The card claims `agentId: 1` and agent 1's registered domain is somebody
 *     else's. That is impersonation, and it is free to attempt.
 *   - The endpoint answers 200 to an unpaid request. Nothing is being charged
 *     for, which may be fine — or may mean the paywall is misconfigured and the
 *     price on the card is fiction.
 *
 * ## Rules this module holds to
 *
 * **Real HTTP, no mocks.** Every finding below comes from a request that was
 * actually made. `fetch` is injectable so tests can drive it, and the injected
 * one is the only thing a test replaces — there is no fixture mode, no "assume
 * healthy", no cached verdict.
 *
 * **Unreachable is reported as unreachable.** Never as agreement, never as a
 * pass, and never folded into a neutral-sounding "could not verify" that a
 * summariser will round up to fine. A check that could not run has status
 * `unknown` and says what failed. The overall verdict is `unreachable` — a
 * distinct outcome from `healthy` and from `failing`, because "I could not
 * reach it" and "it answered and it was wrong" are different facts and a payer
 * needs to tell them apart.
 */

import { discoverAgent } from "./a2a/discover.js";
import { AgentCardError } from "./a2a/card.js";
import { RiparRegistry } from "./registry.js";
import { challengeFromResponse } from "./x402.js";
import { CAIP2, type RiparConfig } from "./config.js";
import type { Agent } from "./abi.js";

/**
 * `pass` — checked and correct. `fail` — checked and wrong. `unknown` — the
 * check could not be run, which is NOT a pass. `skip` — the check does not
 * apply to this agent (it advertises no paid endpoint, say).
 */
export type CheckStatus = "pass" | "fail" | "unknown" | "skip";

export type HealthCheck = {
  id:
    | "card_reachable"
    | "health_endpoint"
    | "card_payto_matches_registry"
    | "card_agent_id_resolves"
    | "serves_402";
  title: string;
  status: CheckStatus;
  /** One sentence a human can act on. Never hedged into meaninglessness. */
  detail: string;
  /** The requests this check actually made, so the answer can be re-run by hand. */
  evidence?: Record<string, unknown>;
};

export type AgentHealthReport = {
  network: string;
  identityApp: number;
  agent: {
    agentId: number;
    domain: string;
    /** The address the REGISTRY holds. The one payments are supposed to go to. */
    address: string;
    registeredAt: number;
    updatedAt: number;
  };
  /**
   * `healthy` — every applicable check passed.
   * `failing` — the agent answered and at least one check came back WRONG.
   * `unreachable` — nothing answered, so nothing was verified.
   * `degraded` — reachable, nothing wrong, but something could not be checked.
   */
  verdict: "healthy" | "degraded" | "failing" | "unreachable";
  /** Plain-language, and allowed to say "do not pay this". */
  summary: string;
  checks: HealthCheck[];
  checkedAt: string;
};

export type AgentHealthOptions = {
  registry?: RiparRegistry;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /**
   * Paths tried for a liveness endpoint, in order, first answer wins.
   *
   * `/health` is the conventional one and is tried first. `/api/health` is here
   * because it is where a Next.js app route lands by default — and where the
   * live Ripar agent's own health endpoint actually is. Probing only `/health`
   * would report a working agent as having none, which is true about the path
   * and false about the agent. Every path tried is reported, so the answer
   * stays checkable rather than depending on this list being right.
   */
  healthPaths?: string[];
};

const DEFAULT_HEALTH_PATHS = ["/health", "/api/health"];

/** Bare host out of whatever the registry holds — `dm_` stores a domain, not a URL. */
function originOf(domain: string): string {
  const withScheme = /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
  return new URL(withScheme).origin;
}

async function fetchWithTimeout(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run every check against one registered agent.
 *
 * The agent must be in the IdentityRegistry: this compares a card against a
 * record, so without the record there is nothing to compare to and the honest
 * response is to refuse rather than to grade a self-published document against
 * itself.
 */
export async function agentHealth(
  config: RiparConfig,
  input: { agentId?: number; domain?: string; address?: string },
  opts: AgentHealthOptions = {}
): Promise<AgentHealthReport> {
  const registry = opts.registry ?? new RiparRegistry(config);
  const doFetch = opts.fetch ?? config.fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const healthPaths = opts.healthPaths ?? DEFAULT_HEALTH_PATHS;

  const agent = await resolveAgent(registry, input);
  const origin = originOf(agent.domain);
  const checks: HealthCheck[] = [];

  // --- 1. The card. Everything else depends on having one, so a failure here
  // short-circuits the checks that would have compared against it.
  let card: Awaited<ReturnType<typeof discoverAgent>> | null = null;
  let cardError: string | null = null;
  try {
    card = await discoverAgent(origin, {
      fetch: doFetch,
      timeoutMs,
      // Discovery's own on-chain check re-reads the registry; this function has
      // already resolved the agent and compares more than the domain below.
      verifyOnChain: false,
    });
    checks.push({
      id: "card_reachable",
      title: "Serves an A2A agent card",
      status: "pass",
      detail: `${card.source} answered with a valid card naming ${card.skills.length} skill(s).`,
      evidence: { url: card.source, endpoint: card.endpoint, skills: card.skills.map((s) => s.id) },
    });
  } catch (err) {
    cardError = err instanceof AgentCardError ? describeCardError(err) : (err as Error).message;
    checks.push({
      id: "card_reachable",
      title: "Serves an A2A agent card",
      status: "fail",
      detail:
        `No usable agent card at ${origin}. ${cardError} ` +
        `The registry says this agent lives here, so either it is down, or it has moved and the ` +
        `registry was never updated. Do not pay it.`,
      evidence: { origin, tried: [`${origin}/.well-known/agent.json`, `${origin}/.well-known/agent-card.json`] },
    });
  }

  // --- 2. Liveness. A card is a static document and a CDN will happily keep
  // serving one for a process that died months ago.
  checks.push(await checkHealthEndpoint(doFetch, origin, healthPaths, timeoutMs));

  // --- 3. Does the card ask for money at the address the registry holds?
  checks.push(payToCheck(agent, card));

  // --- 4. Does the card's own agent id claim survive a registry read?
  checks.push(await agentIdCheck(registry, agent, card, origin));

  // --- 5. Is the paywall real?
  checks.push(await serves402Check(doFetch, config, card, timeoutMs));

  return { ...verdictOf(checks, agent, config), checks, checkedAt: new Date().toISOString() };
}

async function resolveAgent(
  registry: RiparRegistry,
  input: { agentId?: number; domain?: string; address?: string }
): Promise<Agent> {
  if (input.agentId !== undefined) {
    const agent = await registry.getAgent(input.agentId);
    if (!agent) throw new Error(`No agent ${input.agentId} in the IdentityRegistry`);
    return agent;
  }
  if (input.domain) {
    const id = await registry.resolveByDomain(input.domain);
    if (id === 0) {
      throw new Error(
        `${input.domain} is not registered in the IdentityRegistry. There is no on-chain record to ` +
          `check a card against, and grading a self-published document against itself proves nothing.`
      );
    }
    const agent = await registry.getAgent(id);
    if (!agent) throw new Error(`Domain ${input.domain} resolves to agent ${id}, which has no record`);
    return agent;
  }
  if (input.address) {
    const id = await registry.resolveByAddress(input.address);
    if (id === 0) throw new Error(`${input.address} controls no agent in the IdentityRegistry`);
    const agent = await registry.getAgent(id);
    if (!agent) throw new Error(`Address ${input.address} resolves to agent ${id}, which has no record`);
    return agent;
  }
  throw new Error("agentHealth needs one of agentId, domain, or address");
}

function describeCardError(err: AgentCardError): string {
  const detail = (err as AgentCardError & { details?: string[] }).details;
  return detail?.length ? `${err.message}: ${detail.join("; ")}` : err.message;
}

async function checkHealthEndpoint(
  doFetch: typeof fetch,
  origin: string,
  paths: string[],
  timeoutMs: number
): Promise<HealthCheck> {
  const tried: { url: string; status: number | string }[] = [];

  for (const path of paths) {
    const url = `${origin}${path}`;
    try {
      const res = await fetchWithTimeout(doFetch, url, { headers: { accept: "application/json" } }, timeoutMs);
      tried.push({ url, status: res.status });
      if (res.ok) {
        const body = await res.text();
        let parsed: unknown = body;
        try {
          parsed = JSON.parse(body);
        } catch {
          /* a plain-text OK is still an OK */
        }
        return {
          id: "health_endpoint",
          title: "Answers a liveness probe",
          status: "pass",
          detail: `${url} answered ${res.status}. Something is running, not just a cached document.`,
          evidence: { tried, answered: url, body: truncate(parsed) },
        };
      }
    } catch (err) {
      tried.push({ url, status: `${(err as Error).name}: ${(err as Error).message}` });
    }
  }

  // Deliberately `unknown`, not `fail`. A health endpoint is a convention, not
  // a requirement — an agent with none is unproven, not broken, and calling
  // that a failure would train a reader to ignore this check.
  return {
    id: "health_endpoint",
    title: "Answers a liveness probe",
    status: "unknown",
    detail:
      `Nothing answered at ${paths.join(" or ")}. That is not proof the agent is down — a health ` +
      `endpoint is a convention, not part of A2A — but it does mean liveness is UNVERIFIED here. ` +
      `The card being served is not evidence: a CDN keeps serving a static document long after the ` +
      `process behind it dies.`,
    evidence: { tried },
  };
}

function payToCheck(agent: Agent, card: Awaited<ReturnType<typeof discoverAgent>> | null): HealthCheck {
  const title = "Card's payTo is the address the registry holds";
  if (!card) {
    return {
      id: "card_payto_matches_registry",
      title,
      status: "unknown",
      detail: "No card was fetched, so there is no payTo to compare against the registry.",
    };
  }
  const payTo = card.x402?.payTo;
  if (!payTo) {
    return {
      id: "card_payto_matches_registry",
      title,
      status: "skip",
      detail:
        "The card carries no x402 pricing extension, so it names no payment account. Nothing to " +
        "compare — and nothing to pay, either.",
      evidence: { registryAddress: agent.address },
    };
  }
  if (payTo === agent.address) {
    return {
      id: "card_payto_matches_registry",
      title,
      status: "pass",
      detail:
        `The card asks for payment at ${payTo}, which is the address the IdentityRegistry holds for ` +
        `agent ${agent.agentId}. The card's claim about where money goes is backed by a record only ` +
        `that account could have written.`,
      evidence: { cardPayTo: payTo, registryAddress: agent.address },
    };
  }
  return {
    id: "card_payto_matches_registry",
    title,
    status: "fail",
    detail:
      `THE CARD ASKS YOU TO PAY A DIFFERENT ACCOUNT. It names ${payTo}; the registry holds ` +
      `${agent.address} for agent ${agent.agentId}. Either the operator rotated the key and never ` +
      `updated the card, or this card is a copy of a real agent's with the payee swapped. Both look ` +
      `the same from here and both send your money somewhere the chain does not vouch for. Do not pay.`,
    evidence: { cardPayTo: payTo, registryAddress: agent.address },
  };
}

async function agentIdCheck(
  registry: RiparRegistry,
  agent: Agent,
  card: Awaited<ReturnType<typeof discoverAgent>> | null,
  origin: string
): Promise<HealthCheck> {
  const title = "Card's agentId resolves to this agent";
  if (!card) {
    return {
      id: "card_agent_id_resolves",
      title,
      status: "unknown",
      detail: "No card was fetched, so it makes no on-chain claim this could check.",
    };
  }
  const claimed = card.registry?.agentId;
  if (!claimed) {
    return {
      id: "card_agent_id_resolves",
      title,
      status: "fail",
      detail:
        `The card at ${origin} makes NO on-chain identity claim — no registry extension, or an ` +
        `agentId of 0. The registry knows this domain as agent ${agent.agentId}, but the document ` +
        `being served does not say so, so nothing in it is anchored to anything.`,
      evidence: { registryAgentId: agent.agentId, cardAgentId: claimed ?? null },
    };
  }
  if (claimed === agent.agentId) {
    return {
      id: "card_agent_id_resolves",
      title,
      status: "pass",
      detail:
        `The card claims agent ${claimed}, and agent ${claimed}'s registered domain is ` +
        `${agent.domain}, which is where this card was fetched from. The claim closes.`,
      evidence: { registryAgentId: agent.agentId, cardAgentId: claimed, registeredDomain: agent.domain },
    };
  }

  // The card names a DIFFERENT id. Resolve that one too — whose it is, is the
  // most useful thing to say next.
  const other = await registry.getAgent(claimed).catch(() => null);
  return {
    id: "card_agent_id_resolves",
    title,
    status: "fail",
    detail:
      `The card at ${origin} claims to be agent ${claimed}, but this domain is registered as agent ` +
      `${agent.agentId}. Agent ${claimed} is ` +
      (other ? `registered to ${other.domain} (${other.address}).` : `not in the registry at all.`) +
      ` An agent card is self-published and anyone can write any id on theirs; the registry entry ` +
      `is the half that had to be signed. Treat this as impersonation until the operator explains it.`,
    evidence: {
      registryAgentId: agent.agentId,
      cardAgentId: claimed,
      claimedIdBelongsTo: other ? { domain: other.domain, address: other.address } : null,
    },
  };
}

async function serves402Check(
  doFetch: typeof fetch,
  config: RiparConfig,
  card: Awaited<ReturnType<typeof discoverAgent>> | null,
  timeoutMs: number
): Promise<HealthCheck> {
  const title = "Priced endpoint really answers 402";
  if (!card) {
    return {
      id: "serves_402",
      title,
      status: "unknown",
      detail: "No card was fetched, so there is no priced endpoint to probe.",
    };
  }
  const endpoint = card.endpoint;
  const prices = card.x402?.prices ?? {};
  const pricedSkills = Object.entries(prices).filter(([, v]) => Number(v) > 0);
  if (!endpoint || pricedSkills.length === 0) {
    return {
      id: "serves_402",
      title,
      status: "skip",
      detail:
        "The card prices nothing, so there is no paywall to test. A free agent is not a broken one.",
      evidence: { endpoint, prices },
    };
  }

  // The A2A endpoint is the one the card names, and an unpaid POST to it is
  // exactly what a paying client's first request would be. Nothing is paid: no
  // X-PAYMENT header is sent, and this process holds no key to make one.
  let res: Response;
  try {
    res = await fetchWithTimeout(
      doFetch,
      endpoint,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "ripar-health",
          method: "message/send",
          params: { message: { role: "user", parts: [{ kind: "text", text: "health check" }] } },
        }),
      },
      timeoutMs
    );
  } catch (err) {
    return {
      id: "serves_402",
      title,
      status: "unknown",
      detail:
        `Could not reach the priced endpoint ${endpoint}: ${(err as Error).message}. The paywall is ` +
        `UNVERIFIED — this is not a pass, and it is not evidence the endpoint is free either.`,
      evidence: { endpoint, error: (err as Error).message },
    };
  }

  const text = await res.text().catch(() => "");
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep the text */
  }

  if (res.status !== 402) {
    return {
      id: "serves_402",
      title,
      status: "fail",
      detail:
        `The card prices ${pricedSkills.map(([k]) => k).join(", ")}, but an UNPAID request to ` +
        `${endpoint} answered ${res.status}, not 402. ` +
        (res.ok
          ? `It served without asking for payment, so either the paywall is off or the price on the ` +
            `card is fiction. Neither is dangerous to your wallet; both mean the card is not describing ` +
            `what the endpoint does.`
          : `That is an error, not a payment challenge — the endpoint is priced but not currently usable.`),
      evidence: { endpoint, status: res.status, prices, body: truncate(body) },
    };
  }

  const challenge = challengeFromResponse(res, body);
  if (!challenge) {
    return {
      id: "serves_402",
      title,
      status: "fail",
      detail:
        `${endpoint} answered 402 but carried no readable payment requirements — nothing in the ` +
        `\`payment-required\` header and nothing in the body. A challenge a client cannot parse is a ` +
        `paywall nobody can pay through.`,
      evidence: { endpoint, status: 402, body: truncate(body) },
    };
  }

  const best = [...challenge.accepts].sort(
    (a, b) => Number(a.maxAmountRequired) - Number(b.maxAmountRequired)
  )[0]!;
  const wantNetwork = CAIP2[config.network];
  // Prefix comparison, not equality: CAIP-2 caps a network reference at 32
  // characters, so some servers advertise the truncated genesis hash and some
  // the whole thing. Requiring equality would fail correct servers.
  const rightChain =
    best.network.startsWith(wantNetwork) || wantNetwork.startsWith(best.network);
  const cardPayTo = card.x402?.payTo;
  const challengeMatchesCard = !cardPayTo || !best.payTo || best.payTo === cardPayTo;

  const problems = [
    !rightChain && `it wants payment on ${best.network}, not the ${config.network} chain ${wantNetwork}`,
    !best.payTo && "it names no payTo, so the challenge cannot be paid",
    !challengeMatchesCard &&
      `the live challenge pays ${best.payTo} while the card advertises ${cardPayTo} — the endpoint ` +
        `and its own card disagree about who gets the money`,
  ].filter(Boolean) as string[];

  if (problems.length) {
    return {
      id: "serves_402",
      title,
      status: "fail",
      detail: `${endpoint} answered a 402, but ${problems.join("; and ")}.`,
      evidence: { endpoint, challengeFrom: challenge.from, accepts: challenge.accepts, cardPayTo },
    };
  }

  return {
    id: "serves_402",
    title,
    status: "pass",
    detail:
      `An unpaid request to ${endpoint} got a real 402 (challenge read from the ${challenge.from}) ` +
      `asking ${best.maxAmountRequired} base units of asset ${best.asset ?? "unknown"} to ` +
      `${best.payTo} on ${best.network}. The paywall works and agrees with the card.`,
    evidence: { endpoint, challengeFrom: challenge.from, accepts: challenge.accepts },
  };
}

function verdictOf(
  checks: HealthCheck[],
  agent: Agent,
  config: RiparConfig
): Pick<AgentHealthReport, "network" | "identityApp" | "agent" | "verdict" | "summary"> {
  const failed = checks.filter((c) => c.status === "fail");
  const unknown = checks.filter((c) => c.status === "unknown");
  const cardCheck = checks.find((c) => c.id === "card_reachable")!;

  // Nothing answered at all. Reported as its own outcome rather than as a pile
  // of failures, because "the host is down" and "the host lied" call for
  // different responses and only one of them is an accusation.
  const nothingAnswered =
    cardCheck.status === "fail" &&
    checks.every((c) => c.status !== "pass");

  const verdict: AgentHealthReport["verdict"] = nothingAnswered
    ? "unreachable"
    : failed.length
      ? "failing"
      : unknown.length
        ? "degraded"
        : "healthy";

  const head = `Agent ${agent.agentId} (${agent.domain})`;
  const summary =
    verdict === "unreachable"
      ? `${head} did not answer. It is registered on chain and reachable by nobody — UNREACHABLE, ` +
        `which is not the same as failing and is certainly not agreement. Whatever its score says, ` +
        `there is nothing here to do the work.`
      : verdict === "failing"
        ? `${head} answered, and ${failed.length} check(s) came back WRONG: ` +
          `${failed.map((f) => f.title.toLowerCase()).join("; ")}. ` +
          (failed.some((f) => f.id === "card_payto_matches_registry" || f.id === "card_agent_id_resolves")
            ? `At least one of those is an identity mismatch, which is the failure that costs money. Do not pay this agent until it is explained.`
            : `Read the detail before sending anything.`)
        : verdict === "degraded"
          ? `${head} is up and nothing it said was wrong, but ${unknown.length} check(s) could not be ` +
            `run: ${unknown.map((u) => u.title.toLowerCase()).join("; ")}. Unverified, not verified.`
          : `${head} is up, its card matches the registry on both the payment address and the agent ` +
            `id, and its priced endpoint really does charge. Everything checkable checked out.`;

  return {
    network: config.network,
    identityApp: config.appIds.identity,
    agent: {
      agentId: agent.agentId,
      domain: agent.domain,
      address: agent.address,
      registeredAt: agent.registeredAt,
      updatedAt: agent.updatedAt,
    },
    verdict,
    summary,
  };
}

/** Evidence is for a human to read, not a payload to relay. */
function truncate(value: unknown): unknown {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text && text.length > 800) return `${text.slice(0, 800)}… (${text.length} bytes)`;
  return value;
}
