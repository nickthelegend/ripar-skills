/**
 * MCP resources: the registries as documents you can read rather than calls you
 * have to make.
 *
 * Tools and resources answer different questions. A tool is something a model
 * chooses to DO, and every one of them takes arguments a model has to guess at.
 * A resource is something a client can put in front of the model — or in front
 * of a person — without anyone deciding to invoke anything: `ripar://agents` is
 * a list a user can browse in their client's resource picker and attach to a
 * conversation, and `ripar://job/2` is a permalink to one job that can be
 * pasted, bookmarked, or re-read later.
 *
 * The templates enumerate. `ripar://agent/{agentId}` ships a `list` callback, so
 * every registered agent shows up in `resources/list` as its own entry with its
 * real domain as the title — a client can show the actual roster rather than a
 * URI pattern the user is expected to fill in themselves.
 *
 * **Every read here hits the chain, on every read.** There is no cache, and
 * that is deliberate: a stale escrow figure is worse than a slow one, because a
 * cached "escrow 1.0" on a job whose escrow was released half a minute ago is a
 * number that will get somebody to do unpaid work. If algod is unreachable the
 * read fails loudly. The one thing a resource must never do is answer from
 * memory while looking like it answered from the chain.
 */

import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";

import { microToUsdc, type RiparRegistry } from "../registry.js";
import type { RiparConfig } from "../config.js";
import { explorerAddressUrl, explorerAppUrl } from "../config.js";

export type ResourceContext = { registry: RiparRegistry; config: RiparConfig };

export const RESOURCE_URIS = {
  registries: "ripar://registries",
  agents: "ripar://agents",
  agent: "ripar://agent/{agentId}",
  jobs: "ripar://jobs",
  job: "ripar://job/{jobId}",
} as const;

/** BigInt arrives from ABI decoding and JSON.stringify throws on it outright. */
function json(uri: URL | string, value: unknown): ReadResourceResult {
  return {
    contents: [
      {
        uri: String(uri),
        mimeType: "application/json",
        text: JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
      },
    ],
  };
}

/** The id out of `ripar://agent/7`. Anything else is not a resource we have. */
function idFromUri(uri: URL, variable: string | string[] | undefined, kind: string): number {
  const raw = Array.isArray(variable) ? variable[0] : variable;
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) {
    throw new Error(`${uri} is not a ${kind} URI: "${raw}" is not a positive integer id`);
  }
  return id;
}

export function registerRiparResources(server: McpServer, ctx: ResourceContext): void {
  const { registry, config } = ctx;

  // --- Where everything lives, and on what terms. One read, and it answers the
  // three questions every other resource assumes you already know: which apps,
  // which asset, and how long the dispute window is.
  server.registerResource(
    "ripar-registries",
    RESOURCE_URIS.registries,
    {
      title: "Ripar registries",
      description:
        "The three live registry app ids, the endpoints they are read from, and the escrow terms " +
        "the ValidationRegistry was bootstrapped with — asset, dispute window, and the app account " +
        "that holds escrowed funds. Read from the contract's own global state, not from constants.",
      mimeType: "application/json",
    },
    async (uri) => {
      const terms = await registry.escrowTerms();
      return json(uri, {
        network: config.network,
        endpoints: { algod: config.algod, indexer: config.indexer },
        apps: {
          identity: {
            appId: config.appIds.identity,
            explorer: explorerAppUrl(config, config.appIds.identity),
          },
          reputation: {
            appId: config.appIds.reputation,
            explorer: explorerAppUrl(config, config.appIds.reputation),
          },
          validation: {
            appId: config.appIds.validation,
            explorer: explorerAppUrl(config, config.appIds.validation),
          },
        },
        escrow: {
          assetId: terms.assetId,
          disputeWindowSecs: terms.disputeWindowSecs,
          heldBy: terms.appAddress,
          explorer: explorerAddressUrl(config, terms.appAddress),
          note:
            "The asset and the window are fixed at bootstrap, not per job — an escrow whose asset " +
            "the caller picks can be funded with something worthless, and a window the client sets " +
            "can be set to zero.",
        },
        // What the ValidationRegistry itself believes it is wired to. If either
        // disagrees with `apps` above, one of the two is pointed at a redeploy.
        bootstrappedTo: {
          identityApp: terms.identityApp,
          reputationApp: terms.reputationApp,
        },
      });
    }
  );

  // --- The roster.
  server.registerResource(
    "ripar-agents",
    RESOURCE_URIS.agents,
    {
      title: "Registered agents",
      description:
        "Every agent in the IdentityRegistry: id, domain, controlling address, and where its A2A " +
        "card should be. This is the check that tells you whether a domain claiming to be an agent " +
        "actually is one.",
      mimeType: "application/json",
    },
    async (uri) => {
      const agents = await registry.listAgents(1000);
      return json(uri, {
        network: config.network,
        identityApp: config.appIds.identity,
        total: await registry.totalAgents(),
        count: agents.length,
        agents: agents.map((a) => ({
          ...a,
          cardUrl: `https://${a.domain}/.well-known/agent.json`,
          explorer: explorerAddressUrl(config, a.address),
          resource: `ripar://agent/${a.agentId}`,
        })),
      });
    }
  );

  // --- One agent, with the two things you would immediately go and look up.
  server.registerResource(
    "ripar-agent",
    new ResourceTemplate(RESOURCE_URIS.agent, {
      // Enumerating means a client's resource picker shows the real roster, so
      // a user never has to know an id before they can look at one.
      list: async () => {
        const agents = await registry.listAgents(1000);
        return {
          resources: agents.map((a) => ({
            uri: `ripar://agent/${a.agentId}`,
            name: `agent-${a.agentId}`,
            title: `${a.domain} (agent ${a.agentId})`,
            description: `IdentityRegistry record for ${a.domain}, controlled by ${a.address}.`,
            mimeType: "application/json",
          })),
        };
      },
    }),
    {
      title: "One agent",
      description:
        "An agent's registry record, its reputation score, and the jobs it is serving or " +
        "validating with the escrow held for each. A score of null means it has never been paid " +
        "at all, which is different from having been paid and scored zero.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const agentId = idFromUri(uri, variables.agentId, "ripar://agent/{agentId}");
      const agent = await registry.getAgent(agentId);
      if (!agent) {
        return json(uri, {
          found: false,
          agentId,
          reason: "the IdentityRegistry has no record for this id",
        });
      }
      const [score, jobs] = await Promise.all([
        registry.getScore(agentId),
        registry.listJobsWithEscrow({ agentId }),
      ]);
      return json(uri, {
        found: true,
        network: config.network,
        agent,
        cardUrl: `https://${agent.domain}/.well-known/agent.json`,
        explorer: explorerAddressUrl(config, agent.address),
        score,
        ...(score
          ? { volumeUsdc: microToUsdc(score.volumeMicro) }
          : { scoreNote: `agent ${agentId} has no score box, so it has never been paid through Ripar` }),
        jobs,
      });
    }
  );

  // --- The job board, which is the one a bidding agent wants.
  server.registerResource(
    "ripar-jobs",
    RESOURCE_URIS.jobs,
    {
      title: "Jobs, with budget and escrow",
      description:
        "Every job on the ValidationRegistry with BOTH money numbers: budget, what the client says " +
        "the work is worth, and escrow, what they have actually handed to the contract. Budget 1.0 " +
        "with escrow 0 is an unfunded job.",
      mimeType: "application/json",
    },
    async (uri) => {
      const [jobs, terms, total] = await Promise.all([
        registry.listJobsWithEscrow({ limit: 1000 }),
        registry.escrowTerms(),
        registry.totalJobs(),
      ]);
      return json(uri, {
        network: config.network,
        validationApp: config.appIds.validation,
        total,
        count: jobs.length,
        escrow: {
          assetId: terms.assetId,
          heldBy: terms.appAddress,
          disputeWindowSecs: terms.disputeWindowSecs,
          fundedJobs: jobs.filter((j) => j.funded).length,
          totalEscrowedUsdc: microToUsdc(jobs.reduce((s, j) => s + j.escrowMicro, 0)),
        },
        jobs: jobs.map((j) => ({ ...j, resource: `ripar://job/${j.jobId}` })),
      });
    }
  );

  // --- One job.
  server.registerResource(
    "ripar-job",
    new ResourceTemplate(RESOURCE_URIS.job, {
      list: async () => {
        const jobs = await registry.listJobsWithEscrow({ limit: 1000 });
        return {
          resources: jobs.map((j) => ({
            uri: `ripar://job/${j.jobId}`,
            name: `job-${j.jobId}`,
            title: `Job ${j.jobId} — ${j.status}, budget ${j.budgetUsdc}, escrow ${j.escrowUsdc}`,
            description: `ValidationRegistry job ${j.jobId}, posted by ${j.client}.`,
            mimeType: "application/json",
          })),
        };
      },
    }),
    {
      title: "One job",
      description:
        "A single job: its lifecycle state, the agents serving and validating it, the spec and " +
        "result hashes it committed to, and what is actually escrowed for it right now.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const jobId = idFromUri(uri, variables.jobId, "ripar://job/{jobId}");
      const [job, terms] = await Promise.all([
        registry.getJobWithEscrow(jobId),
        registry.escrowTerms(),
      ]);
      if (!job) {
        return json(uri, {
          found: false,
          jobId,
          reason: "the ValidationRegistry has no box for this job id",
        });
      }
      // Only meaningful once a verdict exists, which is exactly when the job is
      // validated — updated_at is the moment that verdict was written.
      const windowClosesAt = job.updatedAt + terms.disputeWindowSecs;
      return json(uri, {
        found: true,
        network: config.network,
        validationApp: config.appIds.validation,
        job,
        escrow: {
          assetId: terms.assetId,
          heldBy: terms.appAddress,
          disputeWindowSecs: terms.disputeWindowSecs,
          ...(job.status === "validated"
            ? {
                anyoneMayReleaseAfter: new Date(windowClosesAt * 1000).toISOString(),
                note: "Until then only the client may release; after it, anyone may.",
              }
            : {}),
        },
        server: job.serverAgentId ? `ripar://agent/${job.serverAgentId}` : null,
        validator: job.validatorAgentId ? `ripar://agent/${job.validatorAgentId}` : null,
      });
    }
  );
}
