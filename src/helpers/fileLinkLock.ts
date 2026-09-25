import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // standard for GCM

// Derives a 32-byte AES-256 key from whatever the frontend generated as its
// random lock key (any length/shape of string) — deterministic, so the
// frontend derives the identical key from the exact same value via
// `crypto.subtle.digest("SHA-256", ...)`, with no key ever crossing the
// network. See docs/file-uploads-plan.md for the matching client-side code.
const deriveKey = (lockKey: string): Buffer => crypto.createHash("sha256").update(lockKey).digest();

export interface LockedUrl {
  iv: string; // base64
  // ciphertext with the GCM auth tag appended — the layout Web Crypto's
  // subtle.decrypt(...) expects for AES-GCM, so the frontend can pass this
  // straight through with no reassembly.
  data: string; // base64
}

// Encrypts a real signed URL so only whoever holds `lockKey` can recover
// it. Unlike the token itself (fileSigning.ts), which is never touched by
// this, the *response* handing the URL back becomes useless on its own —
// copying requestUrl/downloadUrl out of a locked response yields ciphertext,
// not a URL, and there's no server-side "resend the key" step needed later:
// the frontend decrypts locally, then uses the recovered URL exactly like
// an ordinary unlocked one.
export const lockUrl = (url: string, lockKey: string): LockedUrl => {
  const key = deriveKey(lockKey);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([cipher.update(url, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString("base64"),
    data: Buffer.concat([ciphertext, authTag]).toString("base64"),
  };
};

// The Node-side mirror of what the frontend does with Web Crypto — exists
// so this codebase's own test suite can prove the round trip actually
// works. Not meant to be called by any real server-side flow: the whole
// point of locking is that only the frontend, which generated `lockKey`
// itself and never sent it anywhere but the mint request, can do this.
export const unlockUrl = (locked: LockedUrl, lockKey: string): string => {
  const key = deriveKey(lockKey);
  const iv = Buffer.from(locked.iv, "base64");
  const combined = Buffer.from(locked.data, "base64");

  const authTag = combined.subarray(combined.length - 16);
  const ciphertext = combined.subarray(0, combined.length - 16);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
};
