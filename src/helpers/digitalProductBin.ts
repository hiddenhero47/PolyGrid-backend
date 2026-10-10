import { IDigitalProduct } from "../models/digitalProductModel";
import { getDigitalStorageProvider } from "../providers/digitalStorageProviders";

// How long a removed deliverable file sits in a product's `bin` before
// its underlying storage object is actually deleted — long enough for a
// purchase that started checkout just before the removal to still finish
// copying it via its frozen fileManifest (see
// digitalPurchaseFiles.copyPurchaseFiles and
// docs/digital-storefront-plan.md). In practice that copy happens within
// seconds of a successful payment; a day is a generous, simple buffer,
// not a tuned value.
export const BIN_GRACE_MS = 24 * 60 * 60 * 1000;

// Lazy cleanup, not a cron sweep — called wherever a single product is
// read or written (getDigitalProduct, getDigitalProductDownloadLink,
// updateDigitalProduct, addDigitalProductPreviewImages/Files,
// removeDigitalProductFile). A product nobody's touching has nothing
// time-sensitive riding on its bin being cleared promptly, so there's no
// need for a background job the way DigitalPurchase retention has one.
// Best-effort on the actual delete, same as sweepExpiredPurchaseFiles — a
// bin entry is cleared from the record regardless of whether its storage
// object actually existed/deleted cleanly.
export const clearProductBin = async (product: IDigitalProduct): Promise<void> => {
  const now = Date.now();
  const expired = product.bin.filter((entry) => entry.deleteAt.getTime() <= now);

  if (expired.length === 0) return;

  const storage = getDigitalStorageProvider();

  for (const entry of expired) {
    try {
      await storage.deleteDigitalFile(entry.file.key);
    } catch (err) {
      console.error(`clearProductBin: failed to delete ${entry.file.key} for product ${product.id}`, err);
    }
  }

  product.bin = product.bin.filter((entry) => entry.deleteAt.getTime() > now) as typeof product.bin;
  await product.save();
};
