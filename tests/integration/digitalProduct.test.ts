import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import {
  createUser,
  createUserWithActiveSubscription,
  createDigitalCreatorProfile,
  createDigitalProduct,
  createDigitalPurchase,
  generateToken,
  TEST_PNG_BUFFER,
} from "../setup/fixtures";
import { DIGITAL_PRODUCT_CATEGORY, MAX_PREVIEW_IMAGES } from "../../src/models/digitalProductModel";
import { DIGITAL_PURCHASE_STATUS } from "../../src/models/digitalPurchaseModel";
import { Subscription } from "../../src/models/subscriptionModel";

const app = createApp();

beforeAll(async () => {
  await connectTestDB();
});

afterEach(async () => {
  await clearTestDB();
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

describe("files sub-resource — append-only", () => {
  it("adds more deliverable files, with no remove endpoint available", async () => {
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
    const product = await createDigitalProduct({ creator: profile });
    await createDigitalProduct({ creator: profile, isActive: false });

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
    await createDigitalProduct({ creator: profile, category: DIGITAL_PRODUCT_CATEGORY.FLOOR_PLAN });
    await createDigitalProduct({ creator: profile, category: DIGITAL_PRODUCT_CATEGORY.BOQ_SHEET });

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
    await createDigitalProduct({ creator: profile });

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

  it("returns the product once the creator is verified and subscribed", async () => {
    const user = await createUserWithActiveSubscription();
    const profile = await createDigitalCreatorProfile({
      user,
      currentSubscription: user.currentSubscription,
      isVerified: true,
    });
    const product = await createDigitalProduct({ creator: profile });

    const res = await request(app).get(`/api/digital-products/${product.id}`);

    expect(res.status).toBe(200);
    expect(res.body.title).toBe(product.title);
  });

  it("404s for an unknown product id", async () => {
    const res = await request(app).get("/api/digital-products/507f1f77bcf86cd799439011");
    expect(res.status).toBe(404);
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

  it("blocks a stranger who never bought the product", async () => {
    const user = await createUser();
    const profile = await createDigitalCreatorProfile({ user });
    const product = await createDigitalProduct({ creator: profile });
    const stranger = await createUser();

    const res = await request(app)
      .get(`/api/digital-products/${product.id}/download`)
      .set("Authorization", `Bearer ${generateToken(stranger)}`);

    expect(res.status).toBe(403);
  });

  it("blocks a buyer whose purchase is still pending", async () => {
    const user = await createUser();
    const profile = await createDigitalCreatorProfile({ user });
    const product = await createDigitalProduct({ creator: profile });
    const buyer = await createUser();
    await createDigitalPurchase({
      product,
      buyer,
      creator: profile,
      status: DIGITAL_PURCHASE_STATUS.PENDING,
    });

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

  it("lets a successful buyer download it, and survives the creator's subscription later lapsing or the product going inactive", async () => {
    const user = await createUserWithActiveSubscription();
    const profile = await createDigitalCreatorProfile({
      user,
      currentSubscription: user.currentSubscription,
      isVerified: true,
    });
    const product = await createDigitalProduct({ creator: profile });
    const buyer = await createUser();
    await createDigitalPurchase({ product, buyer, creator: profile, status: DIGITAL_PURCHASE_STATUS.SUCCESS });

    const before = await request(app)
      .get(`/api/digital-products/${product.id}/download`)
      .set("Authorization", `Bearer ${generateToken(buyer)}`);
    expect(before.status).toBe(200);

    // The creator's subscription lapses and the listing goes inactive —
    // neither should ever revoke a completed purchase's download access.
    await Subscription.updateOne(
      { _id: user.currentSubscription },
      { expiresAt: new Date(Date.now() - 1000) },
    );
    product.isActive = false;
    await product.save();

    const after = await request(app)
      .get(`/api/digital-products/${product.id}/download`)
      .set("Authorization", `Bearer ${generateToken(buyer)}`);

    expect(after.status).toBe(200);
    expect(after.body.files).toHaveLength(1);
  });
});
