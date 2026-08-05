/**
 * The read side: every function here answers a question with bytes that are
 * currently on Algorand TestNet.
 *
 * There is no cache, no seed data and no fallback. If algod is unreachable the
 * call throws — an agent acting on a fabricated reputation score is worse than
 * an agent that knows it could not check.
 */
import algosdk from "algosdk";
import { addressBoxName, agentBoxName, bidKeyFromBoxName, bidPrefixForJob, decodeAgentBox, decodeBidBox, decodeJobBox, decodeScoreBox, decodeUint64Box, domainBoxName, escrowBoxName, idFromBoxName, jobBoxName, scoreBoxName, } from "./abi.js";
import { BOX_PREFIX, USDC_ASSET_ID, USDC_DECIMALS, explorerAddressUrl, explorerTxUrl, resolveConfig, } from "./config.js";
export class RiparReadError extends Error {
    code;
    constructor(message, code = "network") {
        super(message);
        this.code = code;
        this.name = "RiparReadError";
    }
}
const b64 = {
    encode: (u) => Buffer.from(u).toString("base64"),
    decode: (s) => new Uint8Array(Buffer.from(s, "base64")),
};
export class RiparRegistry {
    config;
    constructor(input = {}) {
        this.config = resolveConfig(input);
    }
    appId(which) {
        const id = this.config.appIds[which];
        if (!id) {
            throw new RiparReadError(`No ${which} registry app id for network "${this.config.network}". ` +
                `The registries are deployed on TestNet only; pass appIds explicitly for anything else.`, "no_registry");
        }
        return id;
    }
    async json(url) {
        let res;
        try {
            res = await this.config.fetch(url, { headers: { accept: "application/json" } });
        }
        catch (err) {
            throw new RiparReadError(`Could not reach ${url}: ${err.message}`, "network");
        }
        if (res.status === 404) {
            throw new RiparReadError(`Not found: ${url}`, "not_found");
        }
        if (!res.ok) {
            throw new RiparReadError(`${res.status} ${res.statusText} from ${url}`, "bad_response");
        }
        return (await res.json());
    }
    /** One box value, or null when the box does not exist. */
    async readBox(appId, name) {
        const url = `${this.config.algod}/v2/applications/${appId}/box` +
            `?name=${encodeURIComponent(`b64:${b64.encode(name)}`)}`;
        try {
            const body = await this.json(url);
            return b64.decode(body.value);
        }
        catch (err) {
            if (err instanceof RiparReadError && err.code === "not_found")
                return null;
            throw err;
        }
    }
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
    async listBoxNames(appId, 
    /**
     * A text prefix like `ag_`, or raw bytes when the key is not text —
     * `bd_` + itob(job_id) selects one job's bids and those 8 bytes are not
     * UTF-8. Encoding them as text would mangle every byte above 0x7f and the
     * filter would silently match nothing.
     */
    prefix, pageSize = 1000, maxPages = 100) {
        const wanted = typeof prefix === "string" ? new TextEncoder().encode(prefix) : prefix;
        const prefixParam = encodeURIComponent(`b64:${b64.encode(wanted)}`);
        const names = [];
        let next;
        for (let page = 0; page < maxPages; page++) {
            const body = await this.json(`${this.config.algod}/v2/applications/${appId}/boxes` +
                `?limit=${pageSize}&prefix=${prefixParam}` +
                (next ? `&next=${encodeURIComponent(next)}` : ""));
            for (const b of body.boxes ?? []) {
                const name = b64.decode(b.name);
                if (wanted.every((byte, i) => name[i] === byte))
                    names.push(name);
            }
            next = body["next-token"];
            // algod omits next-token on the last page. An empty page with a cursor
            // still set would otherwise spin.
            if (!next || (body.boxes ?? []).length === 0)
                return names;
        }
        throw new RiparReadError(`Box listing for app ${appId} did not finish within ${maxPages} pages of ${pageSize}; ` +
            `refusing to return a partial list that would read as a complete one`, "bad_response");
    }
    /**
     * Several global-state uints from ONE request. Reading them one at a time
     * would fetch the whole application record — approval program included —
     * once per key, and three keys is the normal case for the escrow terms.
     */
    async globalUints(appId, keys) {
        const body = await this.json(`${this.config.algod}/v2/applications/${appId}`);
        const state = body.params?.["global-state"] ?? [];
        const out = {};
        for (const key of keys) {
            const target = Buffer.from(key, "utf8").toString("base64");
            out[key] = Number(state.find((e) => e.key === target)?.value?.uint ?? 0);
        }
        return out;
    }
    async globalUint(appId, key) {
        return (await this.globalUints(appId, [key]))[key];
    }
    // -------------------------------------------------------------- identity
    /** Total registered agents, from the contract's own `agent_count`. */
    async totalAgents() {
        return this.globalUint(this.appId("identity"), "agent_count");
    }
    async getAgent(agentId) {
        if (!Number.isInteger(agentId) || agentId < 1)
            return null;
        const raw = await this.readBox(this.appId("identity"), agentBoxName(agentId));
        return raw ? decodeAgentBox(raw) : null;
    }
    /** 0 means not registered. The contract's own comment insists callers check. */
    async resolveByDomain(domain) {
        const raw = await this.readBox(this.appId("identity"), domainBoxName(domain));
        return raw ? decodeUint64Box(raw) : 0;
    }
    async resolveByAddress(address) {
        const raw = await this.readBox(this.appId("identity"), addressBoxName(address));
        return raw ? decodeUint64Box(raw) : 0;
    }
    /** Every agent record, newest id last. Registries are small; this is one scan. */
    async listAgents(limit = 100) {
        const names = await this.listBoxNames(this.appId("identity"), BOX_PREFIX.agent);
        const values = await Promise.all(names.slice(0, limit).map((n) => this.readBox(this.appId("identity"), n)));
        return values
            .filter((v) => v !== null)
            .map(decodeAgentBox)
            .sort((a, b) => a.agentId - b.agentId);
    }
    /**
     * Substring match over domains, plus exact matches on an id or an address.
     * Deliberately not fuzzy: an agent picked by a near-miss is an agent paid by
     * mistake.
     */
    async searchAgents(query, limit = 25) {
        const all = await this.listAgents(1000);
        if (!query || !query.trim())
            return all.slice(0, limit);
        const q = query.trim().toLowerCase();
        const exact = [];
        if (/^\d+$/.test(q)) {
            const byId = all.find((a) => a.agentId === Number(q));
            if (byId)
                exact.push(byId);
        }
        const byAddress = all.find((a) => a.address.toLowerCase() === q);
        if (byAddress && !exact.includes(byAddress))
            exact.push(byAddress);
        const matches = all.filter((a) => a.domain.toLowerCase().includes(q) && !exact.includes(a));
        return [...exact, ...matches].slice(0, limit);
    }
    // ------------------------------------------------------------ reputation
    /** null when the agent has never been paid — an absent box, not a zero score. */
    async getScore(agentId) {
        const raw = await this.readBox(this.appId("reputation"), scoreBoxName(agentId));
        return raw ? decodeScoreBox(raw) : null;
    }
    /** Which agent a payment was credited to, or 0 if it was never counted. */
    // wasCounted() and countedPaymentIds() are deliberately absent.
    //
    // They read `pd_` boxes listing every payment already folded into a score.
    // The ReputationRegistry no longer writes them: keying a replay ledger on the
    // txid was impossible (the box name depends on the txid, which depends on the
    // group id, which depends on the app call, which must declare the box) and
    // unnecessary (the payment is a transaction in the same group, and consensus
    // rejects a duplicate txid).
    //
    // So "has this transfer been credited?" is not a question the chain can
    // answer, and returning false for everything would have been a lie with the
    // shape of an answer. What IS on chain is the score itself — getScore(id)
    // gives jobs_paid and volume_micro.
    // ------------------------------------------------------------ validation
    async totalJobs() {
        return this.globalUint(this.appId("validation"), "job_count");
    }
    async getJob(jobId) {
        if (!Number.isInteger(jobId) || jobId < 1)
            return null;
        const raw = await this.readBox(this.appId("validation"), jobBoxName(jobId));
        return raw ? decodeJobBox(raw) : null;
    }
    async listJobs(opts = {}) {
        const { status, agentId, limit = 50 } = opts;
        const names = await this.listBoxNames(this.appId("validation"), BOX_PREFIX.job);
        const values = await Promise.all(names.map((n) => this.readBox(this.appId("validation"), n)));
        let jobs = values.filter((v) => v !== null).map(decodeJobBox);
        if (status)
            jobs = jobs.filter((j) => j.status === status);
        if (agentId !== undefined) {
            jobs = jobs.filter((j) => j.serverAgentId === agentId || j.validatorAgentId === agentId);
        }
        return jobs.sort((a, b) => b.jobId - a.jobId).slice(0, limit);
    }
    // ------------------------------------------------------------------ bids
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
    async listBids(jobId, limit = 100) {
        if (!Number.isInteger(jobId) || jobId < 1)
            return [];
        const appId = this.appId("validation");
        const names = await this.listBoxNames(appId, bidPrefixForJob(jobId));
        const values = await Promise.all(names.map((n) => this.readBox(appId, n)));
        const bids = [];
        names.forEach((name, i) => {
            const value = values[i];
            // Withdrawn between the listing and the read. Not a bid any more.
            if (!value)
                return;
            const bid = decodeBidBox(value);
            // The key is authoritative and the value is what the contract wrote; if
            // they disagree the box is not what it claims to be, and quietly
            // preferring one would attribute a price to an agent that never offered
            // it. Refuse the record instead of guessing which half is right.
            const key = bidKeyFromBoxName(name);
            if (key.jobId !== bid.jobId || key.bidderAgentId !== bid.bidderAgentId) {
                throw new RiparReadError(`Bid box ${BOX_PREFIX.bid}(job ${key.jobId}, agent ${key.bidderAgentId}) decodes to job ` +
                    `${bid.jobId} / agent ${bid.bidderAgentId}. The key and the value disagree, so this is ` +
                    `not a record either of them can be trusted for.`, "bad_response");
            }
            bids.push(bid);
        });
        // Cheapest first, ties broken by who bid earliest — the same order a client
        // reading the board would apply, made explicit rather than left to algod's
        // box ordering, which is lexicographic by key and therefore by agent id.
        return bids
            .sort((a, b) => a.priceMicro - b.priceMicro || a.placedAt - b.placedAt)
            .slice(0, limit);
    }
    // ---------------------------------------------------------------- escrow
    /**
     * What is actually held for a job, in base units. 0 when nothing is.
     *
     * This reads the `es_` box rather than calling the contract's own
     * `get_escrow`, and the two cannot disagree — the method is `readonly` and
     * its whole body is that box lookup with the same absent-means-zero rule.
     * Calling it would mean composing an app call with the right box reference
     * and simulating it; the box read is the same fact over a plain GET.
     */
    async getEscrow(jobId) {
        if (!Number.isInteger(jobId) || jobId < 1)
            return 0;
        const raw = await this.readBox(this.appId("validation"), escrowBoxName(jobId));
        return raw ? decodeUint64Box(raw) : 0;
    }
    /**
     * Every funded job, as job id -> base units.
     *
     * One listing rather than a box read per job, and the listing is exhaustive
     * by construction: an `es_` box exists only while money is held, so the boxes
     * that come back ARE the funded set and every job not in this map is
     * unfunded. Jobs are read separately, so a job whose escrow was released
     * between the two calls simply reads 0 — which is what it now is.
     */
    async escrowMap() {
        const appId = this.appId("validation");
        const names = await this.listBoxNames(appId, BOX_PREFIX.escrow);
        const values = await Promise.all(names.map((n) => this.readBox(appId, n)));
        const out = new Map();
        names.forEach((name, i) => {
            const value = values[i];
            // Deleted between the listing and the read: paid out, so not funded.
            if (!value)
                return;
            out.set(idFromBoxName(name, BOX_PREFIX.escrow), decodeUint64Box(value));
        });
        return out;
    }
    /**
     * The escrow terms, read off the ValidationRegistry's global state.
     *
     * Fixed at bootstrap and not per job, so a caller cannot be talked into
     * funding an escrow denominated in something worthless. `appAddress` is where
     * a funding transfer has to go — derived from the app id, so it is not a
     * number anyone can substitute.
     */
    async escrowTerms() {
        const appId = this.appId("validation");
        const state = await this.globalUints(appId, [
            "escrow_asset",
            "dispute_window",
            "identity_app",
            "reputation_app",
        ]);
        return {
            validationApp: appId,
            appAddress: algosdk.getApplicationAddress(appId).toString(),
            // 0 means the registry was never bootstrapped, so nothing can be funded.
            assetId: state.escrow_asset,
            disputeWindowSecs: state.dispute_window,
            identityApp: state.identity_app,
            reputationApp: state.reputation_app,
        };
    }
    /** One job, with what is actually escrowed for it. */
    async getJobWithEscrow(jobId) {
        const job = await this.getJob(jobId);
        if (!job)
            return null;
        return withEscrow(job, await this.getEscrow(jobId));
    }
    /** As listJobs, plus the escrow held for each — one extra listing in total. */
    async listJobsWithEscrow(opts = {}) {
        const [jobs, escrows] = await Promise.all([this.listJobs(opts), this.escrowMap()]);
        return jobs.map((j) => withEscrow(j, escrows.get(j.jobId) ?? 0));
    }
    // ------------------------------------------------------------ settlements
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
    async settlements(opts) {
        const limit = opts.limit ?? 25;
        let address = opts.address;
        let agentId = opts.agentId ?? null;
        if (!address) {
            if (agentId === null) {
                throw new RiparReadError("settlements needs either an address or an agentId", "not_found");
            }
            const agent = await this.getAgent(agentId);
            if (!agent)
                throw new RiparReadError(`No agent ${agentId} in the registry`, "not_found");
            address = agent.address;
        }
        else if (agentId === null) {
            const resolved = await this.resolveByAddress(address);
            agentId = resolved === 0 ? null : resolved;
        }
        const assetId = USDC_ASSET_ID[this.config.network];
        const body = await this.json(`${this.config.indexer}/v2/accounts/${address}/transactions` +
            `?asset-id=${assetId}&tx-type=axfer&limit=${Math.min(limit, 100)}`);
        // The score is the chain's record of credited work, read here rather than
        // derived from the transfers below — no transfer carries a "was this
        // credited" flag, and none can be inferred. The registry used to keep a
        // `pd_` box per counted payment and this method used it to mark each
        // transfer; that ledger is gone, deliberately, so the honest thing is to
        // report the score and not to guess per transfer.
        const score = agentId !== null ? await this.getScore(agentId) : null;
        const transfers = (body.transactions ?? []).map((t) => {
            const xfer = t["asset-transfer-transaction"];
            const direction = xfer?.receiver === address ? "in" : "out";
            const amountMicro = Number(xfer?.amount ?? 0);
            return {
                txId: t.id,
                direction,
                counterparty: direction === "in" ? t.sender : (xfer?.receiver ?? ""),
                amountMicro,
                amountUsdc: microToUsdc(amountMicro),
                round: Number(t["confirmed-round"] ?? 0),
                timestamp: t["round-time"] ? new Date(t["round-time"] * 1000).toISOString() : null,
                note: decodeNote(t.note),
                explorer: explorerTxUrl(this.config, t.id),
            };
        });
        const received = transfers.filter((t) => t.direction === "in");
        const totals = {
            received: received.length,
            sent: transfers.length - received.length,
            receivedUsdc: microToUsdc(received.reduce((s, t) => s + t.amountMicro, 0)),
        };
        return {
            address,
            agentId,
            score,
            asset: { id: assetId, symbol: "USDC", decimals: USDC_DECIMALS },
            transfers,
            totals,
            explorer: explorerAddressUrl(this.config, address),
        };
    }
}
export function withEscrow(job, escrowMicro) {
    return {
        ...job,
        budgetUsdc: microToUsdc(job.budgetMicro),
        escrowMicro,
        escrowUsdc: microToUsdc(escrowMicro),
        funded: escrowMicro > 0,
        fullyFunded: escrowMicro >= job.budgetMicro,
        // Over-funding is possible — fund_job adds to whatever is already held — so
        // this floors at 0 rather than reporting a negative shortfall.
        unfundedMicro: Math.max(job.budgetMicro - escrowMicro, 0),
    };
}
export function microToUsdc(micro) {
    const sign = micro < 0 ? "-" : "";
    const abs = Math.abs(micro);
    const whole = Math.floor(abs / 10 ** USDC_DECIMALS);
    const frac = String(abs % 10 ** USDC_DECIMALS).padStart(USDC_DECIMALS, "0");
    return `${sign}${whole}.${frac}`;
}
function decodeNote(note) {
    if (!note)
        return null;
    try {
        const text = Buffer.from(note, "base64").toString("utf8");
        // Notes are arbitrary bytes; only surface them when they are readable text.
        return /^[\x20-\x7e\s]*$/.test(text) ? text : null;
    }
    catch {
        return null;
    }
}
/* txIdToHex() stood here, converting a printed txid into the hex the `pd_` box
 * names were keyed by. Those boxes are gone and nothing has called it since;
 * left in place it reads as a live index into a ledger that no longer exists.
 * base32TxIdToBytes is still exported from abi.ts for callers decoding a txid
 * for their own reasons. */
