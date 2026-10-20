import mongoose from "mongoose";
import { PROFILE_MODEL_REGISTRY } from "../constants/profileTypes";
import { Subscription, SUBSCRIPTION_STATUS } from "../models/subscriptionModel";

export const DAY_MS = 24 * 60 * 60 * 1000;

// Three call sites ever change User.currentSubscription
// (subscriptionController.grantSubscription, the Stripe webhook's
// subscription-activation branch, and paymentController's free-plan direct
// activation), and all three call this afterward so every profile a user
// owns, across every pillar in PROFILE_MODEL_REGISTRY, stays in sync — see
// consultancyProfileModel.ts for why it's denormalized onto each profile in
// the first place.
export const syncProfilesSubscription = async (
  userId: mongoose.Types.ObjectId | string,
  subscriptionId: mongoose.Types.ObjectId | string,
): Promise<void> => {
  await Promise.all(
    Object.values(PROFILE_MODEL_REGISTRY).map((Model) =>
      Model.updateMany({ userId }, { currentSubscription: subscriptionId }),
    ),
  );
};

// Same two call sites as syncProfilesSubscription above. Granting (or a
// webhook activating) a new subscription moves User.currentSubscription
// forward, but without this, any OTHER subscription this user already had
// in 'active' status — most commonly one they haven't let expire yet,
// renewing/upgrading early — just sits there, still counted as active by
// anything that queries status:'active' directly (Subscription.isActive(),
// statsController.getPlatformOverview's activeSubscriptions count).
// 'canceled', never a deletion — full history stays intact, same as
// everywhere else in this app that "removes" something it needs an audit
// trail for.
export const supersedeActiveSubscriptions = async (
  userId: mongoose.Types.ObjectId | string,
  keepSubscriptionId: mongoose.Types.ObjectId | string,
): Promise<void> => {
  await Subscription.updateMany(
    { user: userId, status: SUBSCRIPTION_STATUS.ACTIVE, _id: { $ne: keepSubscriptionId } },
    { status: SUBSCRIPTION_STATUS.CANCELED },
  );
};

// Called at all three activation sites above, before supersedeActiveSubscriptions
// — once a subscription is superseded its own remaining time is irrelevant, so this
// has to read it first. Whole days only (Math.floor, never rounds up) — the
// simplest version that's actually fair: you never lose time you paid for by
// switching plans, but you also never gain a free day from rounding a few
// leftover hours up.
//
// Deliberately 1-for-1, not value-adjusted — every plan currently grants the
// same privileges regardless of price, so a day of Plan A is worth exactly a
// day of Plan B today. Once plans actually differ in what they unlock, the
// fairer version is proportional: convert the remaining days into their
// *value* at the old plan's daily rate, then convert that value into days at
// the new plan's daily rate (e.g. 1 day left on a $100/week plan moving to a
// $50/week plan is worth 2 days there, not 1) — with a minimum-1-day floor on
// any multi-day subscription so the conversion never rounds a real remaining
// balance down to nothing. That floor deliberately does NOT apply to
// single-day subscriptions — a 1-day plan has no "remaining fraction" to
// protect; flooring a near-zero remainder up to a full day there would just
// be a free day on every switch, repeatable indefinitely.
export const getCarryoverDays = async (userId: mongoose.Types.ObjectId | string): Promise<number> => {
  const current = await Subscription.findOne({
    user: userId,
    status: SUBSCRIPTION_STATUS.ACTIVE,
    expiresAt: { $gt: new Date() },
  });

  if (!current) return 0;

  return Math.max(0, Math.floor((current.expiresAt.getTime() - Date.now()) / DAY_MS));
};
