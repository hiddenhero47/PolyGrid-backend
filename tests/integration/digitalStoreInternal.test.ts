// Deliberately does NOT mock providers/digitalStorageProviders — unlike
// every other digital-product test file, this one exercises the real
// internalStorageProvider (the default — DIGITAL_STORAGE_PROVIDER is
// "internal" in .env.test) against actual local disk, including the real
// GET /digital-store/download route. Every other file mocks this layer
// away because it's a third-party-ish boundary once AWS is configured;
// here the "third party" IS our own disk, so there's nothing to fake.
import fs from "fs";
import path from "path";
import request from "supertest";
import createApp from "../../src/app";
import { getDigitalStorageProvider, DIGITAL_STORAGE_PROVIDER } from "../../src/providers/digitalStorageProviders";
import { internalStorageProvider, DIGITAL_STORE_DIR } from "../../src/providers/digitalStorageProviders/internalStorageProvider";
import { TEST_PDF_BUFFER } from "../setup/fixtures";

const app = createApp();

const toMulterFile = (buffer: Buffer, originalname: string): Express.Multer.File =>
  ({ buffer, originalname } as Express.Multer.File);

describe("internalStorageProvider (real local disk, no mocks)", () => {
  it("is the provider getDigitalStorageProvider() resolves to by default", () => {
    delete process.env.DIGITAL_STORAGE_PROVIDER;
    expect(getDigitalStorageProvider()).toBe(internalStorageProvider);
    process.env.DIGITAL_STORAGE_PROVIDER = DIGITAL_STORAGE_PROVIDER.INTERNAL;
  });

  it("uploads a file to real disk under DIGITAL_STORE_DIR", async () => {
    const { results, errorLogs } = await internalStorageProvider.uploadDigitalFiles(
      [toMulterFile(TEST_PDF_BUFFER, "plan.pdf")],
      "digital-products/test-creator",
      ["application/pdf"],
    );

    expect(errorLogs).toHaveLength(0);
    expect(results).toHaveLength(1);
    expect(results[0].key.startsWith("digital-products/test-creator/")).toBe(true);
    expect(fs.existsSync(path.join(DIGITAL_STORE_DIR, results[0].key))).toBe(true);

    await internalStorageProvider.deleteDigitalFile(results[0].key);
  });

  it("rejects a disallowed mime type via the shared validator, same as production", async () => {
    const { results, errorLogs } = await internalStorageProvider.uploadDigitalFiles(
      [toMulterFile(Buffer.from("not a real pdf or image"), "fake.pdf")],
      "digital-products/test-creator",
      ["image/png"],
    );

    expect(results).toHaveLength(0);
    expect(errorLogs).toHaveLength(1);
  });

  it("copies a file to a second key, independent of the original", async () => {
    const { results } = await internalStorageProvider.uploadDigitalFiles(
      [toMulterFile(TEST_PDF_BUFFER, "original.pdf")],
      "digital-products/test-creator",
      ["application/pdf"],
    );
    const sourceKey = results[0].key;
    const destKey = "digital-purchases/test-buyer/test-purchase/copy.pdf";

    await internalStorageProvider.copyDigitalFile(sourceKey, destKey);

    expect(fs.existsSync(path.join(DIGITAL_STORE_DIR, destKey))).toBe(true);
    expect(fs.readFileSync(path.join(DIGITAL_STORE_DIR, destKey))).toEqual(TEST_PDF_BUFFER);

    // The copy is independent — deleting the source leaves the copy intact.
    await internalStorageProvider.deleteDigitalFile(sourceKey);
    expect(fs.existsSync(path.join(DIGITAL_STORE_DIR, destKey))).toBe(true);

    await internalStorageProvider.deleteDigitalFile(destKey);
  });

  it("deleteDigitalFile on an already-missing key is a harmless no-op", async () => {
    await expect(
      internalStorageProvider.deleteDigitalFile("digital-products/does-not/exist.pdf"),
    ).resolves.toBeUndefined();
  });

  it("mints a real download URL that actually serves the file's bytes through the app", async () => {
    const { results } = await internalStorageProvider.uploadDigitalFiles(
      [toMulterFile(TEST_PDF_BUFFER, "download-me.pdf")],
      "digital-products/test-creator",
      ["application/pdf"],
    );
    const file = results[0];

    const url = await internalStorageProvider.getDigitalFileDownloadUrl(file.key, file.fileName, file.mime);
    const token = new URL(url).searchParams.get("token");

    const res = await request(app).get("/digital-store/download").query({ token });

    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body as Buffer, TEST_PDF_BUFFER)).toBe(0);
    expect(res.headers["content-disposition"]).toContain("download-me.pdf");

    await internalStorageProvider.deleteDigitalFile(file.key);
  });

  it("rejects a missing or garbled token", async () => {
    const noToken = await request(app).get("/digital-store/download");
    expect(noToken.status).toBe(401);

    const badToken = await request(app).get("/digital-store/download").query({ token: "not-a-real-token" });
    expect(badToken.status).toBe(403);
  });
});
