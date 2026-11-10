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

  it("refuses to initialize without a receiptEmail — Paystack requires one", async () => {
    await expect(
      paystackProvider.createIntent({ amount: 100, currency: "NGN", metadata: { paymentId: "payment_1" } }),
    ).rejects.toThrow("Paystack requires a receiptEmail");

    expect(mockPost).not.toHaveBeenCalled();
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
