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
import { MAX_PRODUCT_IMAGES } from "../../src/models/productModel";
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

describe("POST /api/store-profiles/me/products", () => {
  it("requires authentication", async () => {
    const res = await request(app).post("/api/store-profiles/me/products").send({});
    expect(res.status).toBe(401);
  });

  it("rejects a category the store didn't declare it sells", async () => {
    const user = await createUser();
    await createStoreProfile({ user, categories: [MATERIAL_CATEGORY.CEMENT_CONCRETE] });

    const res = await request(app)
      .post("/api/store-profiles/me/products")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .field("data", JSON.stringify({ category: MATERIAL_CATEGORY.ROOFING, title: "Roof Sheets", price: 50, unit: "sheet" }));

    expect(res.status).toBe(400);
  });

  it("requires at least one shipping location", async () => {
    const user = await createUser();
    await createStoreProfile({ user, categories: [MATERIAL_CATEGORY.CEMENT_CONCRETE] });

    const res = await request(app)
      .post("/api/store-profiles/me/products")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .field(
        "data",
        JSON.stringify({
          category: MATERIAL_CATEGORY.CEMENT_CONCRETE,
          title: "Cement",
          price: 10,
          unit: "bag",
          shippingLocations: [],
        }),
      );

    expect(res.status).toBe(400);
  });

  it("rejects a shipping location with a made-up country or an out-of-country state", async () => {
    const user = await createUser();
    await createStoreProfile({ user, categories: [MATERIAL_CATEGORY.CEMENT_CONCRETE] });
    const token = generateToken(user);

    const badCountry = await request(app)
      .post("/api/store-profiles/me/products")
      .set("Authorization", `Bearer ${token}`)
      .field(
        "data",
        JSON.stringify({
          category: MATERIAL_CATEGORY.CEMENT_CONCRETE,
          title: "Cement",
          price: 10,
          unit: "bag",
          shippingLocations: [{ country: "ZZ", price: 5 }],
        }),
      );
    expect(badCountry.status).toBe(400);

    const badState = await request(app)
      .post("/api/store-profiles/me/products")
      .set("Authorization", `Bearer ${token}`)
      .field(
        "data",
        JSON.stringify({
          category: MATERIAL_CATEGORY.CEMENT_CONCRETE,
          title: "Cement",
          price: 10,
          unit: "bag",
          shippingLocations: [{ country: "NG", state: "CA", price: 5 }], // California isn't a Nigerian state
        }),
      );
    expect(badState.status).toBe(400);
  });

  it("accepts a state-specific shipping location alongside a nationwide one", async () => {
    const user = await createUser();
    await createStoreProfile({ user, categories: [MATERIAL_CATEGORY.CEMENT_CONCRETE] });

    const res = await request(app)
      .post("/api/store-profiles/me/products")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .field(
        "data",
        JSON.stringify({
          category: MATERIAL_CATEGORY.CEMENT_CONCRETE,
          title: "Cement",
          price: 10,
          unit: "bag",
          shippingLocations: [
            { country: "NG", price: 20 }, // nationwide default
            { country: "NG", state: "LA", price: 5 }, // cheaper, Lagos-specific
          ],
        }),
      );

    expect(res.status).toBe(201);
    expect(res.body.shippingLocations).toHaveLength(2);
  });

  it("creates a product with real image metadata", async () => {
    const user = await createUser();
    await createStoreProfile({ user, categories: [MATERIAL_CATEGORY.CEMENT_CONCRETE] });

    const res = await request(app)
      .post("/api/store-profiles/me/products")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .field(
        "data",
        JSON.stringify({
          category: MATERIAL_CATEGORY.CEMENT_CONCRETE,
          title: "Dangote Cement",
          price: 12.5,
          unit: "bag",
          shippingLocations: [{ country: "NG", price: 5 }],
        }),
      )
      .attach("file", TEST_PNG_BUFFER, "cement.png");

    expect(res.status).toBe(201);
    expect(res.body.title).toBe("Dangote Cement");
    expect(res.body.currency).toBe("USD");
    expect(res.body.stockStatus).toBe("in_stock");
    expect(res.body.images[0].mime).toBe("image/png");
    expect(res.body.shippingLocations).toEqual([{ country: "NG", price: 5 }]);
  });

  it("rejects attaching more than MAX_PRODUCT_IMAGES images", async () => {
    const user = await createUser();
    await createStoreProfile({ user, categories: [MATERIAL_CATEGORY.CEMENT_CONCRETE] });

    let req = request(app)
      .post("/api/store-profiles/me/products")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .field(
        "data",
        JSON.stringify({
          category: MATERIAL_CATEGORY.CEMENT_CONCRETE,
          title: "Cement",
          price: 10,
          unit: "bag",
          shippingLocations: [{ country: "NG", price: 5 }],
        }),
      );
    for (let i = 0; i < MAX_PRODUCT_IMAGES + 1; i++) {
      req = req.attach(`file${i}`, TEST_PNG_BUFFER, `image${i}.png`);
    }

    const res = await req;
    expect(res.status).toBe(400);
  });
});

describe("PATCH/DELETE /api/store-profiles/me/products/:id", () => {
  it("blocks updating a product that belongs to someone else's store", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const ownerStore = await createStoreProfile({ user: owner });
    await createStoreProfile({ user: stranger }); // stranger has a store, just not this product
    const product = await createProduct({ store: ownerStore });

    const res = await request(app)
      .patch(`/api/store-profiles/me/products/${product.id}`)
      .set("Authorization", `Bearer ${generateToken(stranger)}`)
      .send({ title: "Hijacked" });

    expect(res.status).toBe(404);
  });

  it("rejects updating to a category the store doesn't sell", async () => {
    const user = await createUser();
    const store = await createStoreProfile({ user, categories: [MATERIAL_CATEGORY.CEMENT_CONCRETE] });
    const product = await createProduct({ store });

    const res = await request(app)
      .patch(`/api/store-profiles/me/products/${product.id}`)
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({ category: MATERIAL_CATEGORY.ROOFING });

    expect(res.status).toBe(400);
  });

  it("deletes a product and its image files", async () => {
    const user = await createUser();
    await createStoreProfile({ user, categories: [MATERIAL_CATEGORY.CEMENT_CONCRETE] });
    const token = generateToken(user);

    const created = await request(app)
      .post("/api/store-profiles/me/products")
      .set("Authorization", `Bearer ${token}`)
      .field(
        "data",
        JSON.stringify({
          category: MATERIAL_CATEGORY.CEMENT_CONCRETE,
          title: "Cement",
          price: 10,
          unit: "bag",
          shippingLocations: [{ country: "NG", price: 5 }],
        }),
      )
      .attach("file", TEST_PNG_BUFFER, "cement.png");
    const fileName = created.body.images[0].fileName;
    const publicDir = path.join(process.env.STORAGE_ROOT as string, "public");
    expect(fs.readdirSync(publicDir)).toContain(fileName);

    const res = await request(app)
      .delete(`/api/store-profiles/me/products/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(await Product.findById(created.body.id)).toBeNull();
    expect(fs.readdirSync(publicDir)).not.toContain(fileName);
  });
});

describe("images sub-resource", () => {
  it("adds and removes a single image without touching the rest", async () => {
    const user = await createUser();
    const store = await createStoreProfile({ user, categories: [MATERIAL_CATEGORY.CEMENT_CONCRETE] });
    const product = await createProduct({ store });
    const token = generateToken(user);

    const added = await request(app)
      .post(`/api/store-profiles/me/products/${product.id}/images`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", TEST_PNG_BUFFER, "extra.png");
    expect(added.status).toBe(201);
    expect(added.body.images).toHaveLength(1);

    const fileName = added.body.images[0].fileName;
    const removed = await request(app)
      .delete(`/api/store-profiles/me/products/${product.id}/images/${fileName}`)
      .set("Authorization", `Bearer ${token}`);

    expect(removed.status).toBe(200);
    expect(removed.body.images).toHaveLength(0);
  });
});

describe("GET /api/products/:id", () => {
  it("withholds a product when its store isn't currently subscribed", async () => {
    const user = await createUser();
    const store = await createStoreProfile({ user });
    const product = await createProduct({ store });

    const res = await request(app).get(`/api/products/${product.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false, message: expect.any(String) });
  });

  it("returns the product once its store is subscribed", async () => {
    const user = await createUserWithActiveSubscription();
    const store = await createStoreProfile({ user, currentSubscription: user.currentSubscription });
    const product = await createProduct({ store });

    const res = await request(app).get(`/api/products/${product.id}`);

    expect(res.status).toBe(200);
    expect(res.body.title).toBe(product.title);
  });

  it("goes back to unavailable the moment the store's subscription expires", async () => {
    const user = await createUserWithActiveSubscription();
    const store = await createStoreProfile({ user, currentSubscription: user.currentSubscription });
    const product = await createProduct({ store });

    await Subscription.updateOne(
      { _id: user.currentSubscription },
      { expiresAt: new Date(Date.now() - 1000) },
    );

    const res = await request(app).get(`/api/products/${product.id}`);
    expect(res.body.available).toBe(false);
  });

  it("404s for an unknown product id", async () => {
    const res = await request(app).get("/api/products/507f1f77bcf86cd799439011");
    expect(res.status).toBe(404);
  });
});
