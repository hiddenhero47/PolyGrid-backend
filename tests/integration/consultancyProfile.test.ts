import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import {
  createUser,
  createAdmin,
  createConsultancyProfile,
  createUserWithActiveSubscription,
  createPlan,
  generateToken,
  TEST_PNG_BUFFER,
} from "../setup/fixtures";
import {
  ConsultancyProfile,
  SPECIALIZATION,
  MAX_PORTFOLIO_ITEMS,
  MAX_MEDIA_PER_ITEM,
  MAX_PROFILE_LINKS,
} from "../../src/models/consultancyProfileModel";
import { User } from "../../src/models/userModel";
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

describe("POST /api/consultancy-profiles", () => {
  it("requires authentication", async () => {
    const res = await request(app).post("/api/consultancy-profiles").send({});
    expect(res.status).toBe(401);
  });

  it("creates a profile with a unique slug", async () => {
    const user = await createUser({ fullName: "Ada Lovelace" });

    const res = await request(app)
      .post("/api/consultancy-profiles")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({
        headline: "Structural Engineer",
        country: "NG",
        specializations: [SPECIALIZATION.STRUCTURAL, "not-a-real-one"],
      });

    expect(res.status).toBe(201);
    expect(res.body.slug).toBe("ada-lovelace");
    expect(res.body.specializations).toEqual([SPECIALIZATION.STRUCTURAL]);
    expect(res.body.isVerified).toBe(false);
  });

  it("disambiguates a slug collision", async () => {
    const first = await createUser({ fullName: "Ada Lovelace" });
    const second = await createUser({ fullName: "Ada Lovelace" });

    await request(app)
      .post("/api/consultancy-profiles")
      .set("Authorization", `Bearer ${generateToken(first)}`)
      .send({ headline: "h", country: "NG" });

    const res = await request(app)
      .post("/api/consultancy-profiles")
      .set("Authorization", `Bearer ${generateToken(second)}`)
      .send({ headline: "h", country: "NG" });

    expect(res.status).toBe(201);
    expect(res.body.slug).not.toBe("ada-lovelace");
    expect(res.body.slug).toMatch(/^ada-lovelace-/);
  });

  it("rejects a second profile for the same user", async () => {
    const user = await createUser();
    await createConsultancyProfile({ user });

    const res = await request(app)
      .post("/api/consultancy-profiles")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({ headline: "h", country: "NG" });

    expect(res.status).toBe(400);
  });

  it("keeps valid links and silently drops malformed ones", async () => {
    const user = await createUser();

    const res = await request(app)
      .post("/api/consultancy-profiles")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({
        headline: "Structural Engineer",
        country: "NG",
        links: [
          { label: "Website", url: "https://example.com" },
          { label: "", url: "https://missing-label.com" }, // dropped
          { label: "Not a URL", url: "not-a-url" }, // dropped
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.links).toEqual([{ label: "Website", url: "https://example.com" }]);
  });

  it("rejects more than MAX_PROFILE_LINKS valid links", async () => {
    const user = await createUser();

    const res = await request(app)
      .post("/api/consultancy-profiles")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({
        headline: "Structural Engineer",
        country: "NG",
        links: Array.from({ length: MAX_PROFILE_LINKS + 1 }, (_, i) => ({
          label: `Link ${i}`,
          url: `https://example.com/${i}`,
        })),
      });

    expect(res.status).toBe(400);
  });

  it("requires a headline and country", async () => {
    const user = await createUser();

    const res = await request(app)
      .post("/api/consultancy-profiles")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({});

    expect(res.status).toBe(400);
  });
});

describe("GET /api/consultancy-profiles/me and PATCH", () => {
  it("404s when I have no profile", async () => {
    const user = await createUser();

    const res = await request(app)
      .get("/api/consultancy-profiles/me")
      .set("Authorization", `Bearer ${generateToken(user)}`);

    expect(res.status).toBe(404);
  });

  it("lets me update my own profile", async () => {
    const user = await createUser();
    await createConsultancyProfile({ user });

    const res = await request(app)
      .patch("/api/consultancy-profiles/me")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({
        headline: "Senior Structural Engineer",
        services: [{ title: "Structural audit", pricingMode: "fixed", price: 500 }],
        mentorship: { isMentor: true, areas: ["career-pathing"] },
        links: [{ label: "LinkedIn", url: "https://linkedin.com/in/example" }],
      });

    expect(res.status).toBe(200);
    expect(res.body.headline).toBe("Senior Structural Engineer");
    expect(res.body.services).toHaveLength(1);
    expect(res.body.mentorship.isMentor).toBe(true);
    expect(res.body.links).toEqual([{ label: "LinkedIn", url: "https://linkedin.com/in/example" }]);
  });

  it("rejects more than MAX_PROFILE_LINKS on update too", async () => {
    const user = await createUser();
    await createConsultancyProfile({ user });

    const res = await request(app)
      .patch("/api/consultancy-profiles/me")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({
        links: Array.from({ length: MAX_PROFILE_LINKS + 1 }, (_, i) => ({
          label: `Link ${i}`,
          url: `https://example.com/${i}`,
        })),
      });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/consultancy-profiles/:idOrSlug", () => {
  it("resolves the URL (200) but withholds content when not currently subscribed", async () => {
    const user = await createUser();
    const profile = await createConsultancyProfile({ user, slug: "jane-doe" });

    const byId = await request(app).get(`/api/consultancy-profiles/${profile.id}`);
    const bySlug = await request(app).get("/api/consultancy-profiles/jane-doe");

    expect(byId.status).toBe(200);
    expect(byId.body).toEqual({ available: false, message: expect.any(String) });
    expect(bySlug.status).toBe(200);
    expect(bySlug.body.available).toBe(false);
    // Nothing about the profile itself leaks through while unavailable.
    expect(bySlug.body.headline).toBeUndefined();
  });

  it("returns the full profile once subscribed, even if unverified", async () => {
    const user = await createUserWithActiveSubscription();
    const profile = await createConsultancyProfile({
      user,
      currentSubscription: user.currentSubscription,
      isVerified: false,
      slug: "jane-doe",
    });

    const res = await request(app).get("/api/consultancy-profiles/jane-doe");

    expect(res.status).toBe(200);
    expect(res.body.available).toBeUndefined();
    expect(res.body.id).toBe(profile.id);
    expect(res.body.headline).toBeTruthy();
  });

  it("goes back to unavailable the moment the subscription expires, with no write needed", async () => {
    const user = await createUserWithActiveSubscription();
    await createConsultancyProfile({
      user,
      currentSubscription: user.currentSubscription,
      slug: "jane-doe",
    });

    await Subscription.updateOne(
      { _id: user.currentSubscription },
      { expiresAt: new Date(Date.now() - 1000) },
    );

    const res = await request(app).get("/api/consultancy-profiles/jane-doe");
    expect(res.body.available).toBe(false);
  });

  it("404s for an unknown slug", async () => {
    const res = await request(app).get("/api/consultancy-profiles/does-not-exist");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/consultancy-profiles (search)", () => {
  it("only lists profiles that are verified AND currently subscribed", async () => {
    const verifiedAndSubscribed = await createUserWithActiveSubscription();
    await createConsultancyProfile({
      user: verifiedAndSubscribed,
      currentSubscription: verifiedAndSubscribed.currentSubscription,
      isVerified: true,
      slug: "visible-one",
    });

    const verifiedNotSubscribed = await createUser();
    await createConsultancyProfile({
      user: verifiedNotSubscribed,
      isVerified: true,
      slug: "not-subscribed",
    });

    const subscribedNotVerified = await createUserWithActiveSubscription();
    await createConsultancyProfile({
      user: subscribedNotVerified,
      currentSubscription: subscribedNotVerified.currentSubscription,
      isVerified: false,
      slug: "not-verified",
    });

    const res = await request(app).get("/api/consultancy-profiles");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].slug).toBe("visible-one");
  });

  it("filters by specialization", async () => {
    const user = await createUserWithActiveSubscription();
    await createConsultancyProfile({
      user,
      currentSubscription: user.currentSubscription,
      isVerified: true,
      specializations: [SPECIALIZATION.GEOTECHNICAL],
      slug: "geo-consultant",
    });

    const match = await request(app).get(
      `/api/consultancy-profiles?specialization=${SPECIALIZATION.GEOTECHNICAL}`,
    );
    const noMatch = await request(app).get(
      `/api/consultancy-profiles?specialization=${SPECIALIZATION.ARCHITECTURAL}`,
    );

    expect(match.body.data).toHaveLength(1);
    expect(noMatch.body.data).toHaveLength(0);
  });

  it("drops out of search once the subscription expires, with no write needed", async () => {
    const user = await createUserWithActiveSubscription();
    await createConsultancyProfile({
      user,
      currentSubscription: user.currentSubscription,
      isVerified: true,
      slug: "about-to-expire",
    });

    // Backdate the subscription's expiry directly — no code path "expires"
    // a subscription; it's just time-based at query time.
    await Subscription.updateOne(
      { _id: user.currentSubscription },
      { expiresAt: new Date(Date.now() - 1000) },
    );

    const res = await request(app).get("/api/consultancy-profiles");
    expect(res.body.data).toHaveLength(0);
  });
});

describe("Portfolio", () => {
  const addItem = (token: string, payload: Record<string, unknown> = { title: "Lagos Office Complex" }) =>
    request(app)
      .post("/api/consultancy-profiles/me/portfolio")
      .set("Authorization", `Bearer ${token}`)
      .field("data", JSON.stringify(payload));

  const publicDir = () => path.join(process.env.STORAGE_ROOT as string, "public");

  it("adds and removes a portfolio item, deleting its media files from disk", async () => {
    const user = await createUser();
    await createConsultancyProfile({ user });
    const token = generateToken(user);

    const added = await addItem(token, { title: "Lagos Office Complex", tags: ["structural"] }).attach(
      "file",
      TEST_PNG_BUFFER,
      "project.png",
    );

    expect(added.status).toBe(201);
    expect(added.body.portfolio).toHaveLength(1);
    expect(added.body.portfolio[0].media[0].url).toContain("/public/");
    expect(added.body.portfolio[0].media[0].mime).toBe("image/png");
    expect(added.body.portfolio[0].media[0].storagePath).toBeUndefined(); // never leaves the server

    const fileName = added.body.portfolio[0].media[0].fileName;
    expect(fs.readdirSync(publicDir())).toContain(fileName);

    const itemId = added.body.portfolio[0]._id;

    const removed = await request(app)
      .delete(`/api/consultancy-profiles/me/portfolio/${itemId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(removed.status).toBe(200);
    expect(removed.body.portfolio).toHaveLength(0);
    expect(fs.readdirSync(publicDir())).not.toContain(fileName);
  });

  it("requires a title", async () => {
    const user = await createUser();
    await createConsultancyProfile({ user });

    const res = await addItem(generateToken(user), {}).attach("file", TEST_PNG_BUFFER, "project.png");

    expect(res.status).toBe(400);
  });

  it("accepts startedAt and completedAt, and rejects completedAt before startedAt", async () => {
    const user = await createUser();
    await createConsultancyProfile({ user });
    const token = generateToken(user);

    const ok = await addItem(token, {
      title: "Lagos Office Complex",
      startedAt: "2024-01-01",
      completedAt: "2024-06-01",
    });
    expect(ok.status).toBe(201);
    expect(ok.body.portfolio[0].startedAt).toBeTruthy();
    expect(ok.body.portfolio[0].completedAt).toBeTruthy();

    const backwards = await addItem(token, {
      title: "Impossible Project",
      startedAt: "2024-06-01",
      completedAt: "2024-01-01",
    });
    expect(backwards.status).toBe(400);
  });

  it("rejects attaching more than MAX_MEDIA_PER_ITEM images to one item", async () => {
    const user = await createUser();
    await createConsultancyProfile({ user });

    let req = addItem(generateToken(user));
    for (let i = 0; i < MAX_MEDIA_PER_ITEM + 1; i++) {
      req = req.attach(`file${i}`, TEST_PNG_BUFFER, `project${i}.png`);
    }

    const res = await req;
    expect(res.status).toBe(400);
  });

  it("rejects creating a new item once MAX_PORTFOLIO_ITEMS is reached", async () => {
    const user = await createUser();
    const profile = await createConsultancyProfile({ user });

    // Directly seed up to the cap rather than making MAX_PORTFOLIO_ITEMS
    // real HTTP+upload round trips.
    for (let i = 0; i < MAX_PORTFOLIO_ITEMS; i++) {
      profile.portfolio.push({ title: `Project ${i}`, media: [], tags: [] });
    }
    await profile.save();

    const res = await addItem(generateToken(user));
    expect(res.status).toBe(400);
  });

  it("surfaces a failed upload as a non-blocking mediaWarnings entry", async () => {
    const user = await createUser();
    await createConsultancyProfile({ user });

    const res = await addItem(generateToken(user)).attach(
      "file",
      Buffer.from("not a real image"),
      "notes.txt",
    );

    expect(res.status).toBe(201);
    expect(res.body.portfolio[0].media).toHaveLength(0);
    expect(res.body.mediaWarnings).toBeDefined();
  });

  describe("POST .../portfolio/:itemId/media", () => {
    it("appends media to an existing item", async () => {
      const user = await createUser();
      await createConsultancyProfile({ user });
      const token = generateToken(user);

      const added = await addItem(token).attach("file", TEST_PNG_BUFFER, "project.png");
      const itemId = added.body.portfolio[0]._id;

      const res = await request(app)
        .post(`/api/consultancy-profiles/me/portfolio/${itemId}/media`)
        .set("Authorization", `Bearer ${token}`)
        .attach("file", TEST_PNG_BUFFER, "extra.png");

      expect(res.status).toBe(201);
      expect(res.body.portfolio[0].media).toHaveLength(2);
    });

    it("rejects once existing + new media would exceed MAX_MEDIA_PER_ITEM", async () => {
      const user = await createUser();
      const profile = await createConsultancyProfile({ user });
      const token = generateToken(user);

      profile.portfolio.push({
        title: "Full item",
        media: Array.from({ length: MAX_MEDIA_PER_ITEM }, (_, i) => ({
          fileName: `existing-${i}.png`,
          storagePath: `/tmp/existing-${i}.png`,
          mime: "image/png",
          size: 100,
        })),
        tags: [],
      });
      await profile.save();
      const itemId = profile.portfolio[0]._id;

      const res = await request(app)
        .post(`/api/consultancy-profiles/me/portfolio/${itemId}/media`)
        .set("Authorization", `Bearer ${token}`)
        .attach("file", TEST_PNG_BUFFER, "one-too-many.png");

      expect(res.status).toBe(400);
    });

    it("404s when the item belongs to someone else's profile, not mine", async () => {
      const owner = await createUser();
      const stranger = await createUser();
      const ownerProfile = await createConsultancyProfile({ user: owner });
      ownerProfile.portfolio.push({ title: "Not yours", media: [], tags: [] });
      await ownerProfile.save();
      // Stranger has their own profile, just not this item.
      await createConsultancyProfile({ user: stranger });

      const res = await request(app)
        .post(`/api/consultancy-profiles/me/portfolio/${ownerProfile.portfolio[0]._id}/media`)
        .set("Authorization", `Bearer ${generateToken(stranger)}`)
        .attach("file", TEST_PNG_BUFFER, "x.png");

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE .../portfolio/:itemId/media/:fileName", () => {
    it("removes one media file and deletes it from disk, keeping the item", async () => {
      const user = await createUser();
      await createConsultancyProfile({ user });
      const token = generateToken(user);

      const added = await addItem(token)
        .attach("file", TEST_PNG_BUFFER, "one.png")
        .attach("file2", TEST_PNG_BUFFER, "two.png");
      const itemId = added.body.portfolio[0]._id;
      const [first, second] = added.body.portfolio[0].media;

      const res = await request(app)
        .delete(`/api/consultancy-profiles/me/portfolio/${itemId}/media/${first.fileName}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.portfolio[0].media).toHaveLength(1);
      expect(res.body.portfolio[0].media[0].fileName).toBe(second.fileName);

      const files = fs.readdirSync(publicDir());
      expect(files).not.toContain(first.fileName);
      expect(files).toContain(second.fileName);
    });

    it("404s for an unknown fileName", async () => {
      const user = await createUser();
      await createConsultancyProfile({ user });
      const token = generateToken(user);

      const added = await addItem(token).attach("file", TEST_PNG_BUFFER, "one.png");
      const itemId = added.body.portfolio[0]._id;

      const res = await request(app)
        .delete(`/api/consultancy-profiles/me/portfolio/${itemId}/media/does-not-exist.png`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(404);
    });
  });
});

describe("Subscription sync", () => {
  it("granting a subscription updates an existing profile's currentSubscription", async () => {
    const user = await createUser();
    const profile = await createConsultancyProfile({ user });
    expect(profile.currentSubscription).toBeNull();

    const admin = await createAdmin();
    const plan = await createPlan();

    const grantRes = await request(app)
      .post("/api/subscriptions")
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({ userId: user.id, planTier: plan.planTier });

    expect(grantRes.status).toBe(201);

    const updatedProfile = await ConsultancyProfile.findById(profile.id);
    expect(updatedProfile?.currentSubscription?.toString()).toBe(grantRes.body._id);

    const updatedUser = await User.findById(user.id);
    expect(updatedUser?.currentSubscription?.toString()).toBe(grantRes.body._id);
  });
});
