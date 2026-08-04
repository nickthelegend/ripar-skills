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
import { type ParsedAgentCard } from "./card.js";
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
        onChain?: {
            agentId: number;
            domain: string;
            address: string;
        } | null;
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
export declare function cardUrlCandidates(input: string): string[];
export declare function discoverAgent(url: string, opts?: DiscoverOptions): Promise<DiscoveryResult>;
