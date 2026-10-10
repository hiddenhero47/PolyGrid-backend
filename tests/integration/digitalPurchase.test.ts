// No real storage call — same "mock the third-party integration entirely"
// boundary tests/README.md documents for helpers/emailSender, applied at
// the provider-dispatch boundary.
jest.mock("../../src/providers/digitalStorageProviders", () => {
  const adapter = { getDigitalFileDownloadUrl: jest.fn(async (key: string) => `https://mock-digital-store.test/${key}`) };
  return { getDigitalStorageProvider: () => adapter };
});

import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import {
  createUser,
  createDigitalCreatorProfile,
  createDigitalProduct,
  createDigitalPurchase,
  generateToken,
  TEST_PNG_BUFFER,
} from "../setup/fixtures";
import { DigitalProduct } from "../../src/models/digitalProductModel";
import { DIGITAL_PURCHASE_STATUS } from "../../src/models/digitalPurchaseModel";

const app = createApp();

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

describe("GET /api/digital-purchases/:id/download", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/api/digital-purchases/507f1f77bcf86cd799439011/download");
    expect(res.status).toBe(401);
  });

  it("404s for an unknown purchase id", async () => {
    const buyer = await createUser();
    const res = await request(app)
      .get("/api/digital-purchases/507f1f77bcf86cd799439011/download")
      .set("Authorization", `Bearer ${generateToken(buyer)}`);
    expect(res.status).toBe(404);
  });

  it("404s for a purchase that belongs to someone else", async () => {
    const profile = await createDigitalCreatorProfile({ user: await createUser() });
    const product = await createDigitalProduct({ creator: profile });
    const buyer = await createUser();
    const purchase = await createDigitalPurchase({
      product,
      buyer,
      creator: profile,
      status: DIGITAL_PURCHASE_STATUS.SUCCESS,
    });

    const stranger = await createUser();
    const res = await request(app)
      .get(`/api/digital-purchases/${purchase.id}/download`)
      .set("Authorization", `Bearer ${generateToken(stranger)}`);

    expect(res.status).toBe(404);
  });

  it("blocks a buyer whose purchase is still pending", async () => {
    const profile = await createDigitalCreatorProfile({ user: await createUser() });
    const product = await createDigitalProduct({ creator: profile });
    const buyer = await createUser();
    const purchase = await createDigitalPurchase({
      product,
      buyer,
      creator: profile,
      status: DIGITAL_PURCHASE_STATUS.PENDING,
    });

    const res = await request(app)
      .get(`/api/digital-purchases/${purchase.id}/download`)
      .set("Authorization", `Bearer ${generateToken(buyer)}`);

    expect(res.status).toBe(403);
  });

  it("lets a successful buyer download their own copy, independent of the live product", async () => {
    const profile = await createDigitalCreatorProfile({ user: await createUser() });
    const product = await createDigitalProduct({ creator: profile });
    const buyer = await createUser();
    const purchase = await createDigitalPurchase({
      product,
      buyer,
      creator: profile,
      status: DIGITAL_PURCHASE_STATUS.SUCCESS,
    });

    const res = await request(app)
      .get(`/api/digital-purchases/${purchase.id}/download`)
      .set("Authorization", `Bearer ${generateToken(buyer)}`);

    expect(res.status).toBe(200);
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0].downloadUrl).toEqual(expect.any(String));
  });

  it("never needs the live product at all — survives it being deactivated, edited, or even hard-deleted", async () => {
    const owner = await createUser();
    const profile = await createDigitalCreatorProfile({ user: owner });
    const product = await createDigitalProduct({ creator: profile });
    const buyer = await createUser();
    const purchase = await createDigitalPurchase({
      product,
      buyer,
      creator: profile,
      status: DIGITAL_PURCHASE_STATUS.SUCCESS,
    });

    const ownerToken = generateToken(owner);
    await request(app)
      .post(`/api/digital-creator-profiles/me/products/${product.id}/files`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .attach("files", TEST_PNG_BUFFER, "replacement.png");
    await request(app)
      .delete(`/api/digital-creator-profiles/me/products/${product.id}/files/${product.files[0].fileName}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    await request(app)
      .patch(`/api/digital-creator-profiles/me/products/${product.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ price: 999, isActive: false });

    // The live product is now gone entirely.
    await DigitalProduct.deleteOne({ _id: product._id });

    const res = await request(app)
      .get(`/api/digital-purchases/${purchase.id}/download`)
      .set("Authorization", `Bearer ${generateToken(buyer)}`);

    expect(res.status).toBe(200);
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0].fileName).toBe(product.files[0].fileName);
  });

  it("returns 410 once retention has wiped a buyer's copy", async () => {
    const profile = await createDigitalCreatorProfile({ user: await createUser() });
    const product = await createDigitalProduct({ creator: profile });
    const buyer = await createUser();
    const purchase = await createDigitalPurchase({
      product,
      buyer,
      creator: profile,
      status: DIGITAL_PURCHASE_STATUS.SUCCESS,
      files: [],
      filesDeletedAt: new Date(),
    });

    const res = await request(app)
      .get(`/api/digital-purchases/${purchase.id}/download`)
      .set("Authorization", `Bearer ${generateToken(buyer)}`);

    expect(res.status).toBe(410);
  });

  it("returns 503 when the purchase succeeded but the copy step hasn't landed yet", async () => {
    const profile = await createDigitalCreatorProfile({ user: await createUser() });
    const product = await createDigitalProduct({ creator: profile });
    const buyer = await createUser();
    const purchase = await createDigitalPurchase({
      product,
      buyer,
      creator: profile,
      status: DIGITAL_PURCHASE_STATUS.SUCCESS,
      files: [],
    });

    const res = await request(app)
      .get(`/api/digital-purchases/${purchase.id}/download`)
      .set("Authorization", `Bearer ${generateToken(buyer)}`);

    expect(res.status).toBe(503);
  });
});
