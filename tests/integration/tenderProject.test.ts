import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import {
  createUser,
  createUserWithActiveSubscription,
  createContractorProfile,
  createClientProfile,
  createTenderProject,
  createBid,
  generateToken,
} from "../setup/fixtures";
import { TENDER_CATEGORY } from "../../src/models/tenderProjectModel";
import { Bid } from "../../src/models/bidModel";
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

// A contractor eligible to browse/bid: verified + currently subscribed.
const createEligibleContractor = async () => {
  const user = await createUserWithActiveSubscription();
  const profile = await createContractorProfile({
    user,
    currentSubscription: user.currentSubscription,
    isVerified: true,
  });
  return { user, profile };
};

// A poster eligible to post a project: a subscribed ClientProfile — no
// `isVerified` required (see clientProfileModel.ts).
const createEligiblePoster = async () => {
  const user = await createUserWithActiveSubscription();
  await createClientProfile({ user, currentSubscription: user.currentSubscription });
  return user;
};

const futureDeadline = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

describe("POST /api/tender-projects", () => {
  it("requires authentication", async () => {
    const res = await request(app).post("/api/tender-projects").send({});
    expect(res.status).toBe(401);
  });

  it("requires a subscribed client profile", async () => {
    const userWithNoProfile = await createUserWithActiveSubscription();
    const userWithNoSub = await createUser();
    await createClientProfile({ user: userWithNoSub });

    for (const user of [userWithNoProfile, userWithNoSub]) {
      const res = await request(app)
        .post("/api/tender-projects")
        .set("Authorization", `Bearer ${generateToken(user)}`)
        .field(
          "data",
          JSON.stringify({
            title: "New roof",
            description: "Replace the roof",
            category: TENDER_CATEGORY.ROOFING,
            location: { country: "NG" },
            bidDeadline: futureDeadline(),
          }),
        );

      expect(res.status).toBe(402);
    }
  });

  it("posts a project once I have a subscribed client profile", async () => {
    const user = await createEligiblePoster();

    const res = await request(app)
      .post("/api/tender-projects")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .field(
        "data",
        JSON.stringify({
          title: "New roof",
          description: "Replace the roof on a 3-bedroom bungalow",
          category: TENDER_CATEGORY.ROOFING,
          location: { country: "NG", state: "LA" },
          bidDeadline: futureDeadline(),
        }),
      );

    expect(res.status).toBe(201);
    expect(res.body.title).toBe("New roof");
    expect(res.body.status).toBe("open");
    expect(res.body.bidCount).toBe(0);
  });

  it("rejects a bidDeadline in the past", async () => {
    const user = await createEligiblePoster();

    const res = await request(app)
      .post("/api/tender-projects")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .field(
        "data",
        JSON.stringify({
          title: "New roof",
          description: "d",
          category: TENDER_CATEGORY.ROOFING,
          location: { country: "NG" },
          bidDeadline: new Date(Date.now() - 1000).toISOString(),
        }),
      );

    expect(res.status).toBe(400);
  });

  it("rejects an invalid category", async () => {
    const user = await createEligiblePoster();

    const res = await request(app)
      .post("/api/tender-projects")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .field(
        "data",
        JSON.stringify({
          title: "New roof",
          description: "d",
          category: "not-a-real-one",
          location: { country: "NG" },
          bidDeadline: futureDeadline(),
        }),
      );

    expect(res.status).toBe(400);
  });
});

describe("GET /api/tender-projects (the bidding board)", () => {
  it("blocks a non-eligible browser (no contractor profile, or unverified/unsubscribed)", async () => {
    const stranger = await createUser();

    const res = await request(app)
      .get("/api/tender-projects")
      .set("Authorization", `Bearer ${generateToken(stranger)}`);

    expect(res.status).toBe(403);
  });

  it("lets an eligible contractor browse open projects, filterable by category", async () => {
    const poster = await createUserWithActiveSubscription();
    await createTenderProject({ postedBy: poster, category: TENDER_CATEGORY.ROOFING });
    await createTenderProject({ postedBy: poster, category: TENDER_CATEGORY.ELECTRICAL });

    const { user: contractorUser } = await createEligibleContractor();

    const all = await request(app)
      .get("/api/tender-projects")
      .set("Authorization", `Bearer ${generateToken(contractorUser)}`);
    expect(all.body.data).toHaveLength(2);

    const filtered = await request(app)
      .get(`/api/tender-projects?category=${TENDER_CATEGORY.ROOFING}`)
      .set("Authorization", `Bearer ${generateToken(contractorUser)}`);
    expect(filtered.body.data).toHaveLength(1);
    expect(filtered.body.data[0].category).toBe(TENDER_CATEGORY.ROOFING);
  });

  it("excludes a project past its own bid deadline", async () => {
    const poster = await createUserWithActiveSubscription();
    await createTenderProject({ postedBy: poster, bidDeadline: new Date(Date.now() - 1000) });

    const { user: contractorUser } = await createEligibleContractor();

    const res = await request(app)
      .get("/api/tender-projects")
      .set("Authorization", `Bearer ${generateToken(contractorUser)}`);

    expect(res.body.data).toHaveLength(0);
  });
});

describe("GET /api/tender-projects/:id", () => {
  it("withholds full detail from a non-eligible viewer", async () => {
    const poster = await createUserWithActiveSubscription();
    const project = await createTenderProject({ postedBy: poster });
    const stranger = await createUser();

    const res = await request(app)
      .get(`/api/tender-projects/${project.id}`)
      .set("Authorization", `Bearer ${generateToken(stranger)}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false, message: expect.any(String) });
  });

  it("shows full detail (with signed file links) to the poster and to an eligible contractor", async () => {
    const poster = await createUserWithActiveSubscription();
    const project = await createTenderProject({ postedBy: poster });
    const { user: contractorUser } = await createEligibleContractor();

    const asPoster = await request(app)
      .get(`/api/tender-projects/${project.id}`)
      .set("Authorization", `Bearer ${generateToken(poster)}`);
    expect(asPoster.status).toBe(200);
    expect(asPoster.body.title).toBe(project.title);

    const asContractor = await request(app)
      .get(`/api/tender-projects/${project.id}`)
      .set("Authorization", `Bearer ${generateToken(contractorUser)}`);
    expect(asContractor.status).toBe(200);
    expect(asContractor.body.title).toBe(project.title);
  });
});

describe("POST /api/tender-projects/:id/bids — sealed bidding", () => {
  it("blocks a non-eligible contractor from bidding", async () => {
    const poster = await createUserWithActiveSubscription();
    const project = await createTenderProject({ postedBy: poster });
    const stranger = await createUser();

    const res = await request(app)
      .post(`/api/tender-projects/${project.id}/bids`)
      .set("Authorization", `Bearer ${generateToken(stranger)}`)
      .field("data", JSON.stringify({ amount: 5000, proposal: "I can do this" }));

    expect(res.status).toBe(403);
  });

  it("blocks the poster from bidding on their own project", async () => {
    const poster = await createUserWithActiveSubscription();
    const project = await createTenderProject({ postedBy: poster });
    // Make the poster also an eligible contractor to isolate the
    // self-bid check from the eligibility check.
    await createContractorProfile({
      user: poster,
      currentSubscription: poster.currentSubscription,
      isVerified: true,
    });

    const res = await request(app)
      .post(`/api/tender-projects/${project.id}/bids`)
      .set("Authorization", `Bearer ${generateToken(poster)}`)
      .field("data", JSON.stringify({ amount: 5000, proposal: "I can do this" }));

    expect(res.status).toBe(400);
  });

  it("submits a bid and increments bidCount, blocks a second bid from the same contractor", async () => {
    const poster = await createUserWithActiveSubscription();
    const project = await createTenderProject({ postedBy: poster });
    const { user: contractorUser } = await createEligibleContractor();
    const token = generateToken(contractorUser);

    const first = await request(app)
      .post(`/api/tender-projects/${project.id}/bids`)
      .set("Authorization", `Bearer ${token}`)
      .field("data", JSON.stringify({ amount: 5000, proposal: "I can do this well" }));

    expect(first.status).toBe(201);
    expect(first.body.status).toBe("pending");

    const afterFirst = await request(app)
      .get(`/api/tender-projects/${project.id}`)
      .set("Authorization", `Bearer ${generateToken(poster)}`);
    expect(afterFirst.body.bidCount).toBe(1);

    const second = await request(app)
      .post(`/api/tender-projects/${project.id}/bids`)
      .set("Authorization", `Bearer ${token}`)
      .field("data", JSON.stringify({ amount: 4500, proposal: "Actually, cheaper" }));

    expect(second.status).toBe(400);
  });

  it("requires a positive amount and a proposal", async () => {
    const poster = await createUserWithActiveSubscription();
    const project = await createTenderProject({ postedBy: poster });
    const { user: contractorUser } = await createEligibleContractor();

    const res = await request(app)
      .post(`/api/tender-projects/${project.id}/bids`)
      .set("Authorization", `Bearer ${generateToken(contractorUser)}`)
      .field("data", JSON.stringify({}));

    expect(res.status).toBe(400);
  });

  it("a competing contractor never sees another contractor's bid, only via the sealed getProjectBids (poster-only)", async () => {
    const poster = await createUserWithActiveSubscription();
    const project = await createTenderProject({ postedBy: poster });
    const { user: contractorA } = await createEligibleContractor();
    const { user: contractorB } = await createEligibleContractor();

    await request(app)
      .post(`/api/tender-projects/${project.id}/bids`)
      .set("Authorization", `Bearer ${generateToken(contractorA)}`)
      .field("data", JSON.stringify({ amount: 5000, proposal: "From A" }));

    const blockedForB = await request(app)
      .get(`/api/tender-projects/${project.id}/bids`)
      .set("Authorization", `Bearer ${generateToken(contractorB)}`);
    expect(blockedForB.status).toBe(404); // contractorB isn't the poster

    const visibleForPoster = await request(app)
      .get(`/api/tender-projects/${project.id}/bids`)
      .set("Authorization", `Bearer ${generateToken(poster)}`);
    expect(visibleForPoster.status).toBe(200);
    expect(visibleForPoster.body).toHaveLength(1);
    expect(visibleForPoster.body[0].proposal).toBe("From A");
  });
});

describe("PATCH /api/tender-projects/:id/bids/mine and .../withdraw", () => {
  it("lets a contractor revise their own pending bid", async () => {
    const poster = await createUserWithActiveSubscription();
    const project = await createTenderProject({ postedBy: poster });
    const { user: contractorUser } = await createEligibleContractor();
    const token = generateToken(contractorUser);

    await request(app)
      .post(`/api/tender-projects/${project.id}/bids`)
      .set("Authorization", `Bearer ${token}`)
      .field("data", JSON.stringify({ amount: 5000, proposal: "Original" }));

    const res = await request(app)
      .patch(`/api/tender-projects/${project.id}/bids/mine`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: 4800, proposal: "Revised, cheaper" });

    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(4800);
    expect(res.body.proposal).toBe("Revised, cheaper");
  });

  it("lets a contractor withdraw their bid, decrementing bidCount", async () => {
    const poster = await createUserWithActiveSubscription();
    const project = await createTenderProject({ postedBy: poster });
    const { user: contractorUser } = await createEligibleContractor();
    const token = generateToken(contractorUser);

    await request(app)
      .post(`/api/tender-projects/${project.id}/bids`)
      .set("Authorization", `Bearer ${token}`)
      .field("data", JSON.stringify({ amount: 5000, proposal: "Original" }));

    const withdrawn = await request(app)
      .patch(`/api/tender-projects/${project.id}/bids/mine/withdraw`)
      .set("Authorization", `Bearer ${token}`);

    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.status).toBe("withdrawn");

    const projectAfter = await request(app)
      .get(`/api/tender-projects/${project.id}`)
      .set("Authorization", `Bearer ${generateToken(poster)}`);
    expect(projectAfter.body.bidCount).toBe(0);
  });
});

describe("PATCH /api/tender-projects/:id/award", () => {
  it("accepts the chosen bid, rejects every other pending bid, and spins up a Job", async () => {
    const poster = await createUserWithActiveSubscription();
    const project = await createTenderProject({ postedBy: poster });
    const { user: winnerUser, profile: winnerProfile } = await createEligibleContractor();
    const { user: loserUser, profile: loserProfile } = await createEligibleContractor();

    const winningBid = await createBid({ project, contractor: winnerProfile, bidder: winnerUser, amount: 6000 });
    const losingBid = await createBid({ project, contractor: loserProfile, bidder: loserUser, amount: 5500 });

    const res = await request(app)
      .patch(`/api/tender-projects/${project.id}/award`)
      .set("Authorization", `Bearer ${generateToken(poster)}`)
      .send({ bidId: winningBid.id });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("awarded");
    expect(res.body.awardedBid).toBe(winningBid.id);
    expect(res.body.job).toBeTruthy();
    expect(res.body.job.totalAmount).toBe(6000);
    expect(res.body.job.client.userId).toBe(poster.id);
    expect(res.body.job.provider.userId).toBe(winnerUser.id);
    expect(res.body.job.client.isConfirmed).toBe(true);
    expect(res.body.job.provider.isConfirmed).toBe(false);
    expect(res.body.job.jobType).toBe("tenders");

    expect((await Bid.findById(winningBid.id))?.status).toBe("accepted");
    expect((await Bid.findById(losingBid.id))?.status).toBe("rejected");

    const job = await Job.findById(res.body.job._id);
    expect(job).toBeTruthy();
  });

  it("blocks awarding on a non-open project", async () => {
    const poster = await createUserWithActiveSubscription();
    const project = await createTenderProject({ postedBy: poster, status: "cancelled" });
    const { user: contractorUser, profile } = await createEligibleContractor();
    const bid = await createBid({ project, contractor: profile, bidder: contractorUser });

    const res = await request(app)
      .patch(`/api/tender-projects/${project.id}/award`)
      .set("Authorization", `Bearer ${generateToken(poster)}`)
      .send({ bidId: bid.id });

    expect(res.status).toBe(400);
  });

  it("blocks a non-poster from awarding", async () => {
    const poster = await createUserWithActiveSubscription();
    const project = await createTenderProject({ postedBy: poster });
    const { user: contractorUser, profile } = await createEligibleContractor();
    const bid = await createBid({ project, contractor: profile, bidder: contractorUser });
    const stranger = await createUser();

    const res = await request(app)
      .patch(`/api/tender-projects/${project.id}/award`)
      .set("Authorization", `Bearer ${generateToken(stranger)}`)
      .send({ bidId: bid.id });

    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/tender-projects/:id/cancel", () => {
  it("cancels an open project and rejects every pending bid", async () => {
    const poster = await createUserWithActiveSubscription();
    const project = await createTenderProject({ postedBy: poster });
    const { user: contractorUser, profile } = await createEligibleContractor();
    const bid = await createBid({ project, contractor: profile, bidder: contractorUser });

    const res = await request(app)
      .patch(`/api/tender-projects/${project.id}/cancel`)
      .set("Authorization", `Bearer ${generateToken(poster)}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
    expect((await Bid.findById(bid.id))?.status).toBe("rejected");
  });
});

describe("GET /api/tender-projects/me and /bids/mine", () => {
  it("lists only my own posted projects", async () => {
    const poster = await createUserWithActiveSubscription();
    await createTenderProject({ postedBy: poster });
    const other = await createUserWithActiveSubscription();
    await createTenderProject({ postedBy: other });

    const res = await request(app)
      .get("/api/tender-projects/me")
      .set("Authorization", `Bearer ${generateToken(poster)}`);

    expect(res.body.data).toHaveLength(1);
  });

  it("lists only my own bids, across every project", async () => {
    const poster = await createUserWithActiveSubscription();
    const projectA = await createTenderProject({ postedBy: poster });
    const projectB = await createTenderProject({ postedBy: poster });
    const { user: contractorUser, profile } = await createEligibleContractor();
    await createBid({ project: projectA, contractor: profile, bidder: contractorUser });
    await createBid({ project: projectB, contractor: profile, bidder: contractorUser });

    const res = await request(app)
      .get("/api/tender-projects/bids/mine")
      .set("Authorization", `Bearer ${generateToken(contractorUser)}`);

    expect(res.body.data).toHaveLength(2);
  });
});
