import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import { createUser, createAdmin, generateToken, TEST_PNG_BUFFER } from "../setup/fixtures";
import { Contact } from "../../src/models/contactModel";
import { FileGrant } from "../../src/models/fileGrantModel";
import { Payment } from "../../src/models/paymentModel";
import { IUser } from "../../src/models/userModel";

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

const createJobAs = (
  creatorToken: string,
  body: Record<string, unknown>,
) => request(app).post("/api/jobs").set("Authorization", `Bearer ${creatorToken}`).send(body);

// Creates + confirms a job in one go, returning it (status: active, one
// implicit 100%-payment stage unless `stages` is passed).
const createActiveJob = async (
  client: IUser,
  provider: IUser,
  overrides: Record<string, unknown> = {},
) => {
  const clientToken = generateToken(client);
  const providerToken = generateToken(provider);

  const created = await createJobAs(clientToken, {
    counterpartyUserId: provider.id,
    myRole: "client",
    jobTitle: "Build a fence",
    jobDescription: "Wooden fence around the back yard",
    totalAmount: 1000,
    ...overrides,
  });

  const confirmed = await request(app)
    .patch(`/api/jobs/${created.body._id}/confirm`)
    .set("Authorization", `Bearer ${providerToken}`);

  return confirmed.body;
};

describe("POST /api/jobs", () => {
  it("requires authentication", async () => {
    const res = await request(app).post("/api/jobs").send({});
    expect(res.status).toBe(401);
  });

  it("creates a job, auto-confirming the creator's own side, and connects the two as contacts", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();

    const res = await createJobAs(generateToken(clientUser), {
      counterpartyUserId: providerUser.id,
      myRole: "client",
      jobTitle: "Build a fence",
      jobDescription: "Wooden fence around the back yard",
      totalAmount: 1000,
    });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending_confirmation");
    expect(res.body.client.userId).toBe(clientUser.id);
    expect(res.body.client.isConfirmed).toBe(true);
    expect(res.body.provider.userId).toBe(providerUser.id);
    expect(res.body.provider.isConfirmed).toBe(false);
    expect(res.body.stages).toHaveLength(1);
    expect(res.body.stages[0].payment).toBe(100);

    const clientContacts = await Contact.findOne({ userId: clientUser._id });
    expect(clientContacts?.list.map((e) => e.user.toString())).toEqual([providerUser.id]);
  });

  it("lets the creator be the provider instead", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();

    const res = await createJobAs(generateToken(providerUser), {
      counterpartyUserId: clientUser.id,
      myRole: "provider",
      jobTitle: "Build a fence",
      jobDescription: "desc",
      totalAmount: 1000,
    });

    expect(res.status).toBe(201);
    expect(res.body.provider.userId).toBe(providerUser.id);
    expect(res.body.provider.isConfirmed).toBe(true);
    expect(res.body.client.isConfirmed).toBe(false);
  });

  it("rejects custom stages whose payments sum over 100", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();

    const res = await createJobAs(generateToken(clientUser), {
      counterpartyUserId: providerUser.id,
      myRole: "client",
      jobTitle: "t",
      jobDescription: "d",
      totalAmount: 1000,
      stages: [{ details: ["a"], payment: 60 }, { details: ["b"], payment: 60 }],
    });

    expect(res.status).toBe(400);
  });

  it("rejects creating a job with yourself", async () => {
    const clientUser = await createUser();

    const res = await createJobAs(generateToken(clientUser), {
      counterpartyUserId: clientUser.id,
      myRole: "client",
      jobTitle: "t",
      jobDescription: "d",
      totalAmount: 1000,
    });

    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/jobs/:id/confirm", () => {
  it("activates the job once the other party confirms", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();

    const created = await createJobAs(generateToken(clientUser), {
      counterpartyUserId: providerUser.id,
      myRole: "client",
      jobTitle: "t",
      jobDescription: "d",
      totalAmount: 1000,
    });

    const res = await request(app)
      .patch(`/api/jobs/${created.body._id}/confirm`)
      .set("Authorization", `Bearer ${generateToken(providerUser)}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("active");
    expect(res.body.provider.isConfirmed).toBe(true);
  });

  it("blocks a non-party from confirming", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const stranger = await createUser();

    const created = await createJobAs(generateToken(clientUser), {
      counterpartyUserId: providerUser.id,
      myRole: "client",
      jobTitle: "t",
      jobDescription: "d",
      totalAmount: 1000,
    });

    const res = await request(app)
      .patch(`/api/jobs/${created.body._id}/confirm`)
      .set("Authorization", `Bearer ${generateToken(stranger)}`);

    expect(res.status).toBe(403);
  });

  it("rejects confirming twice", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();

    const created = await createJobAs(generateToken(clientUser), {
      counterpartyUserId: providerUser.id,
      myRole: "client",
      jobTitle: "t",
      jobDescription: "d",
      totalAmount: 1000,
    });

    const providerToken = generateToken(providerUser);
    await request(app).patch(`/api/jobs/${created.body._id}/confirm`).set("Authorization", `Bearer ${providerToken}`);
    const res = await request(app)
      .patch(`/api/jobs/${created.body._id}/confirm`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/jobs/:id", () => {
  it("lets the creator edit while pending confirmation", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();

    const created = await createJobAs(generateToken(clientUser), {
      counterpartyUserId: providerUser.id,
      myRole: "client",
      jobTitle: "old title",
      jobDescription: "d",
      totalAmount: 1000,
    });

    const res = await request(app)
      .patch(`/api/jobs/${created.body._id}`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .send({ jobTitle: "new title", totalAmount: 2000 });

    expect(res.status).toBe(200);
    expect(res.body.jobTitle).toBe("new title");
    expect(res.body.totalAmount).toBe(2000);
  });

  it("blocks the non-creator from editing", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();

    const created = await createJobAs(generateToken(clientUser), {
      counterpartyUserId: providerUser.id,
      myRole: "client",
      jobTitle: "t",
      jobDescription: "d",
      totalAmount: 1000,
    });

    const res = await request(app)
      .patch(`/api/jobs/${created.body._id}`)
      .set("Authorization", `Bearer ${generateToken(providerUser)}`)
      .send({ jobTitle: "hijacked" });

    expect(res.status).toBe(403);
  });

  it("blocks editing once active", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const job = await createActiveJob(clientUser, providerUser);

    const res = await request(app)
      .patch(`/api/jobs/${job._id}`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .send({ jobTitle: "too late" });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/jobs/:id and /api/jobs/mine", () => {
  it("lets client, provider and admin view; blocks a stranger", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const admin = await createAdmin();
    const stranger = await createUser();
    const job = await createActiveJob(clientUser, providerUser);

    for (const user of [clientUser, providerUser, admin]) {
      const res = await request(app)
        .get(`/api/jobs/${job._id}`)
        .set("Authorization", `Bearer ${generateToken(user)}`);
      expect(res.status).toBe(200);
    }

    const blocked = await request(app)
      .get(`/api/jobs/${job._id}`)
      .set("Authorization", `Bearer ${generateToken(stranger)}`);
    expect(blocked.status).toBe(403);
  });

  it("lists jobs for both the client and the provider, filterable by status", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    await createActiveJob(clientUser, providerUser);

    const asClient = await request(app)
      .get("/api/jobs/mine?status=active")
      .set("Authorization", `Bearer ${generateToken(clientUser)}`);
    const asProvider = await request(app)
      .get("/api/jobs/mine")
      .set("Authorization", `Bearer ${generateToken(providerUser)}`);

    expect(asClient.body.data).toHaveLength(1);
    expect(asProvider.body.data).toHaveLength(1);
  });
});

describe("stage proposal flow", () => {
  it("lets either party propose, and only the other party accept", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const job = await createActiveJob(clientUser, providerUser);

    const proposed = await request(app)
      .post(`/api/jobs/${job._id}/stages/propose`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .send({ stages: [{ details: ["foundation"], payment: 50 }, { details: ["walls"], payment: 50 }] });
    expect(proposed.status).toBe(200);
    expect(proposed.body.proposedStages.stages).toHaveLength(2);

    const selfAccept = await request(app)
      .patch(`/api/jobs/${job._id}/stages/accept`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`);
    expect(selfAccept.status).toBe(400);

    const accepted = await request(app)
      .patch(`/api/jobs/${job._id}/stages/accept`)
      .set("Authorization", `Bearer ${generateToken(providerUser)}`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.stages).toHaveLength(2);
    expect(accepted.body.oldStages).toHaveLength(1); // the original single stage
    expect(accepted.body.proposedStages).toBeFalsy();
  });

  it("lets the other party reject a proposal", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const job = await createActiveJob(clientUser, providerUser);

    await request(app)
      .post(`/api/jobs/${job._id}/stages/propose`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .send({ stages: [{ details: ["x"], payment: 100 }] });

    const rejected = await request(app)
      .patch(`/api/jobs/${job._id}/stages/reject`)
      .set("Authorization", `Bearer ${generateToken(providerUser)}`);

    expect(rejected.status).toBe(200);
    expect(rejected.body.proposedStages).toBeFalsy();
    expect(rejected.body.stages).toHaveLength(1); // unchanged
  });
});

describe("stage done/verify and payment math", () => {
  it("requires isDone before isVerified, releases payment on verify, and completes the job on the last stage", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const job = await createActiveJob(clientUser, providerUser, {
      totalAmount: 1000,
      stages: [{ details: ["a"], payment: 40 }, { details: ["b"], payment: 60 }],
    });
    const stageA = job.stages[0]._id;
    const stageB = job.stages[1]._id;
    const clientToken = generateToken(clientUser);
    const providerToken = generateToken(providerUser);

    const tooEarly = await request(app)
      .patch(`/api/jobs/${job._id}/stages/${stageA}/verify`)
      .set("Authorization", `Bearer ${clientToken}`);
    expect(tooEarly.status).toBe(400);

    const wrongPerson = await request(app)
      .patch(`/api/jobs/${job._id}/stages/${stageA}/done`)
      .set("Authorization", `Bearer ${clientToken}`);
    expect(wrongPerson.status).toBe(403);

    await request(app).patch(`/api/jobs/${job._id}/stages/${stageA}/done`).set("Authorization", `Bearer ${providerToken}`);

    const verifyA = await request(app)
      .patch(`/api/jobs/${job._id}/stages/${stageA}/verify`)
      .set("Authorization", `Bearer ${clientToken}`);

    expect(verifyA.status).toBe(200);
    // 40% of 1000 = 400, minus PLATFORM_FEE_PERCENT (5% test default) = 380
    expect(verifyA.body.amountDisposed).toBeCloseTo(380);
    expect(verifyA.body.platformFeeCollected).toBeCloseTo(20);
    expect(verifyA.body.status).toBe("active"); // stage B still pending

    await request(app).patch(`/api/jobs/${job._id}/stages/${stageB}/done`).set("Authorization", `Bearer ${providerToken}`);
    const verifyB = await request(app)
      .patch(`/api/jobs/${job._id}/stages/${stageB}/verify`)
      .set("Authorization", `Bearer ${clientToken}`);

    expect(verifyB.body.status).toBe("completed");
    expect(verifyB.body.amountDisposed).toBeCloseTo(950); // 380 + (600 * 0.95)
    expect(verifyB.body.platformFeeCollected).toBeCloseTo(50);
  });
});

describe("POST /api/jobs/:id/contract", () => {
  it("uploads a private contract file and grants the other party access", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const job = await createActiveJob(clientUser, providerUser);

    const res = await request(app)
      .post(`/api/jobs/${job._id}/contract`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .attach("file", TEST_PNG_BUFFER, "contract.png");

    expect(res.status).toBe(201);
    const fileName = res.body.client.contractFile.fileName;
    expect(fileName).toEqual(expect.any(String));

    const grant = await FileGrant.findOne({ fileName });
    expect(grant?.ownerId.toString()).toBe(clientUser.id);
    expect(grant?.allowedUsers.map((id) => id.toString())).toEqual([providerUser.id]);

    // The provider (granted via that FileGrant) can mint a link for it...
    const link = await request(app)
      .get(`/api/files/private/${clientUser.id}/${fileName}/link`)
      .set("Authorization", `Bearer ${generateToken(providerUser)}`);
    expect(link.status).toBe(200);

    // ...and that signed link works with no Authorization header at all.
    const view = await request(app).get(new URL(link.body.requestUrl).pathname + new URL(link.body.requestUrl).search);
    expect(view.status).toBe(200);
  });

  it("blocks a non-party from uploading a contract", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const stranger = await createUser();
    const job = await createActiveJob(clientUser, providerUser);

    const res = await request(app)
      .post(`/api/jobs/${job._id}/contract`)
      .set("Authorization", `Bearer ${generateToken(stranger)}`)
      .attach("file", TEST_PNG_BUFFER, "contract.png");

    expect(res.status).toBe(403);
  });
});

describe("dispute flow", () => {
  it("lets a party raise a dispute and an admin resolve it", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const admin = await createAdmin();
    const job = await createActiveJob(clientUser, providerUser);

    const disputed = await request(app)
      .patch(`/api/jobs/${job._id}/dispute`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .send({ reason: "Work not as described" });

    expect(disputed.status).toBe(200);
    expect(disputed.body.status).toBe("disputed");
    expect(disputed.body.isDispute).toBe(true);

    const resolved = await request(app)
      .patch(`/api/jobs/${job._id}/dispute/resolve`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({ note: "Refunded stage 2 per agreement over email" });

    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe("active");
    expect(resolved.body.isDispute).toBe(false);
    expect(resolved.body.disputeHistory).toHaveLength(1);
    expect(resolved.body.disputeHistory[0].note).toBe(
      "Refunded stage 2 per agreement over email",
    );
  });

  it("requires a resolution note", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const admin = await createAdmin();
    const job = await createActiveJob(clientUser, providerUser);

    await request(app)
      .patch(`/api/jobs/${job._id}/dispute`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .send({ reason: "x" });

    const res = await request(app)
      .patch(`/api/jobs/${job._id}/dispute/resolve`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it("blocks a non-admin from resolving", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const job = await createActiveJob(clientUser, providerUser);

    await request(app)
      .patch(`/api/jobs/${job._id}/dispute`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .send({ reason: "x" });

    const res = await request(app)
      .patch(`/api/jobs/${job._id}/dispute/resolve`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`);

    expect(res.status).toBe(401);
  });
});

describe("GET /api/jobs/disputes", () => {
  it("lists only disputed jobs, with party emails populated, for an admin", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const admin = await createAdmin();
    const disputedJob = await createActiveJob(clientUser, providerUser);
    await createActiveJob(clientUser, providerUser); // not disputed — shouldn't show up

    await request(app)
      .patch(`/api/jobs/${disputedJob._id}/dispute`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .send({ reason: "Work not as described" });

    const res = await request(app)
      .get("/api/jobs/disputes")
      .set("Authorization", `Bearer ${generateToken(admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]._id).toBe(disputedJob._id);
    expect(res.body.data[0].client.userId.email).toBe(clientUser.email);
    expect(res.body.data[0].provider.userId.email).toBe(providerUser.email);
  });

  it("blocks a non-admin", async () => {
    const clientUser = await createUser();

    const res = await request(app)
      .get("/api/jobs/disputes")
      .set("Authorization", `Bearer ${generateToken(clientUser)}`);

    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/jobs/:id/cancel", () => {
  it("lets the creator cancel while pending confirmation", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();

    const created = await createJobAs(generateToken(clientUser), {
      counterpartyUserId: providerUser.id,
      myRole: "client",
      jobTitle: "t",
      jobDescription: "d",
      totalAmount: 1000,
    });

    const res = await request(app)
      .patch(`/api/jobs/${created.body._id}/cancel`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
  });

  it("blocks cancelling an already-active job", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const job = await createActiveJob(clientUser, providerUser);

    const res = await request(app)
      .patch(`/api/jobs/${job._id}/cancel`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`);

    expect(res.status).toBe(400);
  });
});

describe("POST /api/jobs/:id/payments", () => {
  it("lets an admin record a payment", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const admin = await createAdmin();
    const job = await createActiveJob(clientUser, providerUser);

    const res = await request(app)
      .post(`/api/jobs/${job._id}/payments`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({ amount: 500 });

    expect(res.status).toBe(200);
    expect(res.body.amountPaid).toBe(500);

    const payment = await Payment.findOne({ targetType: "Job", targetId: job._id });
    expect(payment?.amount).toBe(500);
    expect(payment?.user.toString()).toBe(clientUser.id);
    expect(payment?.provider).toBe("manual");
    expect(payment?.status).toBe("success");
    expect(payment?.recordedBy?.toString()).toBe(admin.id);
  });

  it("blocks a non-admin", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const job = await createActiveJob(clientUser, providerUser);

    const res = await request(app)
      .post(`/api/jobs/${job._id}/payments`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .send({ amount: 500 });

    expect(res.status).toBe(401);
  });
});
