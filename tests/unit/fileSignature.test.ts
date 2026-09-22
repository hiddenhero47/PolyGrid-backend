import { detectFileSignature } from "../../src/helpers/fileSignature";
import { TEST_PNG_BUFFER } from "../setup/fixtures";

describe("detectFileSignature", () => {
  it("detects a real PNG by magic bytes", () => {
    expect(detectFileSignature(TEST_PNG_BUFFER)).toEqual({
      mime: "image/png",
      ext: "png",
    });
  });

  it("detects a JPEG by its SOI marker", () => {
    const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(detectFileSignature(buffer)).toEqual({ mime: "image/jpeg", ext: "jpg" });
  });

  it("detects a WEBP by its RIFF/WEBP container", () => {
    const buffer = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from("WEBP", "ascii"),
    ]);
    expect(detectFileSignature(buffer)).toEqual({ mime: "image/webp", ext: "webp" });
  });

  it("detects a PDF by its header", () => {
    const buffer = Buffer.from("%PDF-1.4\n%...", "ascii");
    expect(detectFileSignature(buffer)).toEqual({ mime: "application/pdf", ext: "pdf" });
  });

  it("returns null for plain text / unrecognized content", () => {
    expect(detectFileSignature(Buffer.from("just some text", "utf8"))).toBeNull();
  });

  it("returns null for a mislabeled extension with no matching signature", () => {
    // A .png-named file whose actual bytes are plain text should not be
    // trusted as a PNG — the whole point of checking magic bytes.
    const buffer = Buffer.from("not actually an image", "utf8");
    expect(detectFileSignature(buffer)).toBeNull();
  });

  it("returns null for a truncated/empty buffer", () => {
    expect(detectFileSignature(Buffer.alloc(0))).toBeNull();
  });
});
