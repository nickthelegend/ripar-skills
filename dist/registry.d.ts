/**
 * The read side: every function here answers a question with bytes that are
 * currently on Algorand TestNet.
 *
 * There is no cache, no seed data and no fallback. If algod is unreachable the
 * call throws — an agent acting on a fabricated reputation score is worse than
 * an agent that knows it could not check.
 */
import { type Agent, type Bid, type Job, type Score } from "./abi.js";
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
    listBoxNames(appId: number, 
    /**
     * A text prefix like `ag_`, or raw bytes when the key is not text —
     * `bd_` + itob(job_id) selects one job's bids and those 8 bytes are not
     * UTF-8. Encoding them as text would mangle every byte above 0x7f and the
     * filter would silently match nothing.
     */
    prefix: string | Uint8Array, pageSize?: number, maxPages?: number): Promise<Uint8Array[]>;
    /**
     * Several global-state uints from ONE request. Reading them one at a time
     * would fetch the whole application record — approval program included —
     * once per key, and three keys is the normal case for the escrow terms.
     */
    private globalUints;
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
    totalJobs(): Promise<number>;
    getJob(jobId: number): Promise<Job | null>;
    listJobs(opts?: {
        status?: string;
        agentId?: number;
        limit?: number;
    }): Promise<Job[]>;
    /**
     * Every bid on one job, cheapest first.
     *
     * One server-side-filtered listing over `bd_` + itob(job_id), then a read per
     * box. The composite key is what makes that possible: the job id is the first
     * half, so algod's `prefix=` does the selection and this never sees a bid on
     * another job.
     *
     * **Losing bids are kept deliberately.** `accept_bid` does NOT sweep the
     * boxes it rejected — a board that erases what it turned down cannot be
     * checked afterwards, and "we picked the cheapest" is a claim you should be
     * able to verify against the ones that lost. So a bid appearing here does not
     * mean it is live: read the JOB's status alongside. Only a bid on an OPEN job
     * can still be accepted, and only the bidder can remove their own.
     *
     * An empty list is a real answer, and on the CURRENTLY DEPLOYED
     * ValidationRegistry (768634000) it is the only answer this can give: that
     * app predates `place_bid`, so no `bd_` box exists or can exist on it. See
     * `deployed.ts` — the reads here are honest either way, and it is the WRITE
     * path that has to refuse.
     */
    listBids(jobId: number, limit?: number): Promise<Bid[]>;
    /**
     * What is actually held for a job, in base units. 0 when nothing is.
     *
     * This reads the `es_` box rather than calling the contract's own
     * `get_escrow`, and the two cannot disagree — the method is `readonly` and
     * its whole body is that box lookup with the same absent-means-zero rule.
     * Calling it would mean composing an app call with the right box reference
     * and simulating it; the box read is the same fact over a plain GET.
     */
    getEscrow(jobId: number): Promise<number>;
    /**
     * Every funded job, as job id -> base units.
     *
     * One listing rather than a box read per job, and the listing is exhaustive
     * by construction: an `es_` box exists only while money is held, so the boxes
     * that come back ARE the funded set and every job not in this map is
     * unfunded. Jobs are read separately, so a job whose escrow was released
     * between the two calls simply reads 0 — which is what it now is.
     */
    escrowMap(): Promise<Map<number, number>>;
    /**
     * The escrow terms, read off the ValidationRegistry's global state.
     *
     * Fixed at bootstrap and not per job, so a caller cannot be talked into
     * funding an escrow denominated in something worthless. `appAddress` is where
     * a funding transfer has to go — derived from the app id, so it is not a
     * number anyone can substitute.
     */
    escrowTerms(): Promise<EscrowTerms>;
    /** One job, with what is actually escrowed for it. */
    getJobWithEscrow(jobId: number): Promise<JobWithEscrow | null>;
    /** As listJobs, plus the escrow held for each — one extra listing in total. */
    listJobsWithEscrow(opts?: {
        status?: string;
        agentId?: number;
        limit?: number;
    }): Promise<JobWithEscrow[]>;
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
        };
        /** The agent's score, when it has one. This is what the chain records about
         *  credited work — there is no per-transfer credit flag to read. */
        score: Score | null;
        explorer: string;
    }>;
}
export type EscrowTerms = {
    validationApp: number;
    /** The account that holds funded escrow — the app's own address. */
    appAddress: string;
    /** The ASA escrow is denominated in. 0 when the registry was never bootstrapped. */
    assetId: number;
    /** Seconds after a passing verdict before anyone at all may release. */
    disputeWindowSecs: number;
    identityApp: number;
    reputationApp: number;
};
/**
 * A job plus the money question a bidder actually has.
 *
 * Budget and escrow are different facts. The budget is what the client SAYS the
 * work is worth; the escrow is what they have handed to the contract. A job
 * showing budget 1.0 and escrow 0 is unfunded — the budget is an intention, not
 * a guarantee — and that is the single most useful thing to know before bidding.
 */
export type JobWithEscrow = Job & {
    budgetUsdc: string;
    escrowMicro: number;
    escrowUsdc: string;
    /** True when the contract holds anything at all for this job. */
    funded: boolean;
    /** True when it holds at least the stated budget. */
    fullyFunded: boolean;
    /** Budget still not backed by money, in base units. 0 when fully funded. */
    unfundedMicro: number;
};
export declare function withEscrow(job: Job, escrowMicro: number): JobWithEscrow;
export type Settlement = {
    txId: string;
    direction: "in" | "out";
    counterparty: string;
    amountMicro: number;
    amountUsdc: string;
    round: number;
    timestamp: string | null;
    note: string | null;
    explorer: string;
};
export declare function microToUsdc(micro: number): string;
