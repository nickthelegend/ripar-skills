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

import { CAIP2, USDC_DECIMALS, type Network } from "./config.js";
import { microToUsdc } from "./registry.js";

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

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Pull the requirements out of a 402 body.
 *
 * Tolerant on purpose: implementations differ on whether the list is `accepts`,
 * `paymentRequirements`, or a bare array, and a quote that fails because of a
 * key name is a quote that pushes the caller to guess a price instead.
 */
export function parseChallenge(body: unknown): X402Challenge | null {
  if (Array.isArray(body)) {
    const accepts = body.filter(isRecord) as unknown as PaymentRequirement[];
    return accepts.length ? { accepts } : null;
  }
  if (!isRecord(body)) return null;

  const listCandidate = body.accepts ?? body.paymentRequirements ?? body.requirements;
  if (!Array.isArray(listCandidate)) return null;

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

  if (!accepts.length) return null;
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
export function challengeFromResponse(
  res: Pick<Response, "headers">,
  body: unknown
): (X402Challenge & { from: "header" | "body" }) | null {
  const header = res.headers?.get?.("payment-required");
  if (header) {
    const decoded = decodeMaybeBase64Json(header);
    const parsed = typeof decoded === "string" ? null : parseChallenge(decoded);
    if (parsed) return { ...parsed, from: "header" };
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
function displayAmount(atomic: string, asset: string | undefined, network: Network): string {
  const usdcAsa = network === "testnet" ? "10458941" : "31566704";
  const bare = (asset ?? "").split("/").pop() ?? "";
  if (bare === usdcAsa || bare === `asset:${usdcAsa}`) {
    const n = Number(atomic);
    return Number.isFinite(n) ? `${microToUsdc(n)} USDC` : `${atomic} (USDC base units)`;
  }
  return `${atomic} base units of ${asset ?? "an unnamed asset"}`;
}

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
export async function quoteEndpoint(url: string, opts: QuoteOptions = {}): Promise<Quote> {
  const method = (opts.method ?? "GET").toUpperCase();
  const network = opts.network ?? "testnet";
  const doFetch = opts.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  const warnings: string[] = [];

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
      warnings.push(
        "the requirements came from the `payment-required` header rather than the body, which is the x402 v2 shape"
      );
    }

    // Cheapest first. Ties keep the server's own ordering, which is its preference.
    const sorted = [...challenge.accepts].sort(
      (a, b) => Number(a.maxAmountRequired) - Number(b.maxAmountRequired)
    );
    const best = sorted[0]!;

    const wantNetwork = CAIP2[network];
    const onExpectedChain =
      best.network.startsWith(wantNetwork) || wantNetwork.startsWith(best.network);
    if (!onExpectedChain) {
      warnings.push(
        `the challenge is for network ${best.network}, not the ${network} id ${wantNetwork} this client is configured for`
      );
    }
    if (!best.payTo) warnings.push("the challenge names no payTo account, so it cannot be paid");
    if (challenge.error) warnings.push(`server error field: ${challenge.error}`);

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
  } catch (err) {
    throw new Error(`Could not quote ${url}: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

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

export async function callEndpoint(url: string, opts: CallOptions = {}): Promise<CallResult> {
  const method = (opts.method ?? "GET").toUpperCase();
  const doFetch = opts.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);

  const headers: Record<string, string> = { accept: "application/json", ...(opts.headers ?? {}) };
  if (opts.paymentHeader) headers["X-PAYMENT"] = opts.paymentHeader;
  if (opts.body !== undefined && method !== "GET") headers["content-type"] = "application/json";

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
  } catch (err) {
    throw new Error(`Could not call ${url}: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

function challengeToQuote(
  url: string,
  method: string,
  challenge: X402Challenge,
  network: Network
): Quote {
  const sorted = [...challenge.accepts].sort(
    (a, b) => Number(a.maxAmountRequired) - Number(b.maxAmountRequired)
  );
  const best = sorted[0]!;
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

async function readJsonish(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Truncated: a paid endpoint can return a large document, and the point
    // here is to show what came back, not to relay the payload.
    return text.length > 4000 ? `${text.slice(0, 4000)}… (${text.length} bytes)` : text;
  }
}

function decodeMaybeBase64Json(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
}

export { USDC_DECIMALS };
