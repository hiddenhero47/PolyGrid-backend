import mongoose from "mongoose";
import { IPayment, PAYMENT_TARGET_TYPE } from "../models/paymentModel";
import { Job } from "../models/jobModel";
import { Plan } from "../models/planModel";
import { Subscription, ISubscription, SUBSCRIPTION_STATUS } from "../models/subscriptionModel";
import { User } from "../models/userModel";
import { DigitalPurchase, DIGITAL_PURCHASE_STATUS } from "../models/digitalPurchaseModel";
import { syncProfilesSubscription, supersedeActiveSubscriptions, getCarryoverDays, DAY_MS } from "./profileSubscriptionSync";
import { copyPurchaseFiles } from "./digitalPurchaseFiles";

// What actually happens once a charge is allowed to take effect — one
// function per target type, extracted verbatim from what used to be
// inline in paymentReconciliation.ts's reconcilePaymentIntent. Pulled out
// so the fraud-hold release sweep (helpers/paymentHoldRelease.ts) can run
// the exact same completion logic a delayed payment eventually gets, not
// a second copy that could drift from the immediate path.

export const completeJobPayment = async (payment: IPayment): Promise<void> => {
  await Job.updateOne({ _id: payment.targetId }, { $inc: { amountPaid: payment.amount } });
};

export const completeDigitalPurchasePayment = async (payment: IPayment): Promise<void> => {
  // Only the caller that actually performs this PENDING->SUCCESS
  // transition should copy files — running this twice (a redelivered
  // webhook, or a hold released more than once somehow) must stay a
  // pure no-op, otherwise retrying would re-copy (harmless but wasteful)
  // every time.
  const result = await DigitalPurchase.updateOne(
    { _id: payment.targetId, status: DIGITAL_PURCHASE_STATUS.PENDING },
    { status: DIGITAL_PURCHASE_STATUS.SUCCESS },
  );

  if (result.modifiedCount === 1) {
    await copyPurchaseFiles(payment.targetId as mongoose.Types.ObjectId);
  }
};

export const completeSubscriptionPayment = async (payment: IPayment): Promise<ISubscription | undefined> => {
  const subscription = await Subscription.findById(payment.targetId);

  if (subscription && subscription.status === SUBSCRIPTION_STATUS.PENDING) {
    const plan = await Plan.findById(subscription.plan);
    const periodStarted = new Date();
    // Read before supersedeActiveSubscriptions below cancels it.
    const carryoverDays = await getCarryoverDays(subscription.user);

    subscription.status = SUBSCRIPTION_STATUS.ACTIVE;
    subscription.periodStarted = periodStarted;
    subscription.expiresAt = new Date(
      periodStarted.getTime() + ((plan?.duration ?? 30) + carryoverDays) * DAY_MS,
    );
    await subscription.save();

    await User.updateOne({ _id: subscription.user }, { currentSubscription: subscription._id });
    await supersedeActiveSubscriptions(subscription.user, subscription._id as mongoose.Types.ObjectId);
    await syncProfilesSubscription(subscription.user, subscription._id as mongoose.Types.ObjectId);
  }

  return subscription ?? undefined;
};

// The dispatcher — "depending on what it is, call the method for it."
export const completePaymentTarget = async (
  payment: IPayment,
): Promise<{ subscription?: ISubscription }> => {
  if (payment.targetType === PAYMENT_TARGET_TYPE.JOB) {
    await completeJobPayment(payment);
    return {};
  }

  if (payment.targetType === PAYMENT_TARGET_TYPE.DIGITAL_PURCHASE) {
    await completeDigitalPurchasePayment(payment);
    return {};
  }

  const subscription = await completeSubscriptionPayment(payment);
  return { subscription };
};
