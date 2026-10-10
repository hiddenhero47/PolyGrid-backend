import { IDigitalFile } from "../models/digitalFile";
import { getDigitalStorageProvider } from "../providers/digitalStorageProviders";

// Shared by digitalProductController (a creator's own live files) and
// digitalPurchaseController (a buyer's own purchased copy) — both mint
// short-lived download links the same way, just against different
// IDigitalFile[] arrays.
export const toDownloadLinks = async (files: IDigitalFile[]) =>
  Promise.all(
    files.map(async (file) => ({
      fileName: file.fileName,
      mime: file.mime,
      size: file.size,
      downloadUrl: await getDigitalStorageProvider().getDigitalFileDownloadUrl(file.key, file.fileName, file.mime),
    })),
  );
