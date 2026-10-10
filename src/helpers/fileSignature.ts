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

  // AVIF is an ISOBMFF/HEIF container — no fixed magic bytes at offset 0
  // the way JPEG/PNG have, just a box structure: a 4-byte size, then an
  // ASCII "ftyp" box type, then a 4-byte brand. "avif" (still image) and
  // "avis" (an image sequence) are AVIF's own major brands; other
  // ISOBMFF formats (HEIC, MP4) use a different brand in that same slot,
  // so checking it is enough to tell AVIF apart without a real ISOBMFF
  // parser.
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 4, 8) === "ftyp" &&
    (buffer.toString("ascii", 8, 12) === "avif" || buffer.toString("ascii", 8, 12) === "avis")
  ) {
    return { mime: "image/avif", ext: "avif" };
  }

  if (buffer.length >= 5 && buffer.toString("ascii", 0, 5) === "%PDF-") {
    return { mime: "application/pdf", ext: "pdf" };
  }

  // .docx (and every other OOXML format — .xlsx, .pptx) is a zip archive,
  // so the first 4 bytes alone only prove "some zip", not "a Word doc". A
  // zip entry's *name* is always stored as cleartext in its local file
  // header and again in the central directory, regardless of whether the
  // entry's own content is compressed — so a plain substring search for
  // the one part-name unique to a Word package ("word/document.xml", vs.
  // "xl/workbook.xml" for Excel or "ppt/presentation.xml" for PowerPoint)
  // tells a .docx apart from any other zip without a real zip parser.
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04 &&
    buffer.toString("latin1").includes("word/document.xml")
  ) {
    return {
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ext: "docx",
    };
  }

  return null;
};
