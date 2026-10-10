import { IDigitalFile } from "../../models/digitalFile";

// A deliberately small interface — exactly the four operations digital
// product/purchase code actually calls. Mirrors paymentProviders/types.ts's
// own reasoning: a second real backend later is a new file implementing
// this same shape, not a rewrite of every caller.
export interface DigitalStorageUploadOutcome {
  results: IDigitalFile[];
  errorLogs: string[];
}

export interface DigitalStorageProviderAdapter {
  // Never throws for a bad individual file — a rejected file is reported
  // in errorLogs, matching uploadHandler's own contract.
  uploadDigitalFiles(
    files: Express.Multer.File[],
    keyPrefix: string,
    allowedMimeTypes: string[],
  ): Promise<DigitalStorageUploadOutcome>;
  // Server-side copy — gives a buyer their own independent object at the
  // moment a purchase succeeds, without bytes passing through our process.
  copyDigitalFile(sourceKey: string, destKey: string): Promise<void>;
  // Only ever called by the retention sweep — creator-side removal
  // deliberately never deletes the underlying object (see
  // digitalProductController.removeDigitalProductFile for why).
  deleteDigitalFile(key: string): Promise<void>;
  // A short-lived download link for one file by its key.
  getDigitalFileDownloadUrl(key: string, fileName: string, mime: string): Promise<string>;
}
