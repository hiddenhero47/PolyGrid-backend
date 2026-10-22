import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import {
  createUser,
  createLaborProfile,
  createUserWithActiveSubscription,
  generateToken,
  TEST_PNG_BUFFER,
} from "../setup/fixtures";
import { LABOR_SKILL, MAX_PROFILE_LINKS } from "../../src/models/laborProfileModel";
import { Subscription } from "../../src/models/subscriptionModel";
import { User } from "../../src/models/userModel";
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

describe("POST /api/labor-profiles", () => {
  it("requires authentication", async () => {
    const res = await request(app).post("/api/labor-profiles").send({});
    expect(res.status).toBe(401);
  });

  it("creates a profile with a unique slug, filtering invalid skills", async () => {
    const user = await createUser({ fullName: "Chidi Okafor" });

    const res = await request(app)
      .post("/api/labor-profiles")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({
        headline: "Experienced mason",
        country: "NG",
        skills: [LABOR_SKILL.MASONRY, "not-a-real-one"],
      });

    expect(res.status).toBe(201);
    expect(res.body.slug).toBe("chidi-okafor");
    expect(res.body.skills).toEqual([LABOR_SKILL.MASONRY]);
    expect(res.body.isVerified).toBe(false);
  });

  it("rejects a second profile for the same user", async () => {
    const user = await createUser();
    await createLaborProfile({ user });

    const res = await request(app)
      .post("/api/labor-profiles")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({ headline: "h", country: "NG" });

    expect(res.status).toBe(400);
  });

  it("rejects more than MAX_PROFILE_LINKS valid links", async () => {
    const user = await createUser();

    const res = await request(app)
      .post("/api/labor-profiles")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({
        headline: "h",
        country: "NG",
        links: Array.from({ length: MAX_PROFILE_LINKS + 1 }, (_, i) => ({
          label: `Link ${i}`,
          url: `https://example.com/${i}`,
        })),
      });

    expect(res.status).toBe(400);
  });
});

// Full status (active/inactive/banned) behavior — self-service toggle,
// admin-only ban, search/eligibility exclusion, banned-hides-the-page —
// is covered in depth once in consultancyProfile.test.ts (identical
// shared logic); this just confirms the same wiring exists here too.
describe("PATCH /api/labor-profiles/me", () => {
  it("lets me toggle my own status, but not to 'banned'; a banned profile rejects any update", async () => {
    const user = await createUser();
    await createLaborProfile({ user });
    const token = generateToken(user);

    const toInactive = await request(app)
      .patch("/api/labor-profiles/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "inactive" });
    expect(toInactive.status).toBe(200);
    expect(toInactive.body.status).toBe("inactive");

    const selfBan = await request(app)
      .patch("/api/labor-profiles/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "banned" });
    expect(selfBan.status).toBe(400);

    const bannedUser = await createUser();
    await createLaborProfile({ user: bannedUser, status: "banned" });
    const bannedUpdate = await request(app)
      .patch("/api/labor-profiles/me")
      .set("Authorization", `Bearer ${generateToken(bannedUser)}`)
      .send({ headline: "Trying to sneak an edit in" });
    expect(bannedUpdate.status).toBe(403);
  });
});

// Full avatar-upload + account-avatar-fallback behavior is covered in
// depth once in consultancyProfile.test.ts (identical shared logic);
// this just confirms the same wiring exists here too.
describe("POST /api/labor-profiles/me/avatar", () => {
  it("uploads an avatar, and falls back to the account avatar on /me until one is set", async () => {
    const user = await createUser();
    await createLaborProfile({ user });
    const token = generateToken(user);

    await User.updateOne(
      { _id: user._id },
      { avatar: { fileName: "acct.png", storagePath: "/tmp/acct.png", mime: "image/png", size: 10, url: "/public/acct.png" } },
    );

    const beforeUpload = await request(app)
      .get("/api/labor-profiles/me")
      .set("Authorization", `Bearer ${token}`);
    expect(beforeUpload.body.avatar.url).toBe("/public/acct.png");

    const uploaded = await request(app)
      .post("/api/labor-profiles/me/avatar")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", TEST_PNG_BUFFER, "avatar.png");
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.avatar.mime).toBe("image/png");

    const afterUpload = await request(app)
      .get("/api/labor-profiles/me")
      .set("Authorization", `Bearer ${token}`);
    expect(afterUpload.body.avatar.url).not.toBe("/public/acct.png");
  });
});

describe("GET /api/labor-profiles/:idOrSlug", () => {
  it("resolves the URL but withholds content when not currently subscribed", async () => {
    const user = await createUser();
    await createLaborProfile({ user, slug: "unsub-worker" });

    const res = await request(app).get("/api/labor-profiles/unsub-worker");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false, message: expect.any(String) });
  });

  it("returns the full profile once subscribed", async () => {
    const user = await createUserWithActiveSubscription();
    const profile = await createLaborProfile({
      user,
      currentSubscription: user.currentSubscription,
      slug: "sub-worker",
    });

    const res = await request(app).get("/api/labor-profiles/sub-worker");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(profile.id);
  });

  it("goes back to unavailable the moment the subscription expires, with no write needed", async () => {
    const user = await createUserWithActiveSubscription();
    await createLaborProfile({
      user,
      currentSubscription: user.currentSubscription,
      slug: "expiring-worker",
    });

    await Subscription.updateOne(
      { _id: user.currentSubscription },
      { expiresAt: new Date(Date.now() - 1000) },
    );

    const res = await request(app).get("/api/labor-profiles/expiring-worker");
    expect(res.body.available).toBe(false);
  });
});

describe("GET /api/labor-profiles (search)", () => {
  it("only lists profiles that are verified AND currently subscribed, filterable by skill", async () => {
    const eligible = await createUserWithActiveSubscription();
    await createLaborProfile({
      user: eligible,
      currentSubscription: eligible.currentSubscription,
      isVerified: true,
      skills: [LABOR_SKILL.ELECTRICAL],
      slug: "visible-worker",
    });

    const notSubscribed = await createUser();
    await createLaborProfile({ user: notSubscribed, isVerified: true, slug: "hidden-worker" });

    const match = await request(app).get(`/api/labor-profiles?skill=${LABOR_SKILL.ELECTRICAL}`);
    expect(match.body.data).toHaveLength(1);
    expect(match.body.data[0].slug).toBe("visible-worker");
    // Search results come from an aggregate() pipeline, whose plain
    // objects have no `.id` virtual — a frontend needs this to link into
    // the profile, so it must be patched back in explicitly.
    expect(match.body.data[0].id).toEqual(expect.any(String));

    const noMatch = await request(app).get(`/api/labor-profiles?skill=${LABOR_SKILL.PLUMBING}`);
    expect(noMatch.body.data).toHaveLength(0);
  });
});

describe("Portfolio (shared schema)", () => {
  it("adds and removes a portfolio item, deleting its media files from disk", async () => {
    const user = await createUser();
    await createLaborProfile({ user });
    const token = generateToken(user);

    const added = await request(app)
      .post("/api/labor-profiles/me/portfolio")
      .set("Authorization", `Bearer ${token}`)
      .field("data", JSON.stringify({ title: "Block wall, 2-bedroom bungalow" }))
      .attach("file", TEST_PNG_BUFFER, "wall.png");

    expect(added.status).toBe(201);
    expect(added.body.portfolio).toHaveLength(1);
    const fileName = added.body.portfolio[0].media[0].fileName;
    const publicDir = path.join(process.env.STORAGE_ROOT as string, "public");
    expect(fs.readdirSync(publicDir)).toContain(fileName);

    const itemId = added.body.portfolio[0]._id;
    const removed = await request(app)
      .delete(`/api/labor-profiles/me/portfolio/${itemId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(removed.status).toBe(200);
    expect(removed.body.portfolio).toHaveLength(0);
    expect(fs.readdirSync(publicDir)).not.toContain(fileName);
  });

  it("PATCHes an existing item's title without touching its media", async () => {
    const user = await createUser();
    await createLaborProfile({ user });
    const token = generateToken(user);

    const added = await request(app)
      .post("/api/labor-profiles/me/portfolio")
      .set("Authorization", `Bearer ${token}`)
      .field("data", JSON.stringify({ title: "Block wall, 2-bedroom bungalow" }))
      .attach("file", TEST_PNG_BUFFER, "wall.png");
    const itemId = added.body.portfolio[0]._id;

    const res = await request(app)
      .patch(`/api/labor-profiles/me/portfolio/${itemId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Block wall, 2-bedroom bungalow (complete)" });

    expect(res.status).toBe(200);
    expect(res.body.portfolio[0].title).toBe("Block wall, 2-bedroom bungalow (complete)");
    expect(res.body.portfolio[0].media).toHaveLength(1);
  });
});
