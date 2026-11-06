import { SystemSettings, ISystemSettings } from "../models/systemSettingsModel";

// Conservative on purpose — before an admin has ever touched
// PATCH /api/system-settings, nothing should be able to move real money:
// no country is supported, and both caps are 0. Raised deliberately by an
// admin as confidence in the system grows (see the user's own "slowly
// scale" framing in docs/payments-plan.md).
const DEFAULTS = {
  maxOutstandingExposure: 0,
  maxTransactionAmount: 0,
  supportedCountries: [] as string[],
  fraudHoldThresholdAmount: 0,
  fraudHoldHours: 24,
  manualReviewThresholdAmount: 0,
};

// The one singleton — created on first read if it doesn't exist yet,
// mirroring deploymentSetup.ts's idempotent "ensure X exists" pattern.
// Never caches: this is read on the hot path of every payment-intent
// creation (see paymentGuardrails.ts), and an admin's PATCH should take
// effect on the very next request, not after a restart.
export const getSystemSettings = async (): Promise<ISystemSettings> => {
  const existing = await SystemSettings.findOne();
  if (existing) return existing;

  return SystemSettings.create(DEFAULTS);
};
