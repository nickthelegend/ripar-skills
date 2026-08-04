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
import { USDC_DECIMALS, type Network } from "./config.js";
/** One entry from a 402 challenge's `accepts` array (x402 v2 shape). */
export type PaymentRequirement = {
    scheme: string;
    network: string;
    maxAmountRequired: string;
    resource?: string;
    description?: string;
    mimeType?: string;
    payTo?: string;
    maxTimeoutSeconds?: number;
    asset?: string;
    extra?: Record<string, unknown>;
};
export type X402Challenge = {
    x402Version?: number;
    accepts: PaymentRequirement[];
    error?: string;
};
export type Quote = {
    url: string;
    method: string;
    /** false when the endpoint answered without ever asking for payment. */
    paymentRequired: boolean;
    status: number;
    /** Cheapest acceptable option, when the challenge parsed. */
    price: {
        amountAtomic: string;
        amountDisplay: string;
        asset: string;
        assetKind: "asa" | "unknown";
        network: string;
        payTo: string;
        scheme: string;
    } | null;
    accepts: PaymentRequirement[];
    /** Anything worth telling a caller before it decides to pay. */
    warnings: string[];
    raw?: unknown;
};
/**
 * Pull the requirements out of a 402 body.
 *
 * Tolerant on purpose: implementations differ on whether the list is `accepts`,
 * `paymentRequirements`, or a bare array, and a quote that fails because of a
 * key name is a quote that pushes the caller to guess a price instead.
 */
export declare function parseChallenge(body: unknown): X402Challenge | null;
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
export declare function challengeFromResponse(res: Pick<Response, "headers">, body: unknown): (X402Challenge & {
    from: "header" | "body";
}) | null;
export type QuoteOptions = {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    network?: Network;
    fetch?: typeof fetch;
    timeoutMs?: number;
};
/**
 * Make the request without paying and report what came back.
 *
 * A 402 is the interesting answer, but a 200 is a real result too: it means the
 * endpoint is free, and saying so is more useful than reporting an error.
 */
export declare function quoteEndpoint(url: string, opts?: QuoteOptions): Promise<Quote>;
export type CallResult = {
    url: string;
    method: string;
    status: number;
    ok: boolean;
    /** True when a 402 came back and no payment header was supplied. */
    paymentRequired: boolean;
    quote: Quote | null;
    /** Present when the endpoint settled a payment; echoed from `X-PAYMENT-RESPONSE`. */
    paymentResponse: unknown;
    body: unknown;
    note?: string;
};
export type CallOptions = QuoteOptions & {
    /**
     * A pre-signed x402 payment header. This package cannot produce one — it has
     * no key — so it is passed through untouched from whatever signed it.
     */
    paymentHeader?: string;
};
export declare function callEndpoint(url: string, opts?: CallOptions): Promise<CallResult>;
export { USDC_DECIMALS };
