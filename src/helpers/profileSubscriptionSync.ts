import mongoose from "mongoose";
import { PROFILE_MODEL_REGISTRY } from "../constants/profileTypes";

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
