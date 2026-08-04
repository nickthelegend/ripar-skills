/**
 * x402 challenge parsing and the quote/call split.
 *
 * The one behaviour worth defending hardest: `callEndpoint` must never invent
 * an `X-PAYMENT` header. This package holds no key, so a payment header can
 * only ever come from the caller — and a test that lets one appear by accident
 * would be a test that lets money move without approval.
 */

import { describe, expect, it, vi } from "vitest";

import { callEndpoint, parseChallenge, quoteEndpoint } from "../src/x402.js";

const challengeBody = {
  x402Version: 2,
  accepts: [
    {
      scheme: "exact",
      network: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe",
      maxAmountRequired: "50000",
      resource: "https://paid.example/run",
      description: "One run",
      payTo: "UBB4PNTT7CI3IQS25ZMQR4DGVYYCBORNSBLU4WKUGX4BAZ3KN4O2KATPAU",
      asset: "10458941",
      maxTimeoutSeconds: 60,
    },
  ],
};

const respond = (body: unknown, status = 402, headers: Record<string, string> = {}) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    })) as unknown as typeof fetch;

describe("parseChallenge", () => {
  it("reads the standard `accepts` list", () => {
    const parsed = parseChallenge(challengeBody)!;
    expect(parsed.accepts).toHaveLength(1);
    expect(parsed.accepts[0]!.maxAmountRequired).toBe("50000");
    expect(parsed.x402Version).toBe(2);
  });

  it("also reads the `paymentRequirements` spelling some servers use", () => {
    const parsed = parseChallenge({ paymentRequirements: challengeBody.accepts })!;
    expect(parsed.accepts[0]!.payTo).toBe(challengeBody.accepts[0]!.payTo);
  });

  it("accepts a bare array", () => {
    expect(parseChallenge(challengeBody.accepts)!.accepts).toHaveLength(1);
  });

  it("returns null rather than an empty quote when there is nothing to parse", () => {
    expect(parseChallenge(null)).toBeNull();
    expect(parseChallenge({ error: "payment required" })).toBeNull();
    expect(parseChallenge({ accepts: [] })).toBeNull();
    expect(parseChallenge("payment required")).toBeNull();
  });

  it("defaults a missing scheme to exact rather than dropping the entry", () => {
    const parsed = parseChallenge({ accepts: [{ maxAmountRequired: "1" }] })!;
    expect(parsed.accepts[0]!.scheme).toBe("exact");
  });
});

describe("quoteEndpoint", () => {
  it("turns a 402 into a priced quote", async () => {
    const quote = await quoteEndpoint("https://paid.example/run", {
      fetch: respond(challengeBody),
    });
    expect(quote.paymentRequired).toBe(true);
    expect(quote.price!.amountAtomic).toBe("50000");
    expect(quote.price!.amountDisplay).toBe("0.050000 USDC");
    expect(quote.price!.payTo).toBe(challengeBody.accepts[0]!.payTo);
    expect(quote.warnings).toEqual([]);
  });

  it("picks the cheapest acceptable option", async () => {
    const quote = await quoteEndpoint("https://paid.example/run", {
      fetch: respond({
        accepts: [
          { ...challengeBody.accepts[0], maxAmountRequired: "90000" },
          { ...challengeBody.accepts[0], maxAmountRequired: "20000" },
        ],
      }),
    });
    expect(quote.price!.amountAtomic).toBe("20000");
  });

  it("reports a 200 as free rather than as a failure", async () => {
    const quote = await quoteEndpoint("https://free.example/run", {
      fetch: respond({ ok: true }, 200),
    });
    expect(quote.paymentRequired).toBe(false);
    expect(quote.price).toBeNull();
    expect(quote.warnings.join(" ")).toMatch(/not charging/);
  });

  it("warns when the challenge is for a different chain than the client expects", async () => {
    const quote = await quoteEndpoint("https://paid.example/run", {
      fetch: respond({
        accepts: [{ ...challengeBody.accepts[0], network: "eip155:8453" }],
      }),
      network: "testnet",
    });
    expect(quote.warnings.join(" ")).toMatch(/eip155:8453/);
  });

  it("warns when a challenge quotes a price with nowhere to send it", async () => {
    const quote = await quoteEndpoint("https://paid.example/run", {
      fetch: respond({ accepts: [{ maxAmountRequired: "1", network: "x" }] }),
    });
    expect(quote.warnings.join(" ")).toMatch(/no payTo/);
  });

  it("does not print a USDC amount for an asset it cannot identify", async () => {
    const quote = await quoteEndpoint("https://paid.example/run", {
      fetch: respond({
        accepts: [{ ...challengeBody.accepts[0], asset: "999999999" }],
      }),
    });
    // Assuming 6 decimals for an unknown token would misstate the price.
    expect(quote.price!.amountDisplay).toBe("50000 base units of 999999999");
  });

  it("says so when a 402 arrives with nothing readable in EITHER place", async () => {
    const quote = await quoteEndpoint("https://paid.example/run", {
      fetch: respond({ error: "pay up" }),
    });
    expect(quote.paymentRequired).toBe(true);
    expect(quote.price).toBeNull();
    // The warning has to name both places it looked, or a caller debugging a
    // header-carried challenge will not know the header was checked at all.
    expect(quote.warnings.join(" ")).toMatch(/no readable requirements/);
    expect(quote.warnings.join(" ")).toMatch(/payment-required.*header/);
    expect(quote.warnings.join(" ")).toMatch(/body/);
  });
});

describe("callEndpoint", () => {
  it("never sends an X-PAYMENT header the caller did not supply", async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await callEndpoint("https://free.example/run", { fetch: spy as unknown as typeof fetch });

    const headers = new Headers((spy.mock.calls[0]![1] as RequestInit).headers as HeadersInit);
    expect(headers.get("X-PAYMENT")).toBeNull();
  });

  it("forwards a caller-supplied payment header untouched", async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await callEndpoint("https://paid.example/run", {
      fetch: spy as unknown as typeof fetch,
      paymentHeader: "signed-by-someone-else",
    });
    const headers = new Headers((spy.mock.calls[0]![1] as RequestInit).headers as HeadersInit);
    expect(headers.get("X-PAYMENT")).toBe("signed-by-someone-else");
  });

  it("returns the challenge and explains why it cannot pay", async () => {
    const result = await callEndpoint("https://paid.example/run", {
      fetch: respond(challengeBody),
    });
    expect(result.paymentRequired).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.quote!.price!.amountDisplay).toBe("0.050000 USDC");
    expect(result.note).toMatch(/holds no key and cannot pay/);
  });

  it("distinguishes a rejected payment from an unpaid call", async () => {
    const result = await callEndpoint("https://paid.example/run", {
      fetch: respond(challengeBody),
      paymentHeader: "stale",
    });
    expect(result.note).toMatch(/rejected, expired, or for the wrong amount/);
  });

  it("decodes the settlement receipt from X-PAYMENT-RESPONSE", async () => {
    const receipt = { success: true, txId: "ABC" };
    const result = await callEndpoint("https://paid.example/run", {
      fetch: respond({ answer: 42 }, 200, {
        "x-payment-response": Buffer.from(JSON.stringify(receipt)).toString("base64"),
      }),
      paymentHeader: "signed",
    });
    expect(result.ok).toBe(true);
    expect(result.paymentResponse).toEqual(receipt);
    expect(result.body).toEqual({ answer: 42 });
  });
});
