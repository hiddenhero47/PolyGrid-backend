import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import { createUser, createClientProfile, generateToken, TEST_PNG_BUFFER } from "../setup/fixtures";
import { User } from "../../src/models/userModel";

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

  // Full status (active/inactive/banned) behavior — self-service toggle,
  // admin-only ban, posting-eligibility exclusion — is covered in depth
  // once in consultancyProfile.test.ts (identical shared logic); this
  // just confirms the same wiring exists here too.
  it("lets me toggle my own status, but not to 'banned'; a banned profile rejects any update", async () => {
    const user = await createUser();
    await createClientProfile({ user });
    const token = generateToken(user);

    const toInactive = await request(app)
      .patch("/api/client-profiles/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "inactive" });
    expect(toInactive.status).toBe(200);
    expect(toInactive.body.status).toBe("inactive");

    const selfBan = await request(app)
      .patch("/api/client-profiles/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "banned" });
    expect(selfBan.status).toBe(400);

    const bannedUser = await createUser();
    await createClientProfile({ user: bannedUser, status: "banned" });
    const bannedUpdate = await request(app)
      .patch("/api/client-profiles/me")
      .set("Authorization", `Bearer ${generateToken(bannedUser)}`)
      .send({ bio: "Trying to sneak an edit in" });
    expect(bannedUpdate.status).toBe(403);
  });
});

// Full avatar-upload + account-avatar-fallback behavior is covered in
// depth once in consultancyProfile.test.ts (identical shared logic);
// this just confirms the same wiring exists here too.
describe("POST /api/client-profiles/me/avatar", () => {
  it("uploads an avatar, and falls back to the account avatar on /me until one is set", async () => {
    const user = await createUser();
    await createClientProfile({ user });
    const token = generateToken(user);

    await User.updateOne(
      { _id: user._id },
      { avatar: { fileName: "acct.png", storagePath: "/tmp/acct.png", mime: "image/png", size: 10, url: "/public/acct.png" } },
    );

    const beforeUpload = await request(app)
      .get("/api/client-profiles/me")
      .set("Authorization", `Bearer ${token}`);
    expect(beforeUpload.body.avatar.url).toBe("/public/acct.png");

    const uploaded = await request(app)
      .post("/api/client-profiles/me/avatar")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", TEST_PNG_BUFFER, "avatar.png");
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.avatar.mime).toBe("image/png");

    const afterUpload = await request(app)
      .get("/api/client-profiles/me")
      .set("Authorization", `Bearer ${token}`);
    expect(afterUpload.body.avatar.url).not.toBe("/public/acct.png");
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

  it("hides a banned poster's page outright, but an inactive (on-a-break) poster's page stays visible", async () => {
    const bannedUser = await createUser();
    const bannedProfile = await createClientProfile({ user: bannedUser, status: "banned" });

    const inactiveUser = await createUser();
    const inactiveProfile = await createClientProfile({ user: inactiveUser, status: "inactive" });

    const bannedRes = await request(app).get(`/api/client-profiles/${bannedProfile.id}`);
    expect(bannedRes.body.available).toBe(false);

    const inactiveRes = await request(app).get(`/api/client-profiles/${inactiveProfile.id}`);
    expect(inactiveRes.body.available).toBeUndefined();
    expect(inactiveRes.body.displayName).toBeTruthy();
  });

  it("404s for an unknown id", async () => {
    const res = await request(app).get("/api/client-profiles/507f1f77bcf86cd799439011");
    expect(res.status).toBe(404);
  });
});
