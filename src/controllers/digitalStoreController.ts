import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import { verifyDigitalStoreToken } from "../helpers/digitalFileSigning";
import { DIGITAL_STORE_DIR } from "../providers/digitalStorageProviders/internalStorageProvider";

// GET /digital-store/download — the internal (local-disk) storage
// provider's counterpart to fileController.downloadPrivateFile: no
// `protect`, no DB read — the signed ?token= IS the authorization. Only
// ever reachable when DIGITAL_STORAGE_PROVIDER is `internal` (the
// default — see providers/digitalStorageProviders/index.ts); under `aws`,
// getDigitalFileDownloadUrl returns a presigned S3 URL instead and this
// route is never hit at all.
export const downloadDigitalStoreFile = asyncHandler(async (req: Request, res: Response) => {
  const token = req.query.token;

  if (typeof token !== "string") {
    res.status(401);
    throw new Error("Missing link token");
  }

  let payload;
  try {
    payload = verifyDigitalStoreToken(token);
  } catch {
    res.status(403);
    throw new Error("Invalid or expired link");
  }

  // `send`'s `root` option (same mechanism express.static/res.sendFile use)
  // 404s any resolved path that would escape DIGITAL_STORE_DIR, including
  // encoded `../` sequences — same protection fileController's
  // streamPrivateFile relies on for PRIVATE_DIR.
  res.setHeader("Cache-Control", "private, max-age=0, no-store");
  res.download(payload.key, payload.fileName, { root: DIGITAL_STORE_DIR });
});
