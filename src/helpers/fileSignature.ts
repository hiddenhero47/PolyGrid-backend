export interface DetectedFileType {
  mime: string;
  ext: string;
}

// Minimal magic-byte sniffing for the handful of formats PolyGrid actually
// accepts. Deliberately NOT using the `file-type` npm package: every
// version compatible with CommonJS/Jest (v16 and earlier — v17+ is
// ESM-only) is affected by a known infinite-loop DoS in its ASF parser
// (GHSA-5v7r-6r5c-r473), and that parser runs on every buffer regardless of
// which mime types we actually allow. Trusting a client-declared mimetype
// or file extension alone isn't safe for untrusted uploads, so this checks
// real bytes for just the types we support instead of pulling in a
// general-purpose (and here, vulnerable) parser. Add a case here if a new
// format needs supporting.
export const detectFileSignature = (buffer: Buffer): DetectedFileType | null => {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }

  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { mime: "image/png", ext: "png" };
  }

  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { mime: "image/webp", ext: "webp" };
  }

  if (buffer.length >= 5 && buffer.toString("ascii", 0, 5) === "%PDF-") {
    return { mime: "application/pdf", ext: "pdf" };
  }

  return null;
};
