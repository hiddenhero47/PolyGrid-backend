import path from "path";
import mongoose from "mongoose";
import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import { uploadHandler, FILE_VISIBILITY, PRIVATE_DIR } from "../helpers/fileStorage";
import { signFileUrl, verifyFileUrlToken, FILE_URL_MODE, FileUrlMode } from "../helpers/fileSigning";
import { FileGrant } from "../models/fileGrantModel";
import { User, IUser, SYSTEM_ROLE } from "../models/userModel";

const resolveValidUserIds = async (ids: unknown): Promise<mongoose.Types.ObjectId[]> => {
  if (!Array.isArray(ids)) return [];

  const validIds = ids.filter(
    (id): id is string => typeof id === "string" && mongoose.Types.ObjectId.isValid(id),
  );
  if (validIds.length === 0) return [];

  const users = await User.find({ _id: { $in: validIds } }).select("_id");
  return users.map((u) => u._id as mongoose.Types.ObjectId);
};

// @desc    Upload a private file, optionally shared with specific users
// @route   POST /api/files/private
// @access  Private
// Unlike an avatar upload sitting inside a bigger profile-update form, this
// route's entire job IS the file — so, unlike fileStorage.uploadHandler
// itself, it's correct for THIS to fail the whole request when nothing
// valid was uploaded.
export const uploadPrivateFile = asyncHandler(async (req: Request, res: Response) => {
  const uploader = req.user as IUser;

  const { results, errorLogs } = await uploadHandler({
    req,
    visibility: FILE_VISIBILITY.PRIVATE,
    ownerId: uploader.id,
  });

  if (results.length === 0) {
    res.status(400);
    throw new Error(errorLogs[0] || "No valid file provided");
  }

  const saved = results[0];
  const allowedUsers = await resolveValidUserIds(req.body?.allowedUserIds);

  // Only write a DB record when there's an actual grant to persist — an
  // owner-only private file costs zero DB writes and zero DB reads later;
  // ownership lives entirely in the storage path.
  if (allowedUsers.length > 0) {
    await FileGrant.create({ ownerId: uploader._id, fileName: saved.fileName, allowedUsers });
  }

  res.status(201).json({
    fileName: saved.fileName,
    ownerId: uploader.id,
    mime: saved.mime,
    size: saved.size,
    // The uploader is trivially the owner of what they just uploaded, so
    // hand back working links immediately rather than making them ask
    // getPrivateFileLink for a file they only just created.
    requestUrl: signFileUrl({ ownerId: uploader.id, fileName: saved.fileName, mode: FILE_URL_MODE.VIEW }),
    downloadUrl: signFileUrl({
      ownerId: uploader.id,
      fileName: saved.fileName,
      mode: FILE_URL_MODE.DOWNLOAD,
    }),
    errors: errorLogs,
  });
});

// @desc    Check access and mint short-lived view/download links for a
//          private file — the "simple sharing" path (no domain feature of
//          its own). A domain with richer rules (e.g. a future KYC feature
//          checking its own assigned-reviewer logic) mints links directly
//          with signFileUrl() after its own check instead of calling this.
// @route   GET /api/files/private/:ownerId/:fileName/link
// @access  Private — owner/admin cost no extra query (off req.user, same as
//          `protect` already fetched); anyone else costs one FileGrant read.
export const getPrivateFileLink = asyncHandler(async (req: Request, res: Response) => {
  const ownerId = req.params.ownerId as string;
  const fileName = req.params.fileName as string;
  const requester = req.user as IUser;

  if (!mongoose.Types.ObjectId.isValid(ownerId)) {
    res.status(400);
    throw new Error("Invalid owner id");
  }

  const isOwner = requester.id === ownerId;
  const isAdmin =
    requester.systemRole === SYSTEM_ROLE.ADMIN || requester.systemRole === SYSTEM_ROLE.SUPER_ADMIN;

  if (!isOwner && !isAdmin) {
    const granted = await FileGrant.exists({ ownerId, fileName, allowedUsers: requester._id });

    if (!granted) {
      res.status(403);
      throw new Error("You do not have access to this file");
    }
  }

  res.status(200).json({
    requestUrl: signFileUrl({ ownerId, fileName, mode: FILE_URL_MODE.VIEW }),
    downloadUrl: signFileUrl({ ownerId, fileName, mode: FILE_URL_MODE.DOWNLOAD }),
  });
});

// GET /private/view/:ownerId/:fileName and GET /private/download/:ownerId/:fileName
// — no `protect`, no DB read at all: the signed ?token= IS the
// authorization. Whoever minted it (getPrivateFileLink, or a domain
// controller directly) already made the access decision; this route's only
// job is verifying the signature wasn't forged/tampered with/expired/
// reused for a different file or mode, then streaming the bytes.
const streamPrivateFile = (mode: FileUrlMode) =>
  asyncHandler(async (req: Request, res: Response) => {
    const ownerId = req.params.ownerId as string;
    const fileName = req.params.fileName as string;
    const token = req.query.token;

    if (!mongoose.Types.ObjectId.isValid(ownerId)) {
      res.status(400);
      throw new Error("Invalid owner id");
    }

    if (typeof token !== "string") {
      res.status(401);
      throw new Error("Missing link token");
    }

    try {
      verifyFileUrlToken(token, { ownerId, fileName, mode });
    } catch {
      res.status(403);
      throw new Error("Invalid or expired link");
    }

    // Locks every read to this one owner's private folder — res.sendFile's
    // `root` option (via the `send` package, same as express.static) 404s
    // any resolved path that would escape it, including encoded `../`
    // sequences. See docs/file-uploads-plan.md.
    const root = path.join(PRIVATE_DIR, ownerId);

    res.setHeader("Cache-Control", "private, max-age=0, no-store");

    if (mode === FILE_URL_MODE.DOWNLOAD) {
      res.download(fileName, fileName, { root });
    } else {
      res.sendFile(fileName, { root });
    }
  });

export const viewPrivateFile = streamPrivateFile(FILE_URL_MODE.VIEW);
export const downloadPrivateFile = streamPrivateFile(FILE_URL_MODE.DOWNLOAD);
