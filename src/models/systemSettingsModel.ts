import mongoose, { Document, Model, Schema, Types } from "mongoose";

// A true singleton — exactly one document ever exists (see
// helpers/systemSettings.ts's getSystemSettings, the only way this is ever
// read or created). Holds the risk-control knobs the user wants to raise
// manually over time as they learn how real money flow behaves, rather
// than hardcoding them as env vars: a global per-transaction ceiling, a
// live cap on how much the system can have outstanding at once (frees up
// as jobs settle — see helpers/paymentGuardrails.ts), and a supported-
// countries allowlist a buyer's own country must be in before they can pay
// at all. Deliberately conservative defaults (see getSystemSettings) so
// nothing is accidentally wide open before an admin has ever configured
// this.
export interface ISystemSettings extends Document {
  maxOutstandingExposure: number;
  maxTransactionAmount: number;
  supportedCountries: string[];
  // Card-fraud mitigation (see docs/payments-plan.md) — a card payment
  // over fraudHoldThresholdAmount still succeeds, but PolyGrid defers
  // crediting escrow/unlocking a download/activating a subscription for
  // fraudHoldHours (helpers/paymentReconciliation.ts), giving a stolen-
  // card chargeback time to arrive before any value is released
  // (helpers/paymentController.ts's stripeWebhook handles
  // charge.dispute.created to actually act on that signal). Above
  // manualReviewThresholdAmount, two extra things kick in: the
  // payment-intent request itself must carry a successful identity
  // step-up (current password, or a 2FA code if enabled — see
  // helpers/paymentGuardrails.ts and middleware/verifyIdentityMiddleware.ts's
  // verifyCurrentPasswordOr2FA), and the fraud-hold release sweep
  // (helpers/paymentHoldRelease.ts) no longer auto-releases it — an admin
  // must explicitly approve it via POST /api/payments/:id/approve-hold.
  // There's no safer alternative payment method wired up for any country
  // yet (confirmed: Stripe has no Nigerian bank-transfer rail usable
  // here), so a human reviewing the biggest transactions stands in for
  // that, rather than refusing them outright. Defaults to 0 for both
  // amounts, same closed-by-default posture as maxTransactionAmount —
  // schema-defaulted (not required), unlike the three fields above, so
  // no existing SystemSettings.create() call site needs updating.
  fraudHoldThresholdAmount: number;
  fraudHoldHours: number;
  manualReviewThresholdAmount: number;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const systemSettingsSchema = new Schema<ISystemSettings>(
  {
    maxOutstandingExposure: { type: Number, required: true, min: 0 },
    maxTransactionAmount: { type: Number, required: true, min: 0 },
    supportedCountries: {
      type: [String],
      default: [],
      set: (codes: string[]) => codes.map((code) => code.toUpperCase().trim()),
    },
    fraudHoldThresholdAmount: { type: Number, default: 0, min: 0 },
    fraudHoldHours: { type: Number, default: 24, min: 0 },
    manualReviewThresholdAmount: { type: Number, default: 0, min: 0 },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

export const SystemSettings: Model<ISystemSettings> = mongoose.model<ISystemSettings>(
  "SystemSettings",
  systemSettingsSchema,
);
