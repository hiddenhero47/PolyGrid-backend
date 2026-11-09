import { Job } from "../models/jobModel";
import { IUser } from "../models/userModel";
import { Payment, PAYMENT_TARGET_TYPE, PAYMENT_RAIL, PaymentRail, PaymentTargetType } from "../models/paymentModel";
import { PAYMENT_PROVIDER_NAME, PaymentProviderName } from "../models/paymentProviderModel";
import { DigitalPurchase, DIGITAL_PURCHASE_STATUS, DIGITAL_PURCHASE_PAYOUT_STATUS } from "../models/digitalPurchaseModel";
import { SYSTEM_COUNTRY } from "./countryReference";
import { getSystemSettings } from "./systemSettings";
import { AppError } from "../middleware/errorMiddleware";
import { verifyCurrentPasswordOr2FA } from "../middleware/verifyIdentityMiddleware";

const badRequest = (message: string): AppError => {
  const error: AppError = new Error(message);
  error.statusCode = 400;
  return error;
};

// `platform` for a Subscription (100% stays with PolyGrid, no holding
// period); `marketplace` for a Job or DigitalPurchase (a provider/
// creator's cut moves out later via a real Transfer — see
// systemPayoutController.ts).
export const resolveRail = (targetType: PaymentTargetType): PaymentRail =>
  targetType === PAYMENT_TARGET_TYPE.SUBSCRIPTION ? PAYMENT_RAIL.PLATFORM : PAYMENT_RAIL.MARKETPLACE;

// Which gateway actually collects a charge, decided by the buyer's own
// country — Stripe stays the global default (it's the more broadly
// supported one), and SystemSettings.countryProviderOverrides is a sparse
// map of just the countries that deviate (today, only
// `{ NG: "paystack" }`, since Stripe can't pay out to a Nigerian bank
// account at all — see docs/payments-plan.md). Called once per
// intent-creation request, right alongside assertPaymentAllowed, at every
// one of paymentController.ts's handle*PaymentIntent functions.
export const resolveProviderForCountry = async (country: string): Promise<PaymentProviderName> => {
  const settings = await getSystemSettings();
  return settings.countryProviderOverrides[country] ?? PAYMENT_PROVIDER_NAME.STRIPE;
};

// `transactionCountryTo` is SYSTEM_COUNTRY on the platform rail (the money
// stays with PolyGrid), or the provider/creator's own country on the
// marketplace rail — descriptive metadata, not itself a gate (see
// assertPaymentAllowed below, which only ever checks `from`).
export const buildTransactionCountries = (
  rail: PaymentRail,
  buyerCountry?: string,
  counterpartyCountry?: string,
): { transactionCountryFrom?: string; transactionCountryTo?: string } => ({
  transactionCountryFrom: buyerCountry,
  transactionCountryTo: rail === PAYMENT_RAIL.PLATFORM ? SYSTEM_COUNTRY : counterpartyCountry,
});

// Live, not rolling: how much money the system currently has outstanding
// — still sitting in PolyGrid's own Stripe balance, belonging either to
// escrow not yet disbursed or disbursed-but-not-yet-transferred to a
// provider. Per Job this is algebraically
// `refundableAmount(job) + (amountDisbursed - amountPaidOut)`, which
// collapses to the single expression below. Frees up on its own as jobs
// settle (totalRefunded/amountPaidOut grow) — no separate bookkeeping
// needed. Summed across every Job unconditionally: a fully settled job's
// own total naturally evaluates to (near) zero, so there's nothing to
// gain from filtering by status first.
const getJobExposure = async (): Promise<number> => {
  const [result] = await Job.aggregate<{ total: number }>([
    {
      $group: {
        _id: null,
        total: {
          $sum: {
            $subtract: [
              { $subtract: [{ $subtract: ["$amountPaid", "$platformFeeCollected"] }, "$totalRefunded"] },
              "$amountPaidOut",
            ],
          },
        },
      },
    },
  ]);

  return result?.total ?? 0;
};

// Same idea as getJobExposure, for the one other rail that holds money
// before transferring it out: a successful digital purchase's creator
// share sits in PolyGrid's balance from the moment of purchase until a
// payout request actually settles it (see
// digitalCreatorProfileController.ts's requestDigitalCreatorPayout).
// Excludes `paid` purchases only — `requested` still hasn't actually
// settled yet, so it's still real exposure.
const getDigitalPurchaseExposure = async (): Promise<number> => {
  const [result] = await DigitalPurchase.aggregate<{ total: number }>([
    { $match: { status: DIGITAL_PURCHASE_STATUS.SUCCESS, payoutStatus: { $ne: DIGITAL_PURCHASE_PAYOUT_STATUS.PAID } } },
    {
      $group: {
        _id: null,
        total: { $sum: { $multiply: ["$priceSnapshot", { $subtract: [1, { $divide: ["$platformFeePercent", 100] }] }] } },
      },
    },
  ]);

  return result?.total ?? 0;
};

// A payment on fraud-hold (helpers/paymentReconciliation.ts) is real
// money already sitting in PolyGrid's Stripe balance that isn't yet
// reflected in any Job/DigitalPurchase field (crediting escrow/unlocking
// a download is exactly what's deferred while held) — without this, the
// live cap would temporarily under-count precisely the riskiest money in
// the system. No double-counting: a held Job payment hasn't incremented
// amountPaid yet, and a held DigitalPurchase stays PENDING (excluded from
// getDigitalPurchaseExposure's own SUCCESS-only match) until released.
const getHeldPaymentExposure = async (): Promise<number> => {
  const [result] = await Payment.aggregate<{ total: number }>([
    { $match: { isOnHold: true } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);

  return result?.total ?? 0;
};

export const getOutstandingExposure = async (): Promise<number> => {
  const [jobExposure, digitalPurchaseExposure, heldPaymentExposure] = await Promise.all([
    getJobExposure(),
    getDigitalPurchaseExposure(),
    getHeldPaymentExposure(),
  ]);

  return jobExposure + digitalPurchaseExposure + heldPaymentExposure;
};

// The one choke point every payment-intent creation path runs through
// (see paymentController.ts's createPaymentIntent) — buyer's country must
// be set and supported, the amount can't exceed the global per-
// transaction ceiling, and (for anything that holds money rather than
// settling instantly) the live exposure cap can't be exceeded either.
export const assertPaymentAllowed = async (
  buyer: IUser,
  amount: number,
  targetType: PaymentTargetType,
  identityProof: { currentPassword?: string; otpToken?: string } = {},
): Promise<void> => {
  if (!buyer.country) {
    throw badRequest("Set your country before making a payment");
  }

  const settings = await getSystemSettings();

  if (!settings.supportedCountries.includes(buyer.country)) {
    throw badRequest("Payments aren't supported in your country yet");
  }

  if (amount > settings.maxTransactionAmount) {
    throw badRequest("This amount exceeds the maximum allowed per transaction right now");
  }

  // Card fraud mitigation (see docs/payments-plan.md): above this
  // ceiling, the payment still goes through (there's no safer payment
  // method to redirect to for any supported country yet — confirmed
  // Stripe has no usable Nigerian bank-transfer rail), but it needs a
  // fresh proof of identity — a stolen-card fraudster essentially never
  // also has the legitimate buyer's password or 2FA device. The matching
  // other half of this threshold — the fraud-hold release sweep no
  // longer auto-releasing a payment this large — lives in
  // helpers/paymentHoldRelease.ts.
  if (amount > settings.manualReviewThresholdAmount) {
    await verifyCurrentPasswordOr2FA(buyer, identityProof);
  }

  if (targetType === PAYMENT_TARGET_TYPE.SUBSCRIPTION) return;

  const exposure = await getOutstandingExposure();
  if (exposure + amount > settings.maxOutstandingExposure) {
    throw badRequest("The platform has reached its current processing capacity — try again later");
  }
};
