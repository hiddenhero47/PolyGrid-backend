import { AppError } from "../../middleware/errorMiddleware";

// A failed gateway call (Stripe/Paystack SDK/HTTP error) must never reach
// the client as-is: axios sets `.status`/`.code` straight off the failed
// HTTP response (e.g. a 403 from Paystack rejecting an unsupported
// currency), and errorMiddleware.ts's generic handler reads `err.status`
// first — so an unwrapped provider error surfaces as OUR api returning
// that same misleading status (a 403 that has nothing to do with the
// caller's own permissions), with axios's own generic message
// ("Request failed with status code 403") instead of the gateway's real
// reason. Always 502 (this server is fine; the upstream gateway call
// failed) with a stable code and the gateway's own human-readable detail.
export const providerCallFailed = (providerLabel: string, detail: string): AppError => {
  const error: AppError = new Error(`${providerLabel} couldn't complete this request: ${detail}`);
  error.statusCode = 502;
  error.code = "PAYMENT_PROVIDER_ERROR";
  return error;
};
