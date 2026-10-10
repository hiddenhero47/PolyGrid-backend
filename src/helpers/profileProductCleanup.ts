import mongoose from "mongoose";
import { StoreProfile } from "../models/storeProfileModel";
import { Product } from "../models/productModel";
import { DigitalCreatorProfile } from "../models/digitalCreatorProfileModel";
import { DigitalProduct, IDigitalProduct } from "../models/digitalProductModel";
import { deleteStoredFile } from "./fileStorage";
import { getDigitalStorageProvider } from "../providers/digitalStorageProviders";

// A seller whose subscription lapsed a month ago isn't coming back to a
// listing nobody's seen in that same month — clears its catalog's storage
// cost. Deliberately never touches the profile itself (StoreProfile/
// DigitalCreatorProfile), only its Products/DigitalProducts: the user
// wants this to be about reclaiming abandoned-listing storage, not a
// second ban mechanism (that's PROFILE_STATUS.BANNED, a separate,
// deliberate admin action — see constants/profileStatus.ts).
const INACTIVITY_LAPSE_MS = 30 * 24 * 60 * 60 * 1000; // 1 month

// Deliberately small and run often (every 2 hours — see
// jobs/tasks/profileProductCleanupTask.ts) rather than one big sweep once
// a month: a handful of deletes/file-removals at a time, spread
// throughout the day, is gentler on the app than a monthly batch job
// tearing through however many sellers lapsed that month all at once.
export const BATCH_SIZE_PER_TYPE = 2;

// Same "lapsed since" semantics as helpers/digitalPurchaseRetention.ts's
// computeLapsedSince — expiresAt when the subscription is still nominally
// ACTIVE but has timed out, updatedAt as the best-effort "since it
// entered this status" signal for CANCELED/PAST_DUE — just expressed as
// an aggregation $cond instead of a per-document JS function, because
// here we need Mongo to do the filtering across however many subscribed
// profiles exist, not loop through a pre-filtered small set. Profiles
// that never subscribed at all (`currentSubscription: null`) are
// deliberately excluded by the `$match` below, not swept — "since their
// last subscription" implies one existed.
const lapsedCandidatesPipeline = (cutoff: Date) => [
  { $match: { currentSubscription: { $ne: null } } },
  {
    $lookup: {
      from: "subscriptions",
      localField: "currentSubscription",
      foreignField: "_id",
      as: "subscription",
    },
  },
  { $unwind: "$subscription" },
  {
    $addFields: {
      lapsedSince: {
        $cond: [{ $eq: ["$subscription.status", "active"] }, "$subscription.expiresAt", "$subscription.updatedAt"],
      },
      isCurrentlyActive: {
        $and: [
          { $eq: ["$subscription.status", "active"] },
          { $gt: ["$subscription.expiresAt", new Date()] },
        ],
      },
    },
  },
  { $match: { isCurrentlyActive: false, lapsedSince: { $lte: cutoff } } },
];

const deleteStoreProductsForProfile = async (storeId: mongoose.Types.ObjectId): Promise<void> => {
  const products = await Product.find({ storeId });
  if (products.length === 0) return;

  await Promise.all(products.flatMap((product) => product.images.map((image) => deleteStoredFile(image.storagePath))));
  await Product.deleteMany({ _id: { $in: products.map((p) => p._id) } });
};

// Unlike the Store side, a DigitalProduct is never hard-deleted (see
// digitalProductModel.ts's own doc comment) — a buyer's download link
// route still looks up the live DigitalProduct before it ever reads
// their own independent purchase.files copy, and purchase history
// displays title/category/previewImages live off it too. So this clears
// every file (deliverable files, preview images, and anything still
// sitting in the bin) and permanently deactivates the listing instead —
// the storage is reclaimed, the record and any history pointing at it
// stay intact.
const deactivateAndClearDigitalProduct = async (product: IDigitalProduct): Promise<void> => {
  const storage = getDigitalStorageProvider();

  await Promise.all(product.previewImages.map((image) => deleteStoredFile(image.storagePath)));

  const keysToDelete = [...product.files.map((f) => f.key), ...product.bin.map((entry) => entry.file.key)];
  for (const key of keysToDelete) {
    try {
      await storage.deleteDigitalFile(key);
    } catch (err) {
      console.error(`deactivateAndClearDigitalProduct: failed to delete ${key} for product ${product.id}`, err);
    }
  }

  product.previewImages = [];
  product.files = [];
  product.bin = [];
  product.isActive = false;
  await product.save();
};

export interface ProfileProductCleanupResult {
  storeProfilesProcessed: number;
  digitalCreatorProfilesProcessed: number;
}

export const sweepInactiveProfileProducts = async (): Promise<ProfileProductCleanupResult> => {
  const cutoff = new Date(Date.now() - INACTIVITY_LAPSE_MS);

  // Only a profile that STILL has something to clear is ever selected —
  // deliberately how this stays idempotent/self-limiting across runs
  // without writing anything onto the profile itself: a store with
  // nothing left under it (or a creator with no still-active listing
  // left) naturally drops out of the next run's candidate pool.
  const eligibleStores = await StoreProfile.aggregate([
    ...lapsedCandidatesPipeline(cutoff),
    { $lookup: { from: "products", localField: "_id", foreignField: "storeId", as: "products" } },
    { $match: { "products.0": { $exists: true } } },
    { $limit: BATCH_SIZE_PER_TYPE },
    { $project: { _id: 1 } },
  ]);

  for (const { _id } of eligibleStores) {
    await deleteStoreProductsForProfile(_id as mongoose.Types.ObjectId);
  }

  const eligibleCreators = await DigitalCreatorProfile.aggregate([
    ...lapsedCandidatesPipeline(cutoff),
    {
      $lookup: {
        from: "digitalproducts",
        let: { creatorId: "$_id" },
        pipeline: [{ $match: { $expr: { $and: [{ $eq: ["$creatorId", "$$creatorId"] }, { $eq: ["$isActive", true] }] } } }],
        as: "activeProducts",
      },
    },
    { $match: { "activeProducts.0": { $exists: true } } },
    { $limit: BATCH_SIZE_PER_TYPE },
    { $project: { _id: 1 } },
  ]);

  for (const { _id } of eligibleCreators) {
    const products = await DigitalProduct.find({ creatorId: _id, isActive: true });
    for (const product of products) {
      await deactivateAndClearDigitalProduct(product);
    }
  }

  return { storeProfilesProcessed: eligibleStores.length, digitalCreatorProfilesProcessed: eligibleCreators.length };
};
