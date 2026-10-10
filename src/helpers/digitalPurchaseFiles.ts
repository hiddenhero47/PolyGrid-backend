import mongoose from "mongoose";
import crypto from "crypto";
import { DigitalPurchase } from "../models/digitalPurchaseModel";
import { IDigitalFile } from "../models/digitalFile";
import { getDigitalStorageProvider } from "../providers/digitalStorageProviders";

// Called by paymentController.stripeWebhook once (and only once — guarded
// by the webhook's own updateOne modifiedCount check) a digital purchase
// flips to SUCCESS. Copies every file in the purchase's frozen
// `fileManifest` (captured at checkout-start, before the creator could
// have changed anything) into a buyer-scoped key, independent of the
// creator's product afterward — on whichever storage provider is
// currently configured (internal disk or S3; see
// providers/digitalStorageProviders). Deliberately a standalone, directly
// unit-testable function — no Stripe/webhook machinery needed to exercise
// it. See docs/digital-storefront-plan.md.
export const copyPurchaseFiles = async (purchaseId: mongoose.Types.ObjectId | string): Promise<void> => {
  const purchase = await DigitalPurchase.findById(purchaseId);
  if (!purchase) return;

  const storage = getDigitalStorageProvider();
  const copied: IDigitalFile[] = [];

  for (const sourceFile of purchase.fileManifest) {
    try {
      const destKey = `digital-purchases/${purchase.buyer}/${purchase.id}/${crypto.randomUUID()}-${sourceFile.fileName}`;
      await storage.copyDigitalFile(sourceFile.key, destKey);
      copied.push({ fileName: sourceFile.fileName, key: destKey, mime: sourceFile.mime, size: sourceFile.size });
    } catch (err) {
      // One file failing to copy (a transient storage error — the source
      // key itself is guaranteed to still exist, since removeDigitalProductFile
      // never deletes it) shouldn't block the rest. Logged for ops to
      // investigate; a buyer hitting this gap sees
      // getDigitalProductDownloadLink's 503 "still being prepared" response
      // until it's resolved.
      console.error(`copyPurchaseFiles: failed to copy ${sourceFile.key} for purchase ${purchase.id}`, err);
    }
  }

  purchase.files = copied;
  await purchase.save();
};
