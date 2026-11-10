import crypto from "crypto";

const mockPost = jest.fn();
const mockGet = jest.fn();

jest.mock("../../src/config/paystack", () => ({
  __esModule: true,
  default: () => ({ post: mockPost, get: mockGet }),
}));

import { paystackProvider } from "../../src/providers/paymentProviders/paystackProvider";

const ORIGINAL_SECRET = process.env.PAYSTACK_SECRET_KEY;

afterEach(() => {
  jest.clearAllMocks();
  process.env.PAYSTACK_SECRET_KEY = ORIGINAL_SECRET;
});

describe("paystackProvider.createIntent", () => {
  it("initializes a transaction in kobo, with a reference derived from the Payment id", async () => {
    mockPost.mockResolvedValue({
      data: { data: { reference: "polygrid_payment_payment_1", authorization_url: "https://paystack.test/checkout/abc" } },
    });

    const result = await paystackProvider.createIntent({
      amount: 100,
      currency: "ngn",
      metadata: { paymentId: "payment_1" },
      receiptEmail: "buyer@example.com",
    });

    expect(mockPost).toHaveBeenCalledWith(
      "/transaction/initialize",
      expect.objectContaining({
        amount: 10000,
        currency: "NGN",
        email: "buyer@example.com",
        reference: "polygrid_payment_payment_1",
      }),
    );
    expect(result).toEqual({
      providerPaymentId: "polygrid_payment_payment_1",
      clientSecret: "https://paystack.test/checkout/abc",
      chargedAmount: 100,
      chargedCurrency: "NGN",
    });
  });

  it("passes callback_url through when the caller supplies one", async () => {
    mockPost.mockResolvedValue({
      data: { data: { reference: "polygrid_payment_payment_1", authorization_url: "https://paystack.test/checkout/abc" } },
    });

    await paystackProvider.createIntent({
      amount: 100,
      currency: "NGN",
      metadata: { paymentId: "payment_1" },
      receiptEmail: "buyer@example.com",
      callbackUrl: "https://frontend.example.com/payments/return?paymentId=payment_1",
    });

    expect(mockPost).toHaveBeenCalledWith(
      "/transaction/initialize",
      expect.objectContaining({
        callback_url: "https://frontend.example.com/payments/return?paymentId=payment_1",
      }),
    );
  });

  it("omits callback_url entirely when the caller doesn't supply one", async () => {
    mockPost.mockResolvedValue({
      data: { data: { reference: "polygrid_payment_payment_1", authorization_url: "https://paystack.test/checkout/abc" } },
    });

    await paystackProvider.createIntent({
      amount: 100,
      currency: "NGN",
      metadata: { paymentId: "payment_1" },
      receiptEmail: "buyer@example.com",
    });

    const [, body] = mockPost.mock.calls[0];
    expect(body).not.toHaveProperty("callback_url");
  });

  it("converts USD to NGN at send-time when usdToNgnRate is configured", async () => {
    mockPost.mockResolvedValue({
      data: { data: { reference: "polygrid_payment_payment_1", authorization_url: "https://paystack.test/checkout/abc" } },
    });

    const result = await paystackProvider.createIntent({
      amount: 10,
      currency: "USD",
      metadata: { paymentId: "payment_1" },
      receiptEmail: "buyer@example.com",
      usdToNgnRate: 1600,
    });

    expect(mockPost).toHaveBeenCalledWith(
      "/transaction/initialize",
      expect.objectContaining({ amount: 1_600_000, currency: "NGN" }),
    );
    expect(result).toMatchObject({ chargedAmount: 16000, chargedCurrency: "NGN" });
  });

  it("sends USD through unchanged when no usdToNgnRate is configured — still fails at Paystack, as today", async () => {
    mockPost.mockResolvedValue({
      data: { data: { reference: "polygrid_payment_payment_1", authorization_url: "https://paystack.test/checkout/abc" } },
    });

    const result = await paystackProvider.createIntent({
      amount: 10,
      currency: "USD",
      metadata: { paymentId: "payment_1" },
      receiptEmail: "buyer@example.com",
    });

    expect(mockPost).toHaveBeenCalledWith("/transaction/initialize", expect.objectContaining({ currency: "USD" }));
    expect(result).toMatchObject({ chargedAmount: 10, chargedCurrency: "USD" });
  });

  it("never converts a currency that's already non-USD, even with a rate configured", async () => {
    mockPost.mockResolvedValue({
      data: { data: { reference: "polygrid_payment_payment_1", authorization_url: "https://paystack.test/checkout/abc" } },
    });

    const result = await paystackProvider.createIntent({
      amount: 10,
      currency: "NGN",
      metadata: { paymentId: "payment_1" },
      receiptEmail: "buyer@example.com",
      usdToNgnRate: 1600,
    });

    expect(result).toMatchObject({ chargedAmount: 10, chargedCurrency: "NGN" });
  });

  it("refuses to initialize without a receiptEmail — Paystack requires one", async () => {
    await expect(
      paystackProvider.createIntent({ amount: 100, currency: "NGN", metadata: { paymentId: "payment_1" } }),
    ).rejects.toThrow("Paystack requires a receiptEmail");

    expect(mockPost).not.toHaveBeenCalled();
  });

  it("wraps a failed Paystack call as a readable 502, never the raw axios status/message", async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      message: "Request failed with status code 403",
      response: { status: 403, data: { message: "Currency not supported by merchant" } },
    });

    try {
      await paystackProvider.createIntent({
        amount: 100,
        currency: "USD",
        metadata: { paymentId: "payment_1" },
        receiptEmail: "buyer@example.com",
      });
      throw new Error("expected createIntent to reject");
    } catch (err) {
      const error = err as { statusCode?: number; code?: string; message: string };
      expect(error.statusCode).toBe(502);
      expect(error.code).toBe("PAYMENT_PROVIDER_ERROR");
      expect(error.message).toContain("Currency not supported by merchant");
      expect(error.message).not.toContain("403");
    }
  });
});

describe("paystackProvider.retrieveIntent", () => {
  const verifyResponse = (status: string, extra: Record<string, unknown> = {}) => ({
    data: { data: { status, amount: 10000, currency: "ngn", fees: 150, ...extra } },
  });

  it("maps Paystack's 'success' to the shared 'succeeded' literal", async () => {
    mockGet.mockResolvedValue(verifyResponse("success"));

    const result = await paystackProvider.retrieveIntent("polygrid_payment_payment_1");

    expect(mockGet).toHaveBeenCalledWith("/transaction/verify/polygrid_payment_payment_1");
    expect(result.status).toBe("succeeded");
    expect(result.amount).toBe(100);
    expect(result.currency).toBe("NGN");
    expect(result.feeAmount).toBe(1.5);
  });

  it.each(["failed", "abandoned", "reversed"])(
    "maps Paystack's '%s' to the shared 'canceled' literal — a dead transaction, never retried",
    async (status) => {
      mockGet.mockResolvedValue(verifyResponse(status));

      const result = await paystackProvider.retrieveIntent("ref");

      expect(result.status).toBe("canceled");
    },
  );

  it("passes through any other status (still pending) unchanged", async () => {
    mockGet.mockResolvedValue(verifyResponse("ongoing"));

    const result = await paystackProvider.retrieveIntent("ref");

    expect(result.status).toBe("ongoing");
  });

  it("defaults feeAmount to 0 when Paystack reports no fee", async () => {
    mockGet.mockResolvedValue(verifyResponse("success", { fees: null }));

    const result = await paystackProvider.retrieveIntent("ref");

    expect(result.feeAmount).toBe(0);
  });

  // Regression — confirmed live: this Paystack account passes its own
  // fee to the customer, so a 30000 NGN charge actually debited the card
  // 30558.38 NGN (fees 558.38). transaction.amount reports that
  // fee-inclusive total; comparing it against providerChargedAmount (the
  // 30000 we actually requested) left every real, successful payment
  // stuck "pending" forever. requested_amount is the figure that
  // actually matches.
  it("compares against requested_amount, not the fee-inclusive amount, when Paystack passes its fee to the customer", async () => {
    mockGet.mockResolvedValue(
      verifyResponse("success", { amount: 3055838, requested_amount: 3000000, fees: 55838 }),
    );

    const result = await paystackProvider.retrieveIntent("polygrid_payment_real");

    expect(result.amount).toBe(30000);
    expect(result.feeAmount).toBeCloseTo(558.38);
  });

  it("falls back to amount when requested_amount is absent (fees absorbed by the merchant, or an older transaction)", async () => {
    mockGet.mockResolvedValue(verifyResponse("success"));

    const result = await paystackProvider.retrieveIntent("ref");

    expect(result.amount).toBe(100);
  });

  it("wraps a failed verify call as a readable 502 too", async () => {
    mockGet.mockRejectedValue({
      isAxiosError: true,
      message: "Request failed with status code 404",
      response: { status: 404, data: { message: "Transaction reference not found" } },
    });

    await expect(paystackProvider.retrieveIntent("unknown_ref")).rejects.toMatchObject({
      statusCode: 502,
      code: "PAYMENT_PROVIDER_ERROR",
    });
  });
});

describe("paystackProvider.constructWebhookEvent", () => {
  it("verifies a correctly-signed payload and normalizes 'event' to 'type'", () => {
    process.env.PAYSTACK_SECRET_KEY = "sk_test_webhook_secret";
    const rawBody = Buffer.from(JSON.stringify({ event: "charge.success", data: { reference: "ref_1" } }));
    const signature = crypto.createHmac("sha512", "sk_test_webhook_secret").update(rawBody).digest("hex");

    const result = paystackProvider.constructWebhookEvent(rawBody, signature);

    expect(result).toEqual({ type: "charge.success", data: { reference: "ref_1" } });
  });

  it("rejects a payload with the wrong signature", () => {
    process.env.PAYSTACK_SECRET_KEY = "sk_test_webhook_secret";
    const rawBody = Buffer.from(JSON.stringify({ event: "charge.success", data: {} }));

    expect(() => paystackProvider.constructWebhookEvent(rawBody, "not-the-real-signature")).toThrow(
      "Invalid Paystack webhook signature",
    );
  });
});
