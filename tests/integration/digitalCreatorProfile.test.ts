import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import {
  createUser,
  createUserWithActiveSubscription,
  createDigitalCreatorProfile,
  createDigitalProduct,
  generateToken,
  TEST_PNG_BUFFER,
} from "../setup/fixtures";
import { DigitalCreatorProfile } from "../../src/models/digitalCreatorProfileModel";
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

describe("POST /api/digital-creator-profiles", () => {
  it("requires authentication", async () => {
    const res = await request(app).post("/api/digital-creator-profiles").send({});
    expect(res.status).toBe(401);
  });

  it("creates a creator profile", async () => {
    const user = await createUser();

    const res = await request(app)
      .post("/api/digital-creator-profiles")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({ displayName: "Ada the Draftsman", country: "NG" });

    expect(res.status).toBe(201);
    expect(res.body.displayName).toBe("Ada the Draftsman");
    expect(res.body.slug).toBeTruthy();
  });

  it("rejects a second profile for the same user", async () => {
    const user = await createUser();
    await createDigitalCreatorProfile({ user });

    const res = await request(app)
      .post("/api/digital-creator-profiles")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({ displayName: "Second Profile", country: "NG" });

    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/digital-creator-profiles/me", () => {
  it("updates my own profile fields", async () => {
    const user = await createUser();
    await createDigitalCreatorProfile({ user });

    const res = await request(app)
      .patch("/api/digital-creator-profiles/me")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({ bio: "I draw floor plans for a living" });

    expect(res.status).toBe(200);
    expect(res.body.bio).toBe("I draw floor plans for a living");
  });
});

describe("POST /api/digital-creator-profiles/me/avatar", () => {
  it("uploads an avatar and replaces the old one", async () => {
    const user = await createUser();
    await createDigitalCreatorProfile({ user });
    const token = generateToken(user);

    const res = await request(app)
      .post("/api/digital-creator-profiles/me/avatar")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", TEST_PNG_BUFFER, "avatar.png");

    expect(res.status).toBe(200);
    expect(res.body.avatar.mime).toBe("image/png");
  });
});

describe("GET /api/digital-creator-profiles/:idOrSlug", () => {
  it("resolves the URL but withholds products when not currently subscribed", async () => {
    const user = await createUser();
    const creator = await createDigitalCreatorProfile({ user, slug: "unsub-creator" });
    await createDigitalProduct({ creator });

    const res = await request(app).get("/api/digital-creator-profiles/unsub-creator");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false, message: expect.any(String) });
  });

  it("returns the creator's active products once subscribed", async () => {
    const user = await createUserWithActiveSubscription();
    const creator = await createDigitalCreatorProfile({
      user,
      currentSubscription: user.currentSubscription,
      slug: "sub-creator",
    });
    await createDigitalProduct({ creator });
    await createDigitalProduct({ creator, isActive: false });

    const res = await request(app).get("/api/digital-creator-profiles/sub-creator");

    expect(res.status).toBe(200);
    expect(res.body.displayName).toBeTruthy();
    expect(res.body.products).toHaveLength(1);
  });

  it("goes back to unavailable the moment the subscription expires, with no write needed", async () => {
    const user = await createUserWithActiveSubscription();
    await createDigitalCreatorProfile({
      user,
      currentSubscription: user.currentSubscription,
      slug: "expiring-creator",
    });

    await Subscription.updateOne(
      { _id: user.currentSubscription },
      { expiresAt: new Date(Date.now() - 1000) },
    );

    const res = await request(app).get("/api/digital-creator-profiles/expiring-creator");
    expect(res.body.available).toBe(false);
  });

  it("404s for an unknown slug", async () => {
    const res = await request(app).get("/api/digital-creator-profiles/no-such-creator");
    expect(res.status).toBe(404);
  });
});

describe("model", () => {
  it("requires a userId, slug, displayName, and country", async () => {
    await expect(DigitalCreatorProfile.create({})).rejects.toThrow();
  });
});
