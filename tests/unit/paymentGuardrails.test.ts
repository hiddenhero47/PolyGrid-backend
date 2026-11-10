import { buildCallbackUrl } from "../../src/helpers/paymentGuardrails";

describe("buildCallbackUrl", () => {
  const ORIGINAL_FRONTEND_URL = process.env.FRONTEND_URL;

  afterEach(() => {
    process.env.FRONTEND_URL = ORIGINAL_FRONTEND_URL;
  });

  it("builds the full URL by appending the path to FRONTEND_URL", () => {
    process.env.FRONTEND_URL = "https://app.polygrid.test";
    expect(buildCallbackUrl("/dashboard/payments/return/job/123")).toBe(
      "https://app.polygrid.test/dashboard/payments/return/job/123",
    );
  });

  it("returns undefined when no path is supplied — never guesses one", () => {
    process.env.FRONTEND_URL = "https://app.polygrid.test";
    expect(buildCallbackUrl(undefined)).toBeUndefined();
  });
});
