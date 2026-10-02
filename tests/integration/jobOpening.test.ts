import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import {
  createUser,
  createUserWithActiveSubscription,
  createClientProfile,
  createLaborProfile,
  createJobOpening,
  createJobApplication,
  generateToken,
} from "../setup/fixtures";
import { LABOR_SKILL } from "../../src/models/laborProfileModel";
import { PAY_TYPE, EMPLOYMENT_TYPE } from "../../src/models/jobOpeningModel";
import { APPLICATION_STATUS } from "../../src/models/jobApplicationModel";
import { JobApplication } from "../../src/models/jobApplicationModel";
import { Job } from "../../src/models/jobModel";

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

const createEligiblePoster = async () => {
  const user = await createUserWithActiveSubscription();
  await createClientProfile({ user, currentSubscription: user.currentSubscription });
  return user;
};

const createEligibleWorker = async () => {
  const user = await createUserWithActiveSubscription();
  const profile = await createLaborProfile({
    user,
    currentSubscription: user.currentSubscription,
    isVerified: true,
  });
  return { user, profile };
};

const openingPayload = (overrides: Record<string, unknown> = {}) => ({
  title: "Need 2 general laborers",
  description: "Clearing a small plot for a weekend",
  category: LABOR_SKILL.GENERAL_LABOR,
  payRate: 50,
  payType: PAY_TYPE.DAILY,
  employmentType: EMPLOYMENT_TYPE.SHORT_TERM,
  generalArea: { country: "NG", state: "LA" },
  coordinates: { lat: 6.5244, lng: 3.3792 },
  address: "123 Test Street, Lagos",
  googleMapsUrl: "https://maps.google.com/?q=6.5244,3.3792",
  contactInfo: "+234 000 0000",
  ...overrides,
});

describe("POST /api/job-openings", () => {
  it("requires authentication", async () => {
    const res = await request(app).post("/api/job-openings").send({});
    expect(res.status).toBe(401);
  });

  it("requires a subscribed client profile", async () => {
    const user = await createUserWithActiveSubscription(); // no ClientProfile

    const res = await request(app)
      .post("/api/job-openings")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .field("data", JSON.stringify(openingPayload()));

    expect(res.status).toBe(402);
  });

  it("posts a job opening once I have a subscribed client profile", async () => {
    const poster = await createEligiblePoster();

    const res = await request(app)
      .post("/api/job-openings")
      .set("Authorization", `Bearer ${generateToken(poster)}`)
      .field("data", JSON.stringify(openingPayload()));

    expect(res.status).toBe(201);
    expect(res.body.title).toBe("Need 2 general laborers");
    expect(res.body.status).toBe("open");
    // The gated location tier is never in the create response either.
    expect(res.body.coordinates).toBeUndefined();
    expect(res.body.address).toBeUndefined();
  });

  it("rejects an invalid category, payType, or employmentType", async () => {
    const poster = await createEligiblePoster();
    const token = generateToken(poster);

    const badCategory = await request(app)
      .post("/api/job-openings")
      .set("Authorization", `Bearer ${token}`)
      .field("data", JSON.stringify(openingPayload({ category: "not-a-real-one" })));
    expect(badCategory.status).toBe(400);

    const badPayType = await request(app)
      .post("/api/job-openings")
      .set("Authorization", `Bearer ${token}`)
      .field("data", JSON.stringify(openingPayload({ payType: "not-a-real-one" })));
    expect(badPayType.status).toBe(400);
  });

  it("requires a positive payRate", async () => {
    const poster = await createEligiblePoster();

    const res = await request(app)
      .post("/api/job-openings")
      .set("Authorization", `Bearer ${generateToken(poster)}`)
      .field("data", JSON.stringify(openingPayload({ payRate: 0 })));

    expect(res.status).toBe(400);
  });
});

describe("GET /api/job-openings (the job board)", () => {
  it("blocks a non-eligible browser", async () => {
    const stranger = await createUser();

    const res = await request(app)
      .get("/api/job-openings")
      .set("Authorization", `Bearer ${generateToken(stranger)}`);

    expect(res.status).toBe(403);
  });

  it("lets an eligible worker browse open postings, filterable by category, with no gated fields present", async () => {
    const poster = await createEligiblePoster();
    await createJobOpening({ postedBy: poster, category: LABOR_SKILL.GENERAL_LABOR });
    await createJobOpening({ postedBy: poster, category: LABOR_SKILL.ELECTRICAL });

    const { user: workerUser } = await createEligibleWorker();

    const all = await request(app)
      .get("/api/job-openings")
      .set("Authorization", `Bearer ${generateToken(workerUser)}`);
    expect(all.body.data).toHaveLength(2);
    expect(all.body.data[0].coordinates).toBeUndefined();
    expect(all.body.data[0].address).toBeUndefined();
    expect(all.body.data[0].generalArea).toBeTruthy();

    const filtered = await request(app)
      .get(`/api/job-openings?category=${LABOR_SKILL.ELECTRICAL}`)
      .set("Authorization", `Bearer ${generateToken(workerUser)}`);
    expect(filtered.body.data).toHaveLength(1);
  });
});

describe("GET /api/job-openings/:id — the location-reveal safety gate", () => {
  it("withholds the posting entirely from a non-eligible viewer", async () => {
    const poster = await createEligiblePoster();
    const opening = await createJobOpening({ postedBy: poster });
    const stranger = await createUser();

    const res = await request(app)
      .get(`/api/job-openings/${opening.id}`)
      .set("Authorization", `Bearer ${generateToken(stranger)}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false, message: expect.any(String) });
  });

  it("shows an eligible worker the public tier only — never coordinates, address, Google Maps link, contact info, or files", async () => {
    const poster = await createEligiblePoster();
    const opening = await createJobOpening({ postedBy: poster });
    const { user: workerUser } = await createEligibleWorker();

    const res = await request(app)
      .get(`/api/job-openings/${opening.id}`)
      .set("Authorization", `Bearer ${generateToken(workerUser)}`);

    expect(res.status).toBe(200);
    expect(res.body.title).toBe(opening.title);
    expect(res.body.generalArea).toBeTruthy();
    expect(res.body.coordinates).toBeUndefined();
    expect(res.body.address).toBeUndefined();
    expect(res.body.googleMapsUrl).toBeUndefined();
    expect(res.body.contactInfo).toBeUndefined();
    expect(res.body.files).toBeUndefined();
  });

  it("shows the poster the full gated tier", async () => {
    const poster = await createEligiblePoster();
    const opening = await createJobOpening({ postedBy: poster });

    const res = await request(app)
      .get(`/api/job-openings/${opening.id}`)
      .set("Authorization", `Bearer ${generateToken(poster)}`);

    expect(res.status).toBe(200);
    expect(res.body.coordinates).toEqual({ lat: opening.coordinates!.lat, lng: opening.coordinates!.lng });
    expect(res.body.address).toBe(opening.address);
    expect(res.body.contactInfo).toBe(opening.contactInfo);
  });

  it("still withholds the gated tier from a worker who has merely applied, not been accepted", async () => {
    const poster = await createEligiblePoster();
    const opening = await createJobOpening({ postedBy: poster });
    const { user: workerUser, profile } = await createEligibleWorker();
    await createJobApplication({
      posting: opening,
      worker: profile,
      applicant: workerUser,
      status: APPLICATION_STATUS.PENDING,
    });

    const res = await request(app)
      .get(`/api/job-openings/${opening.id}`)
      .set("Authorization", `Bearer ${generateToken(workerUser)}`);

    expect(res.body.coordinates).toBeUndefined();
    expect(res.body.contactInfo).toBeUndefined();
  });

  it("reveals the gated tier only once the worker's application is accepted", async () => {
    const poster = await createEligiblePoster();
    const opening = await createJobOpening({ postedBy: poster });
    const { user: workerUser, profile } = await createEligibleWorker();
    await createJobApplication({
      posting: opening,
      worker: profile,
      applicant: workerUser,
      status: APPLICATION_STATUS.ACCEPTED,
    });

    const res = await request(app)
      .get(`/api/job-openings/${opening.id}`)
      .set("Authorization", `Bearer ${generateToken(workerUser)}`);

    expect(res.status).toBe(200);
    expect(res.body.coordinates).toEqual({ lat: opening.coordinates!.lat, lng: opening.coordinates!.lng });
    expect(res.body.contactInfo).toBe(opening.contactInfo);
  });
});

describe("POST /api/job-openings/:id/applications", () => {
  it("blocks a non-eligible worker from applying", async () => {
    const poster = await createEligiblePoster();
    const opening = await createJobOpening({ postedBy: poster });
    const stranger = await createUser();

    const res = await request(app)
      .post(`/api/job-openings/${opening.id}/applications`)
      .set("Authorization", `Bearer ${generateToken(stranger)}`)
      .field("data", JSON.stringify({ message: "I'd like to help" }));

    expect(res.status).toBe(403);
  });

  it("blocks the poster from applying to their own opening", async () => {
    const poster = await createEligiblePoster();
    const opening = await createJobOpening({ postedBy: poster });
    await createLaborProfile({
      user: poster,
      currentSubscription: poster.currentSubscription,
      isVerified: true,
    });

    const res = await request(app)
      .post(`/api/job-openings/${opening.id}/applications`)
      .set("Authorization", `Bearer ${generateToken(poster)}`)
      .field("data", JSON.stringify({}));

    expect(res.status).toBe(400);
  });

  it("submits an application, blocks a second one from the same worker", async () => {
    const poster = await createEligiblePoster();
    const opening = await createJobOpening({ postedBy: poster });
    const { user: workerUser } = await createEligibleWorker();
    const token = generateToken(workerUser);

    const first = await request(app)
      .post(`/api/job-openings/${opening.id}/applications`)
      .set("Authorization", `Bearer ${token}`)
      .field("data", JSON.stringify({ message: "I can start tomorrow" }));
    expect(first.status).toBe(201);
    expect(first.body.status).toBe("pending");

    const second = await request(app)
      .post(`/api/job-openings/${opening.id}/applications`)
      .set("Authorization", `Bearer ${token}`)
      .field("data", JSON.stringify({ message: "Again" }));
    expect(second.status).toBe(400);
  });
});

describe("PATCH .../applications/mine and .../withdraw", () => {
  it("lets a worker revise and then withdraw their own pending application", async () => {
    const poster = await createEligiblePoster();
    const opening = await createJobOpening({ postedBy: poster });
    const { user: workerUser } = await createEligibleWorker();
    const token = generateToken(workerUser);

    await request(app)
      .post(`/api/job-openings/${opening.id}/applications`)
      .set("Authorization", `Bearer ${token}`)
      .field("data", JSON.stringify({ message: "Original" }));

    const revised = await request(app)
      .patch(`/api/job-openings/${opening.id}/applications/mine`)
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "Revised" });
    expect(revised.status).toBe(200);
    expect(revised.body.message).toBe("Revised");

    const withdrawn = await request(app)
      .patch(`/api/job-openings/${opening.id}/applications/mine/withdraw`)
      .set("Authorization", `Bearer ${token}`);
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.status).toBe("withdrawn");
  });
});

describe("GET /api/job-openings/:id/applications — sealed from other applicants", () => {
  it("is poster-only; a fellow applicant can't see the list", async () => {
    const poster = await createEligiblePoster();
    const opening = await createJobOpening({ postedBy: poster });
    const { user: workerA } = await createEligibleWorker();
    const { user: workerB } = await createEligibleWorker();

    await request(app)
      .post(`/api/job-openings/${opening.id}/applications`)
      .set("Authorization", `Bearer ${generateToken(workerA)}`)
      .field("data", JSON.stringify({ message: "From A" }));

    const blockedForB = await request(app)
      .get(`/api/job-openings/${opening.id}/applications`)
      .set("Authorization", `Bearer ${generateToken(workerB)}`);
    expect(blockedForB.status).toBe(404);

    const visibleForPoster = await request(app)
      .get(`/api/job-openings/${opening.id}/applications`)
      .set("Authorization", `Bearer ${generateToken(poster)}`);
    expect(visibleForPoster.status).toBe(200);
    expect(visibleForPoster.body).toHaveLength(1);
    expect(visibleForPoster.body[0].message).toBe("From A");
  });
});

describe("PATCH .../applications/:applicationId/accept and /reject", () => {
  it("accepting creates a Job and fills the opening once workersNeeded is reached", async () => {
    const poster = await createEligiblePoster();
    const opening = await createJobOpening({ postedBy: poster, workersNeeded: 1, payRate: 75 });
    const { user: workerUser } = await createEligibleWorker();

    const applied = await request(app)
      .post(`/api/job-openings/${opening.id}/applications`)
      .set("Authorization", `Bearer ${generateToken(workerUser)}`)
      .field("data", JSON.stringify({ message: "Ready to work" }));

    const res = await request(app)
      .patch(`/api/job-openings/${opening.id}/applications/${applied.body.id}/accept`)
      .set("Authorization", `Bearer ${generateToken(poster)}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("accepted");
    expect(res.body.job).toBeTruthy();
    expect(res.body.job.totalAmount).toBe(75);
    expect(res.body.job.jobType).toBe("siteforce");
    expect(res.body.job.client.userId).toBe(poster.id);
    expect(res.body.job.provider.userId).toBe(workerUser.id);
    expect(res.body.opening.status).toBe("filled");

    const job = await Job.findById(res.body.job._id);
    expect(job).toBeTruthy();
  });

  it("rejects the remaining pending applications once the opening fills", async () => {
    const poster = await createEligiblePoster();
    const opening = await createJobOpening({ postedBy: poster, workersNeeded: 1 });
    const { user: workerA } = await createEligibleWorker();
    const { user: workerB } = await createEligibleWorker();

    const appA = await request(app)
      .post(`/api/job-openings/${opening.id}/applications`)
      .set("Authorization", `Bearer ${generateToken(workerA)}`)
      .field("data", JSON.stringify({}));
    const appB = await request(app)
      .post(`/api/job-openings/${opening.id}/applications`)
      .set("Authorization", `Bearer ${generateToken(workerB)}`)
      .field("data", JSON.stringify({}));

    await request(app)
      .patch(`/api/job-openings/${opening.id}/applications/${appA.body.id}/accept`)
      .set("Authorization", `Bearer ${generateToken(poster)}`);

    expect((await JobApplication.findById(appB.body.id))?.status).toBe("rejected");
  });

  it("explicit reject works without filling the opening", async () => {
    const poster = await createEligiblePoster();
    const opening = await createJobOpening({ postedBy: poster, workersNeeded: 2 });
    const { user: workerUser } = await createEligibleWorker();

    const applied = await request(app)
      .post(`/api/job-openings/${opening.id}/applications`)
      .set("Authorization", `Bearer ${generateToken(workerUser)}`)
      .field("data", JSON.stringify({}));

    const res = await request(app)
      .patch(`/api/job-openings/${opening.id}/applications/${applied.body.id}/reject`)
      .set("Authorization", `Bearer ${generateToken(poster)}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rejected");
  });
});

describe("PATCH /api/job-openings/:id/cancel", () => {
  it("cancels an open posting and rejects its pending applications", async () => {
    const poster = await createEligiblePoster();
    const opening = await createJobOpening({ postedBy: poster });
    const { user: workerUser } = await createEligibleWorker();

    const applied = await request(app)
      .post(`/api/job-openings/${opening.id}/applications`)
      .set("Authorization", `Bearer ${generateToken(workerUser)}`)
      .field("data", JSON.stringify({}));

    const res = await request(app)
      .patch(`/api/job-openings/${opening.id}/cancel`)
      .set("Authorization", `Bearer ${generateToken(poster)}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
    expect((await JobApplication.findById(applied.body.id))?.status).toBe("rejected");
  });
});

describe("GET /api/job-openings/me and /applications/mine", () => {
  it("lists only my own posted openings / my own applications", async () => {
    const poster = await createEligiblePoster();
    await createJobOpening({ postedBy: poster });
    const otherPoster = await createEligiblePoster();
    const theirOpening = await createJobOpening({ postedBy: otherPoster });

    const myOpenings = await request(app)
      .get("/api/job-openings/me")
      .set("Authorization", `Bearer ${generateToken(poster)}`);
    expect(myOpenings.body.data).toHaveLength(1);

    const { user: workerUser } = await createEligibleWorker();
    await request(app)
      .post(`/api/job-openings/${theirOpening.id}/applications`)
      .set("Authorization", `Bearer ${generateToken(workerUser)}`)
      .field("data", JSON.stringify({}));

    const myApplications = await request(app)
      .get("/api/job-openings/applications/mine")
      .set("Authorization", `Bearer ${generateToken(workerUser)}`);
    expect(myApplications.body.data).toHaveLength(1);
  });
});
