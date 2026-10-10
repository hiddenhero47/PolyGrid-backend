import jwt from "jsonwebtoken";

// The internal-storage-provider counterpart to fileSigning.ts, keyed by a
// digital-store `key` (which may be several path segments deep —
// digital-products/<creatorId>/<uuid>-name.pdf — unlike the flat
// <ownerId>/<fileName> pair fileSigning.ts signs) rather than an
// ownerId+fileName pair. Same reasoning throughout: app-key-only, no
// session binding, short expiry limits the blast radius of a leaked link.
// Reuses FILE_SIGNING_SECRET — no new secret needed.

const DEFAULT_TTL_SECONDS = 10 * 60; // 10 minutes

interface DigitalStoreTokenPayload {
  key: string;
  fileName: string;
  mime: string;
}

const getSigningSecret = (): string => process.env.FILE_SIGNING_SECRET as string;

export const signDigitalStoreUrl = (
  key: string,
  fileName: string,
  mime: string,
  expiresInSeconds: number = DEFAULT_TTL_SECONDS,
): string => {
  const payload: DigitalStoreTokenPayload = { key, fileName, mime };
  const token = jwt.sign(payload, getSigningSecret(), { expiresIn: expiresInSeconds });

  return `${process.env.BASE_URL}/digital-store/download?token=${encodeURIComponent(token)}`;
};

// Throws on anything wrong — expired or tampered. Unlike
// verifyFileUrlToken, there's no second "expected" value to cross-check
// against: the token IS the request (a plain GET with just ?token=, no
// path segments to mismatch against), so whatever key/fileName/mime it
// carries is simply what gets served.
export const verifyDigitalStoreToken = (token: string): DigitalStoreTokenPayload =>
  jwt.verify(token, getSigningSecret()) as DigitalStoreTokenPayload;
