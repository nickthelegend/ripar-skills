/**
 * The read side: every function here answers a question with bytes that are
 * currently on Algorand TestNet.
 *
 * There is no cache, no seed data and no fallback. If algod is unreachable the
 * call throws — an agent acting on a fabricated reputation score is worse than
 * an agent that knows it could not check.
 */
import { addressBoxName, agentBoxName, base32TxIdToBytes, decodeAgentBox, decodeJobBox, decodeScoreBox, decodeUint64Box, domainBoxName, jobBoxName, paidBoxName, scoreBoxName, } from "./abi.js";
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
    async listBoxNames(appId, prefix, pageSize = 1000, maxPages = 100) {
        const wanted = new TextEncoder().encode(prefix);
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
    async globalUint(appId, key) {
        const body = await this.json(`${this.config.algod}/v2/applications/${appId}`);
        const target = Buffer.from(key, "utf8").toString("base64");
        const entry = (body.params?.["global-state"] ?? []).find((e) => e.key === target);
        return Number(entry?.value?.uint ?? 0);
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
    async wasCounted(txId) {
        const raw = await this.readBox(this.appId("reputation"), paidBoxName(txId));
        return raw ? decodeUint64Box(raw) : 0;
    }
    /** Every payment id the reputation registry has already credited. */
    async countedPaymentIds() {
        const names = await this.listBoxNames(this.appId("reputation"), BOX_PREFIX.paid);
        return names.map((n) => Buffer.from(n.slice(BOX_PREFIX.paid.length)).toString("hex"));
    }
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
        // NOT wrapped in a catch. If the `pd_` listing fails, every transfer would
        // silently come back countedInReputation:false and the audit would report
        // already-credited payments as an uncredited gap — a failed read wearing an
        // empty read's clothes, which is the one thing this module refuses to do.
        let counted;
        try {
            counted = new Set(await this.countedPaymentIds());
        }
        catch (err) {
            throw new RiparReadError(`Could not read the ReputationRegistry's credited payments, so no transfer can be ` +
                `truthfully marked counted or uncounted: ${err.message}`, err instanceof RiparReadError ? err.code : "network");
        }
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
                /** True when this exact transfer has already been folded into a score. */
                countedInReputation: counted.has(txIdToHex(t.id)),
                explorer: explorerTxUrl(this.config, t.id),
            };
        });
        const received = transfers.filter((t) => t.direction === "in");
        const totals = {
            received: received.length,
            sent: transfers.length - received.length,
            receivedUsdc: microToUsdc(received.reduce((s, t) => s + t.amountMicro, 0)),
            countedReceived: received.filter((t) => t.countedInReputation).length,
        };
        return {
            address,
            agentId,
            asset: { id: assetId, symbol: "USDC", decimals: USDC_DECIMALS },
            transfers,
            totals,
            explorer: explorerAddressUrl(this.config, address),
        };
    }
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
/** The printed base32 txid, as the hex the `pd_` box names are keyed by. */
function txIdToHex(txId) {
    try {
        return Buffer.from(base32TxIdToBytes(txId)).toString("hex");
    }
    catch {
        return "";
    }
}
