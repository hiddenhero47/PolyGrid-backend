import fs from "fs";
import path from "path";
import crypto from "crypto";
import axios from "axios";
import { Request } from "express";
import { detectFileSignature } from "./fileSignature";

export const FILE_VISIBILITY = {
  PUBLIC: "public",
  PRIVATE: "private",
} as const;
export type FileVisibility = (typeof FILE_VISIBILITY)[keyof typeof FILE_VISIBILITY];

// Kept outside src/ (and outside dist/) on purpose — this is runtime data,
// not build output, so it shouldn't live inside a directory a rebuild could
// reasonably be expected to touch. Override via STORAGE_ROOT (tests point
// this at a throwaway directory — see tests/setup/env.ts).
const STORAGE_ROOT = process.env.STORAGE_ROOT
  ? path.resolve(process.env.STORAGE_ROOT)
  : path.join(process.cwd(), "storage");

// Served statically (see app.ts) — anything here is reachable by anyone
// with the URL, by design.
export const PUBLIC_DIR = path.join(STORAGE_ROOT, "public");
// Never mounted as static. Laid out as PRIVATE_DIR/<ownerId>/<fileName> so
// it doubles as the `root` option for res.sendFile/res.download in
// fileController.ts's streamPrivateFile — every read is locked to one
// owner's folder, with path-traversal protection from the `send` package
// itself. See docs/file-uploads-plan.md.
export const PRIVATE_DIR = path.join(STORAGE_ROOT, "private");

fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(PRIVATE_DIR, { recursive: true });

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

export const DEFAULT_ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
];

export interface SavedFileInfo {
  fileName: string;
  originalName: string;
  storagePath: string;
  url?: string;
  mime: string;
  size: number;
  visibility: FileVisibility;
}

const isValidFileName = (fileName: string): boolean => {
  const invalid = [".ds_store", "thumbs.db", "desktop.ini"];
  return !invalid.includes(fileName.toLowerCase());
};

const saveBuffer = async (
  buffer: Buffer,
  originalName: string,
  mime: string,
  ext: string,
  visibility: FileVisibility,
  ownerId?: string,
): Promise<SavedFileInfo> => {
  const id = crypto.randomUUID();
  const baseName =
    path.basename(originalName, path.extname(originalName)).replace(/\s+/g, "") ||
    "file";
  const fileName = `${baseName}-${id}.${ext}`;

  if (!isValidFileName(fileName)) {
    throw new Error("Invalid system file blocked");
  }

  let folder = PUBLIC_DIR;
  if (visibility === FILE_VISIBILITY.PRIVATE) {
    if (!ownerId) throw new Error("ownerId is required for a private upload");
    folder = path.join(PRIVATE_DIR, ownerId);
    await fs.promises.mkdir(folder, { recursive: true });
  }

  const storagePath = path.join(folder, fileName);
  await fs.promises.writeFile(storagePath, buffer);

  return {
    fileName,
    originalName,
    storagePath,
    url:
      visibility === FILE_VISIBILITY.PUBLIC
        ? `${process.env.BASE_URL}/public/${fileName}`
        : undefined,
    mime,
    size: buffer.length,
    visibility,
  };
};

const validateAndSave = async (
  buffer: Buffer,
  originalName: string,
  visibility: FileVisibility,
  allowedMimeTypes: string[],
  ownerId?: string,
): Promise<{ saved?: SavedFileInfo; error?: string }> => {
  if (buffer.length > MAX_FILE_SIZE_BYTES) {
    return { error: `${originalName}: file exceeds the ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB limit` };
  }

  const detected = detectFileSignature(buffer);

  if (!detected || !allowedMimeTypes.includes(detected.mime)) {
    return { error: `${originalName}: unsupported or unrecognized file type` };
  }

  const saved = await saveBuffer(
    buffer,
    originalName,
    detected.mime,
    detected.ext,
    visibility,
    ownerId,
  );
  return { saved };
};

export interface UploadOutcome {
  results: SavedFileInfo[];
  errorLogs: string[];
}

// Mirrors house-maduekwe-backend's fileManager.uploadHandler: accepts real
// multipart files (req.files, via multer's memory storage), base64 data
// URIs (req.body.base64), or remote URLs (req.body.url) — any mix of them
// in one request — and saves whichever ones pass validation. Never throws:
// a rejected file is reported in errorLogs, not an exception — see
// docs/file-uploads-plan.md for why that matters (a bad avatar shouldn't
// fail an entire profile-update request).
export const uploadHandler = async ({
  req,
  visibility,
  ownerId,
  allowedMimeTypes = DEFAULT_ALLOWED_MIME_TYPES,
}: {
  req: Request;
  visibility: FileVisibility;
  // Required when visibility is 'private' — determines the per-owner
  // folder a private file is saved under (see PRIVATE_DIR above).
  ownerId?: string;
  allowedMimeTypes?: string[];
}): Promise<UploadOutcome> => {
  const results: SavedFileInfo[] = [];
  const errorLogs: string[] = [];

  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  for (const file of files) {
    try {
      const { saved, error } = await validateAndSave(
        file.buffer,
        file.originalname,
        visibility,
        allowedMimeTypes,
        ownerId,
      );
      if (saved) results.push(saved);
      if (error) errorLogs.push(error);
    } catch (err) {
      errorLogs.push(`Error processing file ${file.originalname}: ${(err as Error).message}`);
    }
  }

  if (req.body?.base64) {
    const base64s: string[] = Array.isArray(req.body.base64)
      ? req.body.base64
      : [req.body.base64];

    for (const base64 of base64s) {
      try {
        const matches = /^data:(.+);base64,(.+)$/.exec(base64);
        if (!matches) throw new Error("Invalid base64 format");

        const buffer = Buffer.from(matches[2], "base64");
        const { saved, error } = await validateAndSave(
          buffer,
          "upload",
          visibility,
          allowedMimeTypes,
          ownerId,
        );
        if (saved) results.push(saved);
        if (error) errorLogs.push(error);
      } catch (err) {
        errorLogs.push(`Error processing base64 file: ${(err as Error).message}`);
      }
    }
  }

  if (req.body?.url) {
    const urls: string[] = Array.isArray(req.body.url) ? req.body.url : [req.body.url];

    for (const url of urls) {
      try {
        const response = await axios.get<ArrayBuffer>(url, {
          responseType: "arraybuffer",
          maxContentLength: MAX_FILE_SIZE_BYTES,
        });
        const buffer = Buffer.from(response.data);
        const { saved, error } = await validateAndSave(
          buffer,
          path.basename(url),
          visibility,
          allowedMimeTypes,
          ownerId,
        );
        if (saved) results.push(saved);
        if (error) errorLogs.push(error);
      } catch (err) {
        errorLogs.push(`Error fetching file from URL ${url}: ${(err as Error).message}`);
      }
    }
  }

  return { results, errorLogs };
};

export const deleteStoredFile = async (storagePath: string): Promise<void> => {
  try {
    await fs.promises.unlink(storagePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
};
