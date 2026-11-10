import { createPaymentIntentSchema } from "../../src/validators/payment/paymentValidator";

const BASE_JOB_BODY = { targetType: "Job", targetId: "507f1f77bcf86cd799439011", amount: 100 };

describe("createPaymentIntentSchema — callbackPath", () => {
  it("accepts a relative path starting with '/'", async () => {
    await expect(
      createPaymentIntentSchema.validate({
        ...BASE_JOB_BODY,
        callbackPath: "/dashboard/payments/return/job/123",
      }),
    ).resolves.toMatchObject({ callbackPath: "/dashboard/payments/return/job/123" });
  });

  it("accepts a request with no callbackPath at all", async () => {
    const result = await createPaymentIntentSchema.validate(BASE_JOB_BODY);
    expect(result.callbackPath).toBeUndefined();
  });

  it("rejects a full URL — this must stay a path, never an origin the caller controls", async () => {
    await expect(
      createPaymentIntentSchema.validate({ ...BASE_JOB_BODY, callbackPath: "https://evil.example.com/phish" }),
    ).rejects.toThrow();
  });

  it("rejects a protocol-relative path (//host/...), the classic open-redirect bypass", async () => {
    await expect(
      createPaymentIntentSchema.validate({ ...BASE_JOB_BODY, callbackPath: "//evil.example.com/phish" }),
    ).rejects.toThrow();
  });

  it("rejects a path missing the leading slash", async () => {
    await expect(
      createPaymentIntentSchema.validate({ ...BASE_JOB_BODY, callbackPath: "dashboard/payments/return" }),
    ).rejects.toThrow();
  });
});
