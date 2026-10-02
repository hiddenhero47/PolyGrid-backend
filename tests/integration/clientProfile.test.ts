import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import { createUser, createClientProfile, generateToken } from "../setup/fixtures";

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

describe("POST /api/client-profiles", () => {
  it("requires authentication", async () => {
    const res = await request(app).post("/api/client-profiles").send({});
    expect(res.status).toBe(401);
  });

  it("creates a client profile", async () => {
    const user = await createUser();

    const res = await request(app)
      .post("/api/client-profiles")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({ displayName: "Lagos Property Developer", country: "NG" });

    expect(res.status).toBe(201);
    expect(res.body.displayName).toBe("Lagos Property Developer");
    expect(res.body.ratingAverage).toBe(0);
    expect(res.body.ratingCount).toBe(0);
  });

  it("rejects a second profile for the same user", async () => {
    const user = await createUser();
    await createClientProfile({ user });

    const res = await request(app)
      .post("/api/client-profiles")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({ displayName: "Second", country: "NG" });

    expect(res.status).toBe(400);
  });

  it("requires a displayName and country", async () => {
    const user = await createUser();

    const res = await request(app)
      .post("/api/client-profiles")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({});

    expect(res.status).toBe(400);
  });
});

describe("GET /api/client-profiles/me and PATCH", () => {
  it("lets me update my own profile", async () => {
    const user = await createUser();
    await createClientProfile({ user });

    const res = await request(app)
      .patch("/api/client-profiles/me")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({ bio: "I manage three sites in Lagos" });

    expect(res.status).toBe(200);
    expect(res.body.bio).toBe("I manage three sites in Lagos");
  });
});

describe("GET /api/client-profiles/:id", () => {
  it("is public and never gated behind the poster's own subscription status", async () => {
    const user = await createUser(); // deliberately no subscription at all
    const profile = await createClientProfile({ user, currentSubscription: null });

    const res = await request(app).get(`/api/client-profiles/${profile.id}`);

    expect(res.status).toBe(200);
    expect(res.body.displayName).toBeTruthy();
    expect(res.body.available).toBeUndefined();
  });

  it("404s for an unknown id", async () => {
    const res = await request(app).get("/api/client-profiles/507f1f77bcf86cd799439011");
    expect(res.status).toBe(404);
  });
});
