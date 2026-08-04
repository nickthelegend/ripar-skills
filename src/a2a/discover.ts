/**
 * `discoverAgent(url)` — the A2A half of A2MCP.
 *
 * Give it a domain and it comes back with a validated card, plus (optionally)
 * an on-chain check of whether the card is telling the truth about itself.
 *
 * That second part matters more than it sounds. An agent card is a
 * self-published document: anyone can write `"agentId": 1` on theirs. The check
 * here reads the IdentityRegistry for that id and compares the domain the
 * *contract* holds against the host the card was actually fetched from. If they
 * disagree, the card is impersonating a registered agent, and `verified` is
 * false with a reason — never silently downgraded to "probably fine".
 */

import { RiparRegistry } from "../registry.js";
import type { RiparConfigInput } from "../config.js";
import {
  AgentCardError,
  WELL_KNOWN_PATHS,
  parseAgentCard,
  type ParsedAgentCard,
} from "./card.js";

export type DiscoverOptions = {
  fetch?: typeof fetch;
  /** Milliseconds before giving up on the fetch. */
  timeoutMs?: number;
  /**
   * Check the card's registry claim against the IdentityRegistry. On by
   * default — the whole point of pairing a card with a chain is that you can.
   */
  verifyOnChain?: boolean;
  registry?: RiparRegistry;
  config?: RiparConfigInput;
};

export type DiscoveryResult = ParsedAgentCard & {
  /** The exact URL the card came from. */
  source: string;
  verification: {
    checked: boolean;
    /** True only when an on-chain record exists AND its domain matches the host. */
    verified: boolean;
    reason: string;
    onChain?: { agentId: number; domain: string; address: string } | null;
  };
};

/**
 * Turn whatever the caller typed into candidate card URLs.
 *
 * Accepts `example.com`, `https://example.com`, `https://example.com/`, or a
 * direct link to the card itself. A bare host gets `https://` — never `http://`,
 * because silently downgrading a peer lookup to plaintext is how you get
 * man-in-the-middled into paying the wrong account.
 */
export function cardUrlCandidates(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed) throw new AgentCardError("discoverAgent needs a url or domain");

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new AgentCardError(`Not a usable url or domain: ${input}`);
  }

  // A path that already names a card is used as-is.
  if (/\/(agent|agent-card)\.json$/.test(parsed.pathname)) return [parsed.toString()];

  const base = `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}`;
  return WELL_KNOWN_PATHS.map((p) => `${base}${p}`);
}

export async function discoverAgent(
  url: string,
  opts: DiscoverOptions = {}
): Promise<DiscoveryResult> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const candidates = cardUrlCandidates(url);

  const failures: string[] = [];
  let found: { body: unknown; source: string } | null = null;

  for (const candidate of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(candidate, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) {
        failures.push(`${candidate} -> ${res.status} ${res.statusText}`);
        continue;
      }
      found = { body: await res.json(), source: candidate };
      break;
    } catch (err) {
      failures.push(`${candidate} -> ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  if (!found) {
    throw new AgentCardError(`No agent card at ${url}`, failures);
  }

  const parsed = parseAgentCard(found.body, found.source);

  const verification: DiscoveryResult["verification"] = {
    checked: false,
    verified: false,
    reason: "on-chain verification was not requested",
  };

  if (opts.verifyOnChain !== false) {
    verification.checked = true;
    if (!parsed.registry?.agentId) {
      verification.reason = "the card claims no registry agentId, so there is nothing to verify";
      verification.onChain = null;
    } else {
      const registry = opts.registry ?? new RiparRegistry(opts.config);
      try {
        const onChain = await registry.getAgent(parsed.registry.agentId);
        if (!onChain) {
          verification.reason = `agent ${parsed.registry.agentId} is not in the IdentityRegistry`;
          verification.onChain = null;
        } else {
          verification.onChain = {
            agentId: onChain.agentId,
            domain: onChain.domain,
            address: onChain.address,
          };
          const cardHost = new URL(found.source).host.toLowerCase();
          const chainHost = onChain.domain.toLowerCase().replace(/^https?:\/\//, "").split("/")[0]!;
          if (chainHost === cardHost) {
            verification.verified = true;
            verification.reason = `agent ${onChain.agentId} is registered to ${onChain.domain}, which matches the host that served this card`;
          } else {
            verification.reason =
              `the card was served from ${cardHost} but agent ${onChain.agentId} is registered to ` +
              `${onChain.domain} — treat this card as impersonating a registered agent`;
          }
        }
      } catch (err) {
        verification.reason = `could not reach the registry to check: ${(err as Error).message}`;
      }
    }
  }

  return { ...parsed, source: found.source, verification };
}
