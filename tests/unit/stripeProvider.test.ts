const mockCreate = jest.fn().mockResolvedValue({ id: "pi_123", client_secret: "secret_123" });

jest.mock("../../src/config/stripe", () => ({
  __esModule: true,
  default: () => ({ paymentIntents: { create: mockCreate } }),
}));

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
});
