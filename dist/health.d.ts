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
import { RiparRegistry } from "./registry.js";
import { type RiparConfig } from "./config.js";
/**
 * `pass` — checked and correct. `fail` — checked and wrong. `unknown` — the
 * check could not be run, which is NOT a pass. `skip` — the check does not
 * apply to this agent (it advertises no paid endpoint, say).
 */
export type CheckStatus = "pass" | "fail" | "unknown" | "skip";
export type HealthCheck = {
    id: "card_reachable" | "health_endpoint" | "card_payto_matches_registry" | "card_agent_id_resolves" | "serves_402";
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
/**
 * Run every check against one registered agent.
 *
 * The agent must be in the IdentityRegistry: this compares a card against a
 * record, so without the record there is nothing to compare to and the honest
 * response is to refuse rather than to grade a self-published document against
 * itself.
 */
export declare function agentHealth(config: RiparConfig, input: {
    agentId?: number;
    domain?: string;
    address?: string;
}, opts?: AgentHealthOptions): Promise<AgentHealthReport>;
