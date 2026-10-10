// No real storage call in tests — same "mock the third-party integration
// entirely" boundary tests/README.md documents for helpers/emailSender,
// applied one layer up at the provider-dispatch boundary (whichever
// provider DIGITAL_STORAGE_PROVIDER would resolve to in production never
// matters here). uploadDigitalFiles reuses the real (unmocked) validation
// logic so a bad-mime-type attachment still behaves like it would in
// production; only the actual write is faked.
jest.mock("../../src/providers/digitalStorageProviders", () => {
  const crypto = require("crypto");
  const { detectAndValidateFile } = jest.requireActual("../../src/helpers/fileStorage");

  const adapter = {
    uploadDigitalFiles: jest.fn(
      async (files: Express.Multer.File[], keyPrefix: string, allowedMimeTypes: string[]) => {
        const results: { fileName: string; key: string; mime: string; size: number }[] = [];
        const errorLogs: string[] = [];

        for (const file of files) {
          const detected = detectAndValidateFile(file.buffer, file.originalname, allowedMimeTypes);
          if (!detected.ok) {
            errorLogs.push(detected.error);
            continue;
          }
          results.push({
            fileName: file.originalname,
            key: `${keyPrefix}/${crypto.randomUUID()}-${file.originalname}`,
            mime: detected.mime,
            size: file.buffer.length,
          });
        }

        return { results, errorLogs };
      },
    ),
    copyDigitalFile: jest.fn().mockResolvedValue(undefined),
    deleteDigitalFile: jest.fn().mockResolvedValue(undefined),
    getDigitalFileDownloadUrl: jest.fn(async (key: string) => `https://mock-digital-store.test/${key}`),
  };

  return { getDigitalStorageProvider: () => adapter };
});

import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import {
  createUser,
  createAdmin,
  createCustomerCare,
  createUserWithActiveSubscription,
  createDigitalCreatorProfile,
  createDigitalProduct,
  createDigitalPurchase,
  generateToken,
  TEST_PNG_BUFFER,
} from "../setup/fixtures";
import { DigitalProduct, DIGITAL_PRODUCT_CATEGORY, MAX_PREVIEW_IMAGES } from "../../src/models/digitalProductModel";
import { DIGITAL_PURCHASE_STATUS } from "../../src/models/digitalPurchaseModel";
import { Subscription } from "../../src/models/subscriptionModel";
import { getDigitalStorageProvider } from "../../src/providers/digitalStorageProviders";

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

describe("POST /api/digital-creator-profiles/me/products", () => {
  it("requires authentication", async () => {
    const res = await request(app).post("/api/digital-creator-profiles/me/products").send({});
    expect(res.status).toBe(401);
  });

  it("rejects an invalid category", async () => {
    const user = await createUser();
    await createDigitalCreatorProfile({ user });

    const res = await request(app)
      .post("/api/digital-creator-profiles/me/products")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .field("data", JSON.stringify({ category: "not-a-real-one", title: "Plan", price: 20 }))
      .attach("files", TEST_PNG_BUFFER, "plan.png");

    expect(res.status).toBe(400);
  });

  it("rejects creating a product with no deliverable file", async () => {
    const user = await createUser();
    await createDigitalCreatorProfile({ user });

    const res = await request(app)
      .post("/api/digital-creator-profiles/me/products")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .field(
        "data",
        JSON.stringify({ category: DIGITAL_PRODUCT_CATEGORY.FLOOR_PLAN, title: "Plan", price: 20 }),
      );

    expect(res.status).toBe(400);
  });

  it("creates a product with previewImages (public) and files (private) distinguished by field name", async () => {
    const user = await createUser();
    await createDigitalCreatorProfile({ user });

    const res = await request(app)
      .post("/api/digital-creator-profiles/me/products")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .field(
        "data",
        JSON.stringify({
          category: DIGITAL_PRODUCT_CATEGORY.FLOOR_PLAN,
          title: "3-Bedroom Bungalow Plan",
          price: 25,
        }),
      )
      .attach("previewImages", TEST_PNG_BUFFER, "preview.png")
      .attach("files", TEST_PNG_BUFFER, "deliverable.png");

    expect(res.status).toBe(201);
    expect(res.body.title).toBe("3-Bedroom Bungalow Plan");
    expect(res.body.previewImages).toHaveLength(1);
    // The private deliverable is never present in the public payload.
    expect(res.body.files).toBeUndefined();
  });

  it("rejects attaching more than MAX_PREVIEW_IMAGES preview images", async () => {
    const user = await createUser();
    await createDigitalCreatorProfile({ user });

    let req = request(app)
      .post("/api/digital-creator-profiles/me/products")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .field(
        "data",
        JSON.stringify({ category: DIGITAL_PRODUCT_CATEGORY.FLOOR_PLAN, title: "Plan", price: 20 }),
      )
      .attach("files", TEST_PNG_BUFFER, "deliverable.png");
    for (let i = 0; i < MAX_PREVIEW_IMAGES + 1; i++) {
      req = req.attach("previewImages", TEST_PNG_BUFFER, `preview${i}.png`);
    }

    const res = await req;
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/digital-creator-profiles/me/products/:id", () => {
  it("blocks updating a product that belongs to someone else's profile", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const ownerProfile = await createDigitalCreatorProfile({ user: owner });
    await createDigitalCreatorProfile({ user: stranger });
    const product = await createDigitalProduct({ creator: ownerProfile });

    const res = await request(app)
      .patch(`/api/digital-creator-profiles/me/products/${product.id}`)
      .set("Authorization", `Bearer ${generateToken(stranger)}`)
      .send({ title: "Hijacked" });

    expect(res.status).toBe(404);
  });

  it("toggles isActive without any hard delete endpoint existing", async () => {
    const user = await createUser();
    const profile = await createDigitalCreatorProfile({ user });
    const product = await createDigitalProduct({ creator: profile });

    const res = await request(app)
      .patch(`/api/digital-creator-profiles/me/products/${product.id}`)
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({ isActive: false });

    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
  });
});

describe("preview-images sub-resource", () => {
  it("adds and removes a single preview image without touching deliverables", async () => {
    const user = await createUser();
    const profile = await createDigitalCreatorProfile({ user });
    const product = await createDigitalProduct({ creator: profile });
    const token = generateToken(user);

    const added = await request(app)
      .post(`/api/digital-creator-profiles/me/products/${product.id}/preview-images`)
      .set("Authorization", `Bearer ${token}`)
      .attach("previewImages", TEST_PNG_BUFFER, "extra.png");
    expect(added.status).toBe(201);
    expect(added.body.previewImages).toHaveLength(1);

    const fileName = added.body.previewImages[0].fileName;
    const removed = await request(app)
      .delete(`/api/digital-creator-profiles/me/products/${product.id}/preview-images/${fileName}`)
      .set("Authorization", `Bearer ${token}`);

    expect(removed.status).toBe(200);
    expect(removed.body.previewImages).toHaveLength(0);
  });
});

describe("files sub-resource — add/remove", () => {
  it("adds more deliverable files", async () => {
    const user = await createUser();
    const profile = await createDigitalCreatorProfile({ user });
    const product = await createDigitalProduct({ creator: profile });
    const token = generateToken(user);

    const res = await request(app)
      .post(`/api/digital-creator-profiles/me/products/${product.id}/files`)
      .set("Authorization", `Bearer ${token}`)
      .attach("files", TEST_PNG_BUFFER, "revision2.png");

    expect(res.status).toBe(201);
    // files is never in the public payload, but the count should have grown
    // to 2 (the fixture's default one plus this one) — verified indirectly
    // via the download link, which is the only place files are exposed.
    const download = await request(app)
      .get(`/api/digital-products/${product.id}/download`)
      .set("Authorization", `Bearer ${token}`);
    expect(download.body.files).toHaveLength(2);
  });

  it("removes a deliverable file into the bin, not an immediate delete", async () => {
    const user = await createUser();
    const profile = await createDigitalCreatorProfile({ user });
    const product = await createDigitalProduct({ creator: profile });
    const token = generateToken(user);

    const added = await request(app)
      .post(`/api/digital-creator-profiles/me/products/${product.id}/files`)
      .set("Authorization", `Bearer ${token}`)
      .attach("files", TEST_PNG_BUFFER, "revision2.png");
    expect(added.status).toBe(201);

    const originalFileName = product.files[0].fileName;
    const beforeRemove = Date.now();
    const removed = await request(app)
      .delete(`/api/digital-creator-profiles/me/products/${product.id}/files/${originalFileName}`)
      .set("Authorization", `Bearer ${token}`);

    expect(removed.status).toBe(200);
    // The purchase-time-snapshot design depends on this never happening
    // immediately — a purchase mid-checkout may still need the source
    // object to exist until its grace period elapses.
    expect(getDigitalStorageProvider().deleteDigitalFile).not.toHaveBeenCalled();

    const updated = await DigitalProduct.findById(product.id);
    expect(updated?.bin).toHaveLength(1);
    expect(updated?.bin[0].file.fileName).toBe(originalFileName);
    expect(updated?.bin[0].deleteAt.getTime()).toBeGreaterThan(beforeRemove + 23 * 60 * 60 * 1000);

    const download = await request(app)
      .get(`/api/digital-products/${product.id}/download`)
      .set("Authorization", `Bearer ${token}`);
    expect(download.body.files).toHaveLength(1);
    expect(download.body.files[0].fileName).toBe("revision2.png");
  });

  it("clears an expired bin entry (actually deleting the file) the next time the product is touched", async () => {
    const user = await createUser();
    const profile = await createDigitalCreatorProfile({ user });
    const product = await createDigitalProduct({ creator: profile });
    const token = generateToken(user);

    await request(app)
      .post(`/api/digital-creator-profiles/me/products/${product.id}/files`)
      .set("Authorization", `Bearer ${token}`)
      .attach("files", TEST_PNG_BUFFER, "revision2.png");

    const originalFileName = product.files[0].fileName;
    await request(app)
      .delete(`/api/digital-creator-profiles/me/products/${product.id}/files/${originalFileName}`)
      .set("Authorization", `Bearer ${token}`);

    // Backdate the bin entry's deleteAt into the past, as if a day had
    // already passed, via the native driver — Mongoose's own timestamps
    // middleware doesn't touch this field, but going straight to the
    // collection avoids any doubt.
    await DigitalProduct.collection.updateOne(
      { _id: product._id },
      { $set: { "bin.0.deleteAt": new Date(Date.now() - 1000) } },
    );

    const res = await request(app)
      .patch(`/api/digital-creator-profiles/me/products/${product.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Touch the product" });

    expect(res.status).toBe(200);
    expect(getDigitalStorageProvider().deleteDigitalFile).toHaveBeenCalledTimes(1);

    const updated = await DigitalProduct.findById(product.id);
    expect(updated?.bin).toHaveLength(0);
  });

  it("rejects removing the last deliverable file", async () => {
    const user = await createUser();
    const profile = await createDigitalCreatorProfile({ user });
    const product = await createDigitalProduct({ creator: profile });
    const token = generateToken(user);

    const res = await request(app)
      .delete(`/api/digital-creator-profiles/me/products/${product.id}/files/${product.files[0].fileName}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
  });

  it("404s removing a file that doesn't exist on the product", async () => {
    const user = await createUser();
    const profile = await createDigitalCreatorProfile({ user });
    const product = await createDigitalProduct({ creator: profile });
    const token = generateToken(user);

    const res = await request(app)
      .delete(`/api/digital-creator-profiles/me/products/${product.id}/files/no-such-file.pdf`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});

describe("GET /api/digital-products/feed", () => {
  it("excludes an unverified or unsubscribed creator's products", async () => {
    const unsubscribed = await createUser();
    const unsubscribedProfile = await createDigitalCreatorProfile({ user: unsubscribed });
    await createDigitalProduct({ creator: unsubscribedProfile });

    const subscribedButUnverified = await createUserWithActiveSubscription();
    const unverifiedProfile = await createDigitalCreatorProfile({
      user: subscribedButUnverified,
      currentSubscription: subscribedButUnverified.currentSubscription,
      isVerified: false,
    });
    await createDigitalProduct({ creator: unverifiedProfile });

    const res = await request(app).get("/api/digital-products/feed");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it("includes a verified, subscribed creator's active products, with the creator attached", async () => {
    const user = await createUserWithActiveSubscription();
    const profile = await createDigitalCreatorProfile({
      user,
      currentSubscription: user.currentSubscription,
      isVerified: true,
    });
    const product = await createDigitalProduct({ creator: profile, isVerified: true });
    await createDigitalProduct({ creator: profile, isActive: false, isVerified: true });

    const res = await request(app).get("/api/digital-products/feed");

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(product.id);
    expect(res.body.data[0].creator.displayName).toBeTruthy();
  });

  it("filters by category", async () => {
    const user = await createUserWithActiveSubscription();
    const profile = await createDigitalCreatorProfile({
      user,
      currentSubscription: user.currentSubscription,
      isVerified: true,
    });
    await createDigitalProduct({
      creator: profile,
      category: DIGITAL_PRODUCT_CATEGORY.FLOOR_PLAN,
      isVerified: true,
    });
    await createDigitalProduct({
      creator: profile,
      category: DIGITAL_PRODUCT_CATEGORY.BOQ_SHEET,
      isVerified: true,
    });

    const res = await request(app).get(
      `/api/digital-products/feed?category=${DIGITAL_PRODUCT_CATEGORY.BOQ_SHEET}`,
    );

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].category).toBe(DIGITAL_PRODUCT_CATEGORY.BOQ_SHEET);
  });

  it("drops out of the feed live the moment the creator's subscription expires, with no write needed", async () => {
    const user = await createUserWithActiveSubscription();
    const profile = await createDigitalCreatorProfile({
      user,
      currentSubscription: user.currentSubscription,
      isVerified: true,
    });
    await createDigitalProduct({ creator: profile, isVerified: true });

    await Subscription.updateOne(
      { _id: user.currentSubscription },
      { expiresAt: new Date(Date.now() - 1000) },
    );

    const res = await request(app).get("/api/digital-products/feed");
    expect(res.body.data).toHaveLength(0);
  });
});

describe("GET /api/digital-products/:id", () => {
  it("withholds a product when its creator isn't verified and subscribed", async () => {
    const user = await createUser();
    const profile = await createDigitalCreatorProfile({ user });
    const product = await createDigitalProduct({ creator: profile });

    const res = await request(app).get(`/api/digital-products/${product.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false, message: expect.any(String) });
  });

  it("withholds a product when its creator is inactive (on a break) or banned", async () => {
    const inactiveUser = await createUserWithActiveSubscription();
    const inactiveProfile = await createDigitalCreatorProfile({
      user: inactiveUser,
      currentSubscription: inactiveUser.currentSubscription,
      isVerified: true,
      status: "inactive",
    });
    const inactiveProduct = await createDigitalProduct({ creator: inactiveProfile, isVerified: true });

    const inactiveRes = await request(app).get(`/api/digital-products/${inactiveProduct.id}`);
    expect(inactiveRes.body.available).toBe(false);

    const bannedUser = await createUserWithActiveSubscription();
    const bannedProfile = await createDigitalCreatorProfile({
      user: bannedUser,
      currentSubscription: bannedUser.currentSubscription,
      isVerified: true,
      status: "banned",
    });
    const bannedProduct = await createDigitalProduct({ creator: bannedProfile, isVerified: true });

    const bannedRes = await request(app).get(`/api/digital-products/${bannedProduct.id}`);
    expect(bannedRes.body.available).toBe(false);
  });

  it("returns the product once the creator is verified and subscribed", async () => {
    const user = await createUserWithActiveSubscription();
    const profile = await createDigitalCreatorProfile({
      user,
      currentSubscription: user.currentSubscription,
      isVerified: true,
    });
    const product = await createDigitalProduct({ creator: profile, isVerified: true });

    const res = await request(app).get(`/api/digital-products/${product.id}`);

    expect(res.status).toBe(200);
    expect(res.body.title).toBe(product.title);
  });

  it("withholds a product whose listing itself hasn't been verified yet, even if the creator has", async () => {
    const user = await createUserWithActiveSubscription();
    const profile = await createDigitalCreatorProfile({
      user,
      currentSubscription: user.currentSubscription,
      isVerified: true,
    });
    const product = await createDigitalProduct({ creator: profile }); // isVerified defaults false

    const res = await request(app).get(`/api/digital-products/${product.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false, message: expect.any(String) });
  });

  it("404s for an unknown product id", async () => {
    const res = await request(app).get("/api/digital-products/507f1f77bcf86cd799439011");
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/digital-products/:id/verify", () => {
  it("lets an admin confirm a listing is authentic", async () => {
    const admin = await createAdmin();
    const profile = await createDigitalCreatorProfile({ user: await createUser() });
    const product = await createDigitalProduct({ creator: profile });

    const res = await request(app)
      .patch(`/api/digital-products/${product.id}/verify`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({ isVerified: true });

    expect(res.status).toBe(200);
    expect(res.body.isVerified).toBe(true);
  });

  // Deliberately open to customer_care too — unlike most moderation
  // actions in this codebase, checking a listing's contents against
  // what it claims is exactly the kind of day-to-day review work
  // customer_care is meant to help with (see
  // digitalProductController.setDigitalProductVerification's own
  // comment).
  it("lets customer_care confirm or revoke a listing's verification too", async () => {
    const customerCare = await createCustomerCare();
    const profile = await createDigitalCreatorProfile({ user: await createUser() });
    const product = await createDigitalProduct({ creator: profile, isVerified: true });

    const res = await request(app)
      .patch(`/api/digital-products/${product.id}/verify`)
      .set("Authorization", `Bearer ${generateToken(customerCare)}`)
      .send({ isVerified: false });

    expect(res.status).toBe(200);
    expect(res.body.isVerified).toBe(false);
  });

  it("blocks a regular user", async () => {
    const user = await createUser();
    const profile = await createDigitalCreatorProfile({ user: await createUser() });
    const product = await createDigitalProduct({ creator: profile });

    const res = await request(app)
      .patch(`/api/digital-products/${product.id}/verify`)
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({ isVerified: true });

    expect(res.status).toBe(401);
  });
});

describe("GET /api/digital-products/:id/download", () => {
  it("requires authentication", async () => {
    const user = await createUser();
    const profile = await createDigitalCreatorProfile({ user });
    const product = await createDigitalProduct({ creator: profile });

    const res = await request(app).get(`/api/digital-products/${product.id}/download`);
    expect(res.status).toBe(401);
  });

  it("blocks anyone who isn't the product's own creator — a buyer uses GET /api/digital-purchases/:id/download instead", async () => {
    const user = await createUser();
    const profile = await createDigitalCreatorProfile({ user });
    const product = await createDigitalProduct({ creator: profile });
    const buyer = await createUser();
    await createDigitalPurchase({ product, buyer, creator: profile, status: DIGITAL_PURCHASE_STATUS.SUCCESS });

    const res = await request(app)
      .get(`/api/digital-products/${product.id}/download`)
      .set("Authorization", `Bearer ${generateToken(buyer)}`);

    expect(res.status).toBe(403);
  });

  it("lets the product's own creator download it", async () => {
    const user = await createUser();
    const profile = await createDigitalCreatorProfile({ user });
    const product = await createDigitalProduct({ creator: profile });

    const res = await request(app)
      .get(`/api/digital-products/${product.id}/download`)
      .set("Authorization", `Bearer ${generateToken(user)}`);

    expect(res.status).toBe(200);
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0].downloadUrl).toEqual(expect.any(String));
  });
});
