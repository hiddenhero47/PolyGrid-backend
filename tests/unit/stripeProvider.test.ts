const mockCreate = jest.fn().mockResolvedValue({ id: "pi_123", client_secret: "secret_123" });

jest.mock("../../src/config/stripe", () => ({
  __esModule: true,
  default: () => ({ paymentIntents: { create: mockCreate } }),
}));

import Stripe from "stripe";
import { stripeProvider } from "../../src/providers/paymentProviders/stripeProvider";

afterEach(() => {
  jest.clearAllMocks();
});

describe("stripeProvider.createIntent", () => {
  it("forces a 3D Secure challenge on every card charge, regardless of target type", async () => {
    await stripeProvider.createIntent({
      amount: 100,
      currency: "USD",
      metadata: { paymentId: "payment_1" },
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_method_options: { card: { request_three_d_secure: "any" } },
      }),
      expect.anything(),
    );
  });

  it("wraps a failed Stripe call as a readable 502, never Stripe's own statusCode", async () => {
    // Stripe's own errors already have a readable .message, but also a
    // .statusCode of their own (400 here) that would otherwise leak
    // straight into errorMiddleware.ts's generic handler — same
    // reasoning as paystackProvider.test.ts's equivalent case.
    mockCreate.mockRejectedValueOnce(
      new Stripe.errors.StripeInvalidRequestError({
        message: "Invalid currency: zzz",
        type: "invalid_request_error",
      } as never),
    );

    await expect(
      stripeProvider.createIntent({ amount: 100, currency: "zzz", metadata: { paymentId: "payment_1" } }),
    ).rejects.toMatchObject({
      statusCode: 502,
      code: "PAYMENT_PROVIDER_ERROR",
      message: expect.stringContaining("Invalid currency: zzz"),
    });
  });
});
