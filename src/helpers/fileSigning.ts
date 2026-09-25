import jwt from "jsonwebtoken";

export const FILE_URL_MODE = {
  VIEW: "view",
  DOWNLOAD: "download",
} as const;
export type FileUrlMode = (typeof FILE_URL_MODE)[keyof typeof FILE_URL_MODE];

const DEFAULT_TTL_SECONDS = 10 * 60; // 10 minutes

interface FileUrlTokenPayload {
  ownerId: string;
  fileName: string;
  mode: FileUrlMode;
}

// Deliberately app-key-only, no sessionId in the payload: the access
// decision already happened once, wherever this was minted (a domain
// controller's own check, or getPrivateFileLink's owner/admin/FileGrant
// check) — verifying a signature is meant to be cheap and DB-free, and
// tying it to session state would mean a DB read on every single file
// view, which is exactly the overhead this design exists to avoid. If a
// device is compromised badly enough for a signed link to be stolen, the
// normal login token sitting next to it is already compromised too — a
// short expiry (not session-binding) is what actually limits the damage.
// Separate secret from JWT_SECRET so a leaked one can't forge a login
// session, or vice versa.
const getSigningSecret = (): string => process.env.FILE_SIGNING_SECRET as string;

export const signFileUrl = ({
  ownerId,
  fileName,
  mode,
  expiresInSeconds = DEFAULT_TTL_SECONDS,
}: {
  ownerId: string;
  fileName: string;
  mode: FileUrlMode;
  expiresInSeconds?: number;
}): string => {
  const payload: FileUrlTokenPayload = { ownerId, fileName, mode };
  const token = jwt.sign(payload, getSigningSecret(), { expiresIn: expiresInSeconds });

  return `${process.env.BASE_URL}/private/${mode}/${ownerId}/${fileName}?token=${token}`;
};

// Throws on anything wrong — expired, tampered, or minted for a different
// file/mode than the one being requested (so a "view" link can't be
// replayed against the download route, and a link for file A can't be
// pointed at file B just by editing the URL's path segments). Deliberately
// has no concept of a "lock key" — that's a layer applied to the URL
// *after* this signs it, and undone entirely on the frontend before this
// route is ever called (see fileLinkLock.ts) — this stays exactly what it
// was before that feature existed.
export const verifyFileUrlToken = (
  token: string,
  expected: { ownerId: string; fileName: string; mode: FileUrlMode },
): void => {
  const decoded = jwt.verify(token, getSigningSecret()) as FileUrlTokenPayload;

  if (
    decoded.ownerId !== expected.ownerId ||
    decoded.fileName !== expected.fileName ||
    decoded.mode !== expected.mode
  ) {
    throw new Error("Token does not match the requested file");
  }
};
