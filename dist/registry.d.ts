/**
 * The read side: every function here answers a question with bytes that are
 * currently on Algorand TestNet.
 *
 * There is no cache, no seed data and no fallback. If algod is unreachable the
 * call throws — an agent acting on a fabricated reputation score is worse than
 * an agent that knows it could not check.
 */
import { type Agent, type Job, type Score } from "./abi.js";
import { type RiparConfig, type RiparConfigInput } from "./config.js";
export declare class RiparReadError extends Error {
    readonly code: "not_found" | "network" | "bad_response" | "no_registry";
    constructor(message: string, code?: "not_found" | "network" | "bad_response" | "no_registry");
}
export declare class RiparRegistry {
    readonly config: RiparConfig;
    constructor(input?: RiparConfigInput);
    private appId;
    private json;
    /** One box value, or null when the box does not exist. */
    readBox(appId: number, name: Uint8Array): Promise<Uint8Array | null>;
    /**
     * All box names for an app, filtered to one prefix.
     *
     * Paginated deliberately. algod's `max=` is NOT a truncating limit — it
     * answers HTTP 400 "Result limit exceeded" the moment an app holds more boxes
     * than the number given, so a registry that outgrows a single page would make
     * every listing fail with an opaque 400 instead of returning what it has.
     * `limit=` plus the `next-token` cursor is the paginating form, and `prefix=`
     * filters server-side so a page only carries boxes that were asked for. The
     * client-side prefix check stays as a guard against a node that ignores it.
     *
     * If the cursor never runs out, this throws rather than returning a partial
     * list: a short answer that looks complete is the one failure mode this
     * package exists to avoid.
     */
    listBoxNames(appId: number, prefix: string, pageSize?: number, maxPages?: number): Promise<Uint8Array[]>;
    private globalUint;
    /** Total registered agents, from the contract's own `agent_count`. */
    totalAgents(): Promise<number>;
    getAgent(agentId: number): Promise<Agent | null>;
    /** 0 means not registered. The contract's own comment insists callers check. */
    resolveByDomain(domain: string): Promise<number>;
    resolveByAddress(address: string): Promise<number>;
    /** Every agent record, newest id last. Registries are small; this is one scan. */
    listAgents(limit?: number): Promise<Agent[]>;
    /**
     * Substring match over domains, plus exact matches on an id or an address.
     * Deliberately not fuzzy: an agent picked by a near-miss is an agent paid by
     * mistake.
     */
    searchAgents(query?: string, limit?: number): Promise<Agent[]>;
    /** null when the agent has never been paid — an absent box, not a zero score. */
    getScore(agentId: number): Promise<Score | null>;
    /** Which agent a payment was credited to, or 0 if it was never counted. */
    wasCounted(txId: string): Promise<number>;
    /** Every payment id the reputation registry has already credited. */
    countedPaymentIds(): Promise<string[]>;
    totalJobs(): Promise<number>;
    getJob(jobId: number): Promise<Job | null>;
    listJobs(opts?: {
        status?: string;
        agentId?: number;
        limit?: number;
    }): Promise<Job[]>;
    /**
     * x402 settlements for an agent: real USDC asset transfers, read off the
     * indexer, each annotated with whether the reputation registry has already
     * counted it.
     *
     * The join is the point. A transfer proves money moved; the `pd_` box proves
     * it was turned into reputation exactly once. `counted: false` on an inbound
     * payment is a real, actionable gap — someone still has to call
     * `accept_feedback` for that txid — and it is only visible because the two
     * sources are read together.
     */
    settlements(opts: {
        address?: string;
        agentId?: number;
        limit?: number;
    }): Promise<{
        address: string;
        agentId: number | null;
        asset: {
            id: number;
            symbol: string;
            decimals: number;
        };
        transfers: Settlement[];
        totals: {
            received: number;
            sent: number;
            receivedUsdc: string;
            countedReceived: number;
        };
        explorer: string;
    }>;
}
export type Settlement = {
    txId: string;
    direction: "in" | "out";
    counterparty: string;
    amountMicro: number;
    amountUsdc: string;
    round: number;
    timestamp: string | null;
    note: string | null;
    countedInReputation: boolean;
    explorer: string;
};
export declare function microToUsdc(micro: number): string;
