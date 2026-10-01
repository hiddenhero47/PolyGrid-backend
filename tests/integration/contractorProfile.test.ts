import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import {
  createUser,
  createContractorProfile,
  createUserWithActiveSubscription,
  generateToken,
  TEST_PNG_BUFFER,
} from "../setup/fixtures";
import { CONTRACTOR_SPECIALTY, MAX_PROFILE_LINKS } from "../../src/models/contractorProfileModel";
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

describe("POST /api/contractor-profiles", () => {
  it("requires authentication", async () => {
    const res = await request(app).post("/api/contractor-profiles").send({});
    expect(res.status).toBe(401);
  });

  it("creates a profile with a unique slug, filtering invalid specialties", async () => {
    const user = await createUser({ fullName: "Femi Adeyemi" });

    const res = await request(app)
      .post("/api/contractor-profiles")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({
        headline: "Residential structural contractor",
        country: "NG",
        specialties: [CONTRACTOR_SPECIALTY.STRUCTURAL, "not-a-real-one"],
      });

    expect(res.status).toBe(201);
    expect(res.body.slug).toBe("femi-adeyemi");
    expect(res.body.specialties).toEqual([CONTRACTOR_SPECIALTY.STRUCTURAL]);
    expect(res.body.isVerified).toBe(false);
    expect(res.body.ratingAverage).toBe(0);
    expect(res.body.ratingCount).toBe(0);
  });

  it("rejects a second profile for the same user", async () => {
    const user = await createUser();
    await createContractorProfile({ user });

    const res = await request(app)
      .post("/api/contractor-profiles")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({ headline: "h", country: "NG" });

    expect(res.status).toBe(400);
  });

  it("rejects more than MAX_PROFILE_LINKS valid links", async () => {
    const user = await createUser();

    const res = await request(app)
      .post("/api/contractor-profiles")
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

  it("requires a headline and country", async () => {
    const user = await createUser();

    const res = await request(app)
      .post("/api/contractor-profiles")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({});

    expect(res.status).toBe(400);
  });
});

describe("GET /api/contractor-profiles/me and PATCH", () => {
  it("404s when I have no profile", async () => {
    const user = await createUser();

    const res = await request(app)
      .get("/api/contractor-profiles/me")
      .set("Authorization", `Bearer ${generateToken(user)}`);

    expect(res.status).toBe(404);
  });

  it("lets me update my own profile", async () => {
    const user = await createUser();
    await createContractorProfile({ user });

    const res = await request(app)
      .patch("/api/contractor-profiles/me")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({ headline: "15 years of residential builds", specialties: [CONTRACTOR_SPECIALTY.ROOFING] });

    expect(res.status).toBe(200);
    expect(res.body.headline).toBe("15 years of residential builds");
    expect(res.body.specialties).toEqual([CONTRACTOR_SPECIALTY.ROOFING]);
  });
});

describe("GET /api/contractor-profiles/:idOrSlug", () => {
  it("resolves the URL but withholds content when not currently subscribed", async () => {
    const user = await createUser();
    await createContractorProfile({ user, slug: "unsub-contractor" });

    const res = await request(app).get("/api/contractor-profiles/unsub-contractor");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false, message: expect.any(String) });
  });

  it("returns the full profile once subscribed", async () => {
    const user = await createUserWithActiveSubscription();
    const profile = await createContractorProfile({
      user,
      currentSubscription: user.currentSubscription,
      slug: "sub-contractor",
    });

    const res = await request(app).get("/api/contractor-profiles/sub-contractor");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(profile.id);
    expect(res.body.headline).toBeTruthy();
  });

  it("goes back to unavailable the moment the subscription expires, with no write needed", async () => {
    const user = await createUserWithActiveSubscription();
    await createContractorProfile({
      user,
      currentSubscription: user.currentSubscription,
      slug: "expiring-contractor",
    });

    await Subscription.updateOne(
      { _id: user.currentSubscription },
      { expiresAt: new Date(Date.now() - 1000) },
    );

    const res = await request(app).get("/api/contractor-profiles/expiring-contractor");
    expect(res.body.available).toBe(false);
  });
});

describe("GET /api/contractor-profiles (search)", () => {
  it("only lists profiles that are verified AND currently subscribed, filterable by specialty", async () => {
    const eligible = await createUserWithActiveSubscription();
    await createContractorProfile({
      user: eligible,
      currentSubscription: eligible.currentSubscription,
      isVerified: true,
      specialties: [CONTRACTOR_SPECIALTY.ELECTRICAL],
      slug: "visible-contractor",
    });

    const notSubscribed = await createUser();
    await createContractorProfile({ user: notSubscribed, isVerified: true, slug: "hidden-contractor" });

    const match = await request(app).get(
      `/api/contractor-profiles?specialty=${CONTRACTOR_SPECIALTY.ELECTRICAL}`,
    );
    expect(match.body.data).toHaveLength(1);
    expect(match.body.data[0].slug).toBe("visible-contractor");

    const noMatch = await request(app).get(
      `/api/contractor-profiles?specialty=${CONTRACTOR_SPECIALTY.PLUMBING}`,
    );
    expect(noMatch.body.data).toHaveLength(0);
  });
});

describe("Portfolio (shared schema with ConsultancyProfile)", () => {
  const addItem = (token: string, payload: Record<string, unknown> = { title: "Duplex renovation" }) =>
    request(app)
      .post("/api/contractor-profiles/me/portfolio")
      .set("Authorization", `Bearer ${token}`)
      .field("data", JSON.stringify(payload));

  it("adds and removes a portfolio item, deleting its media files from disk", async () => {
    const user = await createUser();
    await createContractorProfile({ user });
    const token = generateToken(user);

    const added = await addItem(token).attach("file", TEST_PNG_BUFFER, "project.png");

    expect(added.status).toBe(201);
    expect(added.body.portfolio).toHaveLength(1);
    const fileName = added.body.portfolio[0].media[0].fileName;
    const publicDir = path.join(process.env.STORAGE_ROOT as string, "public");
    expect(fs.readdirSync(publicDir)).toContain(fileName);

    const itemId = added.body.portfolio[0]._id;
    const removed = await request(app)
      .delete(`/api/contractor-profiles/me/portfolio/${itemId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(removed.status).toBe(200);
    expect(removed.body.portfolio).toHaveLength(0);
    expect(fs.readdirSync(publicDir)).not.toContain(fileName);
  });

  it("requires a title", async () => {
    const user = await createUser();
    await createContractorProfile({ user });

    const res = await addItem(generateToken(user), {});
    expect(res.status).toBe(400);
  });
});
