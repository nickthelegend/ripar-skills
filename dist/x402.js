/**
 * x402 — asking an endpoint what it costs, and calling it.
 *
 * x402 revives HTTP 402 Payment Required as a real status: an unpaid request
 * gets a 402 whose JSON body lists what the server will accept, and the client
 * retries with an `X-PAYMENT` header carrying a signed transfer. The challenge
 * is the price list, so *quoting* is just making the request and not paying.
 *
 * Which is the whole reason `quote` and `call` are separate tools. This server
 * has no key (see `unsigned.ts`), so it can always quote and can only complete a
 * paid call when the caller hands it a payment header that something else
 * already signed. A tool that quietly paid on a model's say-so would be a tool
 * that spends money without anyone approving the amount.
 */
import { CAIP2, USDC_DECIMALS } from "./config.js";
import { microToUsdc } from "./registry.js";
const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
/**
 * Pull the requirements out of a 402 body.
 *
 * Tolerant on purpose: implementations differ on whether the list is `accepts`,
 * `paymentRequirements`, or a bare array, and a quote that fails because of a
 * key name is a quote that pushes the caller to guess a price instead.
 */
export function parseChallenge(body) {
    if (Array.isArray(body)) {
        const accepts = body.filter(isRecord);
        return accepts.length ? { accepts } : null;
    }
    if (!isRecord(body))
        return null;
    const listCandidate = body.accepts ?? body.paymentRequirements ?? body.requirements;
    if (!Array.isArray(listCandidate))
        return null;
    const accepts = listCandidate.filter(isRecord).map((r) => ({
        scheme: String(r.scheme ?? "exact"),
        network: String(r.network ?? ""),
        maxAmountRequired: String(r.maxAmountRequired ?? r.amount ?? "0"),
        resource: r.resource ? String(r.resource) : undefined,
        description: r.description ? String(r.description) : undefined,
        mimeType: r.mimeType ? String(r.mimeType) : undefined,
        payTo: r.payTo ? String(r.payTo) : undefined,
        maxTimeoutSeconds: r.maxTimeoutSeconds !== undefined ? Number(r.maxTimeoutSeconds) : undefined,
        asset: r.asset !== undefined ? String(r.asset) : undefined,
        extra: isRecord(r.extra) ? r.extra : undefined,
    }));
    if (!accepts.length)
        return null;
    return {
        x402Version: body.x402Version !== undefined ? Number(body.x402Version) : undefined,
        accepts,
        error: body.error ? String(body.error) : undefined,
    };
}
/**
 * Pull a challenge out of a 402 from EITHER place it is allowed to live.
 *
 * x402 v2 carries the requirements in a `payment-required` response header as
 * base64 JSON, and a server that does so may then send an empty body — Ripar's
 * own live agent at api.ripar.io does exactly that, answering
 * `402 payment-required: eyJ4NDAyVmVyc2lvbiI6Mi…` with a body of `{}`.
 *
 * Reading only the body reports those as "402 with no readable accepts list",
 * which is a finding about a completely correct server, and one that would push
 * a caller to guess a price. The header is checked FIRST because when both are
 * present it is the normative copy.
 */
export function challengeFromResponse(res, body) {
    const header = res.headers?.get?.("payment-required");
    if (header) {
        const decoded = decodeMaybeBase64Json(header);
        const parsed = typeof decoded === "string" ? null : parseChallenge(decoded);
        if (parsed)
            return { ...parsed, from: "header" };
    }
    const fromBody = parseChallenge(body);
    return fromBody ? { ...fromBody, from: "body" } : null;
}
/**
 * Format an atomic amount for a human.
 *
 * Only USDC's 6 decimals are assumed, and only when the asset actually looks
 * like USDC — printing "0.05" for a token with 18 decimals would understate the
 * price by twelve orders of magnitude.
 */
function displayAmount(atomic, asset, network) {
    const usdcAsa = network === "testnet" ? "10458941" : "31566704";
    const bare = (asset ?? "").split("/").pop() ?? "";
    if (bare === usdcAsa || bare === `asset:${usdcAsa}`) {
        const n = Number(atomic);
        return Number.isFinite(n) ? `${microToUsdc(n)} USDC` : `${atomic} (USDC base units)`;
    }
    return `${atomic} base units of ${asset ?? "an unnamed asset"}`;
}
/**
 * Make the request without paying and report what came back.
 *
 * A 402 is the interesting answer, but a 200 is a real result too: it means the
 * endpoint is free, and saying so is more useful than reporting an error.
 */
export async function quoteEndpoint(url, opts = {}) {
    const method = (opts.method ?? "GET").toUpperCase();
    const network = opts.network ?? "testnet";
    const doFetch = opts.fetch ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
    const warnings = [];
    try {
        const res = await doFetch(url, {
            method,
            headers: { accept: "application/json", ...(opts.headers ?? {}) },
            ...(opts.body !== undefined && method !== "GET"
                ? { body: JSON.stringify(opts.body), headers: { "content-type": "application/json", accept: "application/json", ...(opts.headers ?? {}) } }
                : {}),
            signal: controller.signal,
        });
        const raw = await readJsonish(res);
        if (res.status !== 402) {
            return {
                url,
                method,
                paymentRequired: false,
                status: res.status,
                price: null,
                accepts: [],
                warnings: res.ok
                    ? ["the endpoint answered without a 402, so it is not charging for this request"]
                    : [`the endpoint returned ${res.status} ${res.statusText}, which is not a payment challenge`],
                raw,
            };
        }
        const challenge = challengeFromResponse(res, raw);
        if (!challenge) {
            return {
                url,
                method,
                paymentRequired: true,
                status: 402,
                price: null,
                accepts: [],
                warnings: [
                    "the endpoint sent a 402 with no readable requirements — nothing in the `payment-required` header and nothing in the body",
                ],
                raw,
            };
        }
        if (challenge.from === "header") {
            warnings.push("the requirements came from the `payment-required` header rather than the body, which is the x402 v2 shape");
        }
        // Cheapest first. Ties keep the server's own ordering, which is its preference.
        const sorted = [...challenge.accepts].sort((a, b) => Number(a.maxAmountRequired) - Number(b.maxAmountRequired));
        const best = sorted[0];
        const wantNetwork = CAIP2[network];
        const onExpectedChain = best.network.startsWith(wantNetwork) || wantNetwork.startsWith(best.network);
        if (!onExpectedChain) {
            warnings.push(`the challenge is for network ${best.network}, not the ${network} id ${wantNetwork} this client is configured for`);
        }
        if (!best.payTo)
            warnings.push("the challenge names no payTo account, so it cannot be paid");
        if (challenge.error)
            warnings.push(`server error field: ${challenge.error}`);
        return {
            url,
            method,
            paymentRequired: true,
            status: 402,
            price: {
                amountAtomic: best.maxAmountRequired,
                amountDisplay: displayAmount(best.maxAmountRequired, best.asset, network),
                asset: best.asset ?? "unknown",
                assetKind: best.asset ? "asa" : "unknown",
                network: best.network,
                payTo: best.payTo ?? "",
                scheme: best.scheme,
            },
            accepts: challenge.accepts,
            warnings,
            raw,
        };
    }
    catch (err) {
        throw new Error(`Could not quote ${url}: ${err.message}`);
    }
    finally {
        clearTimeout(timer);
    }
}
export async function callEndpoint(url, opts = {}) {
    const method = (opts.method ?? "GET").toUpperCase();
    const doFetch = opts.fetch ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
    const headers = { accept: "application/json", ...(opts.headers ?? {}) };
    if (opts.paymentHeader)
        headers["X-PAYMENT"] = opts.paymentHeader;
    if (opts.body !== undefined && method !== "GET")
        headers["content-type"] = "application/json";
    try {
        const res = await doFetch(url, {
            method,
            headers,
            ...(opts.body !== undefined && method !== "GET" ? { body: JSON.stringify(opts.body) } : {}),
            signal: controller.signal,
        });
        const body = await readJsonish(res);
        if (res.status === 402) {
            // Same both-places read as the quote path: a caller that got a 402 with
            // an empty body and a header full of requirements must not be told there
            // is nothing to pay.
            const challenge = challengeFromResponse(res, body);
            const quote = challenge
                ? await Promise.resolve(challengeToQuote(url, method, challenge, opts.network ?? "testnet"))
                : null;
            return {
                url,
                method,
                status: 402,
                ok: false,
                paymentRequired: true,
                quote,
                paymentResponse: null,
                body,
                note: opts.paymentHeader
                    ? "a payment header was sent but the endpoint still asked for payment — it was rejected, expired, or for the wrong amount"
                    : "this endpoint charges. Quote it, have a wallet sign the payment, then call again passing that signed header as paymentHeader. This server holds no key and cannot pay on your behalf.",
            };
        }
        const settled = res.headers.get("x-payment-response");
        return {
            url,
            method,
            status: res.status,
            ok: res.ok,
            paymentRequired: false,
            quote: null,
            paymentResponse: settled ? decodeMaybeBase64Json(settled) : null,
            body,
        };
    }
    catch (err) {
        throw new Error(`Could not call ${url}: ${err.message}`);
    }
    finally {
        clearTimeout(timer);
    }
}
function challengeToQuote(url, method, challenge, network) {
    const sorted = [...challenge.accepts].sort((a, b) => Number(a.maxAmountRequired) - Number(b.maxAmountRequired));
    const best = sorted[0];
    return {
        url,
        method,
        paymentRequired: true,
        status: 402,
        price: {
            amountAtomic: best.maxAmountRequired,
            amountDisplay: displayAmount(best.maxAmountRequired, best.asset, network),
            asset: best.asset ?? "unknown",
            assetKind: best.asset ? "asa" : "unknown",
            network: best.network,
            payTo: best.payTo ?? "",
            scheme: best.scheme,
        },
        accepts: challenge.accepts,
        warnings: [],
    };
}
async function readJsonish(res) {
    const text = await res.text();
    if (!text)
        return null;
    try {
        return JSON.parse(text);
    }
    catch {
        // Truncated: a paid endpoint can return a large document, and the point
        // here is to show what came back, not to relay the payload.
        return text.length > 4000 ? `${text.slice(0, 4000)}… (${text.length} bytes)` : text;
    }
}
function decodeMaybeBase64Json(value) {
    try {
        return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    }
    catch {
        try {
            return JSON.parse(value);
        }
        catch {
            return value;
        }
    }
}
export { USDC_DECIMALS };
