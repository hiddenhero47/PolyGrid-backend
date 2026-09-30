import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import {
  createUser,
  createUserWithActiveSubscription,
  createStoreProfile,
  createProduct,
  generateToken,
  TEST_PNG_BUFFER,
} from "../setup/fixtures";
import { MATERIAL_CATEGORY } from "../../src/models/storeProfileModel";
import { Product } from "../../src/models/productModel";
import { Subscription } from "../../src/models/subscriptionModel";
import fs from "fs";
import path from "path";

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

describe("POST /api/store-profiles", () => {
  it("requires authentication", async () => {
    const res = await request(app).post("/api/store-profiles").send({});
    expect(res.status).toBe(401);
  });

  it("creates a store with at least one category", async () => {
    const user = await createUser();

    const res = await request(app)
      .post("/api/store-profiles")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({
        storeName: "Lagos Building Supplies",
        country: "NG",
        categories: [MATERIAL_CATEGORY.CEMENT_CONCRETE, MATERIAL_CATEGORY.STEEL_REINFORCEMENT, "not-a-real-one"],
      });

    expect(res.status).toBe(201);
    expect(res.body.categories).toEqual([
      MATERIAL_CATEGORY.CEMENT_CONCRETE,
      MATERIAL_CATEGORY.STEEL_REINFORCEMENT,
    ]);
  });

  it("rejects creating a store with no valid category", async () => {
    const user = await createUser();

    const res = await request(app)
      .post("/api/store-profiles")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({ storeName: "No Categories", country: "NG", categories: [] });

    expect(res.status).toBe(400);
  });

  it("rejects a second store for the same user", async () => {
    const user = await createUser();
    await createStoreProfile({ user });

    const res = await request(app)
      .post("/api/store-profiles")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({ storeName: "Second Store", country: "NG", categories: [MATERIAL_CATEGORY.ROOFING] });

    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/store-profiles/me — category cascade delete", () => {
  it("deletes every product under a removed category, including its image files", async () => {
    const user = await createUser();
    const store = await createStoreProfile({
      user,
      categories: [MATERIAL_CATEGORY.CEMENT_CONCRETE, MATERIAL_CATEGORY.ROOFING],
    });
    const token = generateToken(user);

    const cementProductAdded = await request(app)
      .post("/api/store-profiles/me/products")
      .set("Authorization", `Bearer ${token}`)
      .field(
        "data",
        JSON.stringify({
          category: MATERIAL_CATEGORY.CEMENT_CONCRETE,
          title: "Cement Bag",
          price: 10,
          unit: "bag",
          shippingLocations: [{ country: "NG", price: 5 }],
        }),
      )
      .attach("file", TEST_PNG_BUFFER, "cement.png");
    const roofingProduct = await createProduct({ store, category: MATERIAL_CATEGORY.ROOFING });

    const imageFileName = cementProductAdded.body.images[0].fileName;
    const publicDir = path.join(process.env.STORAGE_ROOT as string, "public");
    expect(fs.readdirSync(publicDir)).toContain(imageFileName);

    const res = await request(app)
      .patch("/api/store-profiles/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ categories: [MATERIAL_CATEGORY.ROOFING] }); // drops cement_concrete

    expect(res.status).toBe(200);
    expect(await Product.findById(cementProductAdded.body.id)).toBeNull();
    expect(await Product.findById(roofingProduct.id)).not.toBeNull();
    expect(fs.readdirSync(publicDir)).not.toContain(imageFileName);
  });

  it("rejects removing every category (a store must keep selling something)", async () => {
    const user = await createUser();
    await createStoreProfile({ user, categories: [MATERIAL_CATEGORY.CEMENT_CONCRETE] });
    const token = generateToken(user);

    const res = await request(app)
      .patch("/api/store-profiles/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ categories: [] });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/store-profiles/:idOrSlug", () => {
  it("resolves the URL but withholds content when not currently subscribed", async () => {
    const user = await createUser();
    const store = await createStoreProfile({ user, slug: "unsub-store" });
    await createProduct({ store });

    const res = await request(app).get("/api/store-profiles/unsub-store");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false, message: expect.any(String) });
  });

  it("returns the full catalog once subscribed", async () => {
    const user = await createUserWithActiveSubscription();
    const store = await createStoreProfile({
      user,
      currentSubscription: user.currentSubscription,
      slug: "sub-store",
      categories: [MATERIAL_CATEGORY.CEMENT_CONCRETE, MATERIAL_CATEGORY.ROOFING],
    });
    await createProduct({ store, category: MATERIAL_CATEGORY.CEMENT_CONCRETE });
    await createProduct({ store, category: MATERIAL_CATEGORY.ROOFING });

    const res = await request(app).get("/api/store-profiles/sub-store");

    expect(res.status).toBe(200);
    expect(res.body.storeName).toBeTruthy();
    expect(res.body.products).toHaveLength(2);
  });

  it("filters products by category within a store", async () => {
    const user = await createUserWithActiveSubscription();
    const store = await createStoreProfile({
      user,
      currentSubscription: user.currentSubscription,
      slug: "filtered-store",
      categories: [MATERIAL_CATEGORY.CEMENT_CONCRETE, MATERIAL_CATEGORY.ROOFING],
    });
    await createProduct({ store, category: MATERIAL_CATEGORY.CEMENT_CONCRETE });
    await createProduct({ store, category: MATERIAL_CATEGORY.ROOFING });

    const res = await request(app).get(
      `/api/store-profiles/filtered-store?category=${MATERIAL_CATEGORY.ROOFING}`,
    );

    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0].category).toBe(MATERIAL_CATEGORY.ROOFING);
  });

  it("goes back to unavailable the moment the subscription expires, with no write needed", async () => {
    const user = await createUserWithActiveSubscription();
    await createStoreProfile({ user, currentSubscription: user.currentSubscription, slug: "expiring-store" });

    await Subscription.updateOne(
      { _id: user.currentSubscription },
      { expiresAt: new Date(Date.now() - 1000) },
    );

    const res = await request(app).get("/api/store-profiles/expiring-store");
    expect(res.body.available).toBe(false);
  });
});

describe("GET /api/store-profiles (search)", () => {
  it("only lists verified AND currently-subscribed stores, filterable by category", async () => {
    const subscribedVerified = await createUserWithActiveSubscription();
    await createStoreProfile({
      user: subscribedVerified,
      currentSubscription: subscribedVerified.currentSubscription,
      isVerified: true,
      categories: [MATERIAL_CATEGORY.AGGREGATES],
      slug: "visible-store",
    });

    const notSubscribed = await createUser();
    await createStoreProfile({ user: notSubscribed, isVerified: true, slug: "hidden-store" });

    const res = await request(app).get(`/api/store-profiles?category=${MATERIAL_CATEGORY.AGGREGATES}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].slug).toBe("visible-store");
  });

  it("includes a preview of products for each matching store", async () => {
    const user = await createUserWithActiveSubscription();
    const store = await createStoreProfile({
      user,
      currentSubscription: user.currentSubscription,
      isVerified: true,
      categories: [MATERIAL_CATEGORY.TIMBER_WOOD],
      slug: "preview-store",
    });
    await createProduct({ store, category: MATERIAL_CATEGORY.TIMBER_WOOD });

    const res = await request(app).get(`/api/store-profiles?category=${MATERIAL_CATEGORY.TIMBER_WOOD}`);

    expect(res.body.data[0].previewProducts).toHaveLength(1);
  });
});

describe("POST /api/store-profiles/me/logo", () => {
  it("uploads a logo and deletes the old one when replaced", async () => {
    const user = await createUser();
    await createStoreProfile({ user });
    const token = generateToken(user);

    const first = await request(app)
      .post("/api/store-profiles/me/logo")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", TEST_PNG_BUFFER, "logo1.png");
    expect(first.status).toBe(200);
    const firstFileName = first.body.logo.fileName;

    const publicDir = path.join(process.env.STORAGE_ROOT as string, "public");
    expect(fs.readdirSync(publicDir)).toContain(firstFileName);

    const second = await request(app)
      .post("/api/store-profiles/me/logo")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", TEST_PNG_BUFFER, "logo2.png");
    expect(second.status).toBe(200);

    expect(fs.readdirSync(publicDir)).not.toContain(firstFileName);
    expect(fs.readdirSync(publicDir)).toContain(second.body.logo.fileName);
  });
});
