import mongoose from "mongoose";
import { PROFILE_MODEL_REGISTRY } from "../constants/profileTypes";
import { Subscription, SUBSCRIPTION_STATUS } from "../models/subscriptionModel";

// Only two call sites ever change User.currentSubscription
// (subscriptionController.grantSubscription and the Stripe webhook's
// subscription-activation branch), and both call this afterward so every
// profile a user owns, across every pillar in PROFILE_MODEL_REGISTRY,
// stays in sync — see consultancyProfileModel.ts for why it's denormalized
// onto each profile in the first place.
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
