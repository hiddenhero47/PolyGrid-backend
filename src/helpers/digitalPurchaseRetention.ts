import { DigitalPurchase, DIGITAL_PURCHASE_STATUS } from "../models/digitalPurchaseModel";
import { IUser, User } from "../models/userModel";
import { Subscription, SUBSCRIPTION_STATUS } from "../models/subscriptionModel";
import { getDigitalStorageProvider } from "../providers/digitalStorageProviders";

// The actual sweep logic — scheduled weekly by
// jobs/tasks/digitalPurchaseRetentionTask.ts (the cron-wrapping layer;
// this file is the pure, directly-testable business logic it calls, same
// split as house-maduekwe-backend's helpers/orderHelper.js +
// jobs/jobListings/orderJobs.js). Enforces a buyer's purchase-time
// snapshot retention: kept indefinitely while their own subscription is
// active, wiped 7 days after it lapses — or 7 days from the purchase
// itself if they were never subscribed at all. See
// docs/digital-storefront-plan.md for why retention is tied to the
// buyer's own subscription and not a gate on purchasing itself.
const RETENTION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

// Everything here is computed live, nothing cached — a buyer who
// re-subscribes before the grace period elapses is simply never flagged
// again on the next run. No lapse timestamp exists on Subscription itself
// (EXPIRED is defined in SUBSCRIPTION_STATUS but never actually assigned
// anywhere in this codebase), so for a non-active subscription this uses
// `expiresAt` when the record is still nominally ACTIVE but has timed
// out, or `updatedAt` as the best-effort "since it entered this status"
// signal for CANCELED/PAST_DUE.
const computeLapsedSince = async (buyer: IUser | null): Promise<Date | null> => {
  if (!buyer?.currentSubscription) return null;

  const subscription = await Subscription.findById(buyer.currentSubscription);
  if (!subscription) return null;
  if (subscription.isActive()) return null;

  return subscription.status === SUBSCRIPTION_STATUS.ACTIVE ? subscription.expiresAt : subscription.updatedAt;
};

export interface RetentionSweepResult {
  checked: number;
  wiped: number;
}

export const sweepExpiredPurchaseFiles = async (): Promise<RetentionSweepResult> => {
  const storage = getDigitalStorageProvider();

  const candidates = await DigitalPurchase.find({
    status: DIGITAL_PURCHASE_STATUS.SUCCESS,
    "files.0": { $exists: true },
  });

  let wiped = 0;

  for (const purchase of candidates) {
    const buyer = await User.findById(purchase.buyer);
    const lapsedSince = buyer?.currentSubscription ? await computeLapsedSince(buyer) : purchase.createdAt;

    if (lapsedSince === null) continue; // currently subscribed — keep indefinitely

    if (Date.now() - lapsedSince.getTime() < RETENTION_GRACE_MS) continue; // still inside the grace window

    for (const file of purchase.files) {
      try {
        await storage.deleteDigitalFile(file.key);
      } catch (err) {
        console.error(`sweepExpiredPurchaseFiles: failed to delete ${file.key} for purchase ${purchase.id}`, err);
      }
    }

    purchase.files = [];
    purchase.filesDeletedAt = new Date();
    await purchase.save();
    wiped++;
  }

  return { checked: candidates.length, wiped };
};
