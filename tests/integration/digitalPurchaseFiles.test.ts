// No real storage call — same "mock the third-party integration entirely"
// boundary tests/README.md documents for helpers/emailSender, applied at
// the provider-dispatch boundary.
jest.mock("../../src/providers/digitalStorageProviders", () => {
  const adapter = { copyDigitalFile: jest.fn() };
  return { getDigitalStorageProvider: () => adapter };
});

import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import {
  createUser,
  createDigitalCreatorProfile,
  createDigitalProduct,
  createDigitalPurchase,
} from "../setup/fixtures";
import { DigitalPurchase, DIGITAL_PURCHASE_STATUS } from "../../src/models/digitalPurchaseModel";
import { copyPurchaseFiles } from "../../src/helpers/digitalPurchaseFiles";
import { getDigitalStorageProvider } from "../../src/providers/digitalStorageProviders";

const mockCopyDigitalFile = getDigitalStorageProvider().copyDigitalFile as jest.Mock;

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

describe("copyPurchaseFiles", () => {
  it("copies every manifest entry into the buyer's own key and populates `files`", async () => {
    mockCopyDigitalFile.mockResolvedValue(undefined);

    const creatorUser = await createUser();
    const profile = await createDigitalCreatorProfile({ user: creatorUser });
    const product = await createDigitalProduct({ creator: profile });
    const buyer = await createUser();
    const purchase = await createDigitalPurchase({
      product,
      buyer,
      creator: profile,
      status: DIGITAL_PURCHASE_STATUS.PENDING,
      files: [],
    });

    await copyPurchaseFiles(purchase.id);

    expect(mockCopyDigitalFile).toHaveBeenCalledTimes(1);
    const [sourceKey, destKey] = mockCopyDigitalFile.mock.calls[0];
    expect(sourceKey).toBe(purchase.fileManifest[0].key);
    expect(destKey).toContain(`digital-purchases/${purchase.buyer}/${purchase.id}/`);
    expect(destKey).not.toBe(sourceKey);

    const updated = await DigitalPurchase.findById(purchase.id);
    expect(updated?.files).toHaveLength(1);
    expect(updated?.files[0].fileName).toBe(purchase.fileManifest[0].fileName);
    expect(updated?.files[0].key).toBe(destKey);
  });

  it("copies the rest even if one file's copy fails, without throwing", async () => {
    const creatorUser = await createUser();
    const profile = await createDigitalCreatorProfile({ user: creatorUser });
    const product = await createDigitalProduct({ creator: profile });
    await createDigitalProduct({ creator: profile }); // unrelated — keeps fixture ids distinct
    const buyer = await createUser();

    const purchase = await createDigitalPurchase({
      product,
      buyer,
      creator: profile,
      status: DIGITAL_PURCHASE_STATUS.PENDING,
      files: [],
      fileManifest: [
        { fileName: "a.pdf", key: "digital-products/x/a.pdf", mime: "application/pdf", size: 10 },
        { fileName: "b.pdf", key: "digital-products/x/b.pdf", mime: "application/pdf", size: 20 },
      ],
    });

    mockCopyDigitalFile.mockImplementationOnce(() => Promise.reject(new Error("transient S3 error")));
    mockCopyDigitalFile.mockImplementationOnce(() => Promise.resolve(undefined));

    await expect(copyPurchaseFiles(purchase.id)).resolves.toBeUndefined();

    const updated = await DigitalPurchase.findById(purchase.id);
    expect(updated?.files).toHaveLength(1);
    expect(updated?.files[0].fileName).toBe("b.pdf");
  });

  it("is a no-op for an unknown purchase id", async () => {
    mockCopyDigitalFile.mockResolvedValue(undefined);
    await expect(copyPurchaseFiles("507f1f77bcf86cd799439011")).resolves.toBeUndefined();
    expect(mockCopyDigitalFile).not.toHaveBeenCalled();
  });
});
