// No real storage call — same "mock the third-party integration entirely"
// boundary tests/README.md documents for helpers/emailSender, applied at
// the provider-dispatch boundary.
jest.mock("../../src/providers/digitalStorageProviders", () => {
  const adapter = { deleteDigitalFile: jest.fn() };
  return { getDigitalStorageProvider: () => adapter };
});

import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import { createUser, createDigitalCreatorProfile, createDigitalProduct } from "../setup/fixtures";
import { DigitalProduct } from "../../src/models/digitalProductModel";
import { clearProductBin, BIN_GRACE_MS } from "../../src/helpers/digitalProductBin";
import { getDigitalStorageProvider } from "../../src/providers/digitalStorageProviders";

const mockDeleteDigitalFile = getDigitalStorageProvider().deleteDigitalFile as jest.Mock;

beforeAll(async () => {
  await connectTestDB();
});

afterEach(async () => {
  await clearTestDB();
  jest.clearAllMocks();
});

afterAll(async () => {
  await disconnectTestDB();
});

describe("clearProductBin", () => {
  it("deletes an expired bin entry and removes it from the bin", async () => {
    const profile = await createDigitalCreatorProfile({ user: await createUser() });
    const product = await createDigitalProduct({ creator: profile });
    product.bin.push({
      file: { fileName: "old.pdf", key: "digital-products/x/old.pdf", mime: "application/pdf", size: 10 },
      deleteAt: new Date(Date.now() - 1000),
    });
    await product.save();

    await clearProductBin(product);

    expect(mockDeleteDigitalFile).toHaveBeenCalledWith("digital-products/x/old.pdf");
    expect(product.bin).toHaveLength(0);

    const reloaded = await DigitalProduct.findById(product.id);
    expect(reloaded?.bin).toHaveLength(0);
  });

  it("leaves a bin entry alone while it's still inside its grace period", async () => {
    const profile = await createDigitalCreatorProfile({ user: await createUser() });
    const product = await createDigitalProduct({ creator: profile });
    product.bin.push({
      file: { fileName: "recent.pdf", key: "digital-products/x/recent.pdf", mime: "application/pdf", size: 10 },
      deleteAt: new Date(Date.now() + BIN_GRACE_MS),
    });
    await product.save();

    await clearProductBin(product);

    expect(mockDeleteDigitalFile).not.toHaveBeenCalled();
    expect(product.bin).toHaveLength(1);
  });

  it("clears only the expired entries out of a mixed bin", async () => {
    const profile = await createDigitalCreatorProfile({ user: await createUser() });
    const product = await createDigitalProduct({ creator: profile });
    product.bin.push(
      { file: { fileName: "old.pdf", key: "k/old.pdf", mime: "application/pdf", size: 10 }, deleteAt: new Date(Date.now() - 1000) },
      { file: { fileName: "new.pdf", key: "k/new.pdf", mime: "application/pdf", size: 10 }, deleteAt: new Date(Date.now() + BIN_GRACE_MS) },
    );
    await product.save();

    await clearProductBin(product);

    expect(mockDeleteDigitalFile).toHaveBeenCalledTimes(1);
    expect(mockDeleteDigitalFile).toHaveBeenCalledWith("k/old.pdf");
    expect(product.bin).toHaveLength(1);
    expect(product.bin[0].file.key).toBe("k/new.pdf");
  });

  it("still removes an expired entry from the bin even if its storage delete fails", async () => {
    mockDeleteDigitalFile.mockRejectedValueOnce(new Error("transient storage error"));

    const profile = await createDigitalCreatorProfile({ user: await createUser() });
    const product = await createDigitalProduct({ creator: profile });
    product.bin.push({
      file: { fileName: "old.pdf", key: "k/old.pdf", mime: "application/pdf", size: 10 },
      deleteAt: new Date(Date.now() - 1000),
    });
    await product.save();

    await expect(clearProductBin(product)).resolves.toBeUndefined();
    expect(product.bin).toHaveLength(0);
  });

  it("is a no-op (no save, no delete calls) when nothing in the bin has expired", async () => {
    const profile = await createDigitalCreatorProfile({ user: await createUser() });
    const product = await createDigitalProduct({ creator: profile });

    await clearProductBin(product);

    expect(mockDeleteDigitalFile).not.toHaveBeenCalled();
    expect(product.bin).toHaveLength(0);
  });
});
