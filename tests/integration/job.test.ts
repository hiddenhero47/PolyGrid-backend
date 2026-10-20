// Refund/payout approve/decline each send a notification email — mocked
// exactly like house-maduekwe-backend's own test suite mocks its
// emailSender, so no real Mailgun call is ever made here.
jest.mock("../../src/helpers/emailSender", () => ({
  sendTemplatedEmail: jest.fn().mockResolvedValue({}),
  loadTemplates: jest.fn().mockResolvedValue(undefined),
}));

import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import {
  createUser,
  createAdmin,
  createCustomerCare,
  generateToken,
  TEST_PNG_BUFFER,
  TEST_PDF_BUFFER,
  TEST_DOCX_BUFFER,
} from "../setup/fixtures";
import { Contact } from "../../src/models/contactModel";
import { Job } from "../../src/models/jobModel";
import { Payment } from "../../src/models/paymentModel";
import { SystemPayout, SYSTEM_PAYOUT_REQUEST_TYPE } from "../../src/models/systemPayoutModel";
import { IUser } from "../../src/models/userModel";
import { sendTemplatedEmail } from "../../src/helpers/emailSender";

const app = createApp();

beforeAll(async () => {
  await connectTestDB();
});

afterEach(async () => {
  await clearTestDB();
  jest.clearAllMocks();
});

afterAll(async () => {
  await disconnectTestDB();
});

const createJobAs = (
  creatorToken: string,
  body: Record<string, unknown>,
) => request(app).post("/api/jobs").set("Authorization", `Bearer ${creatorToken}`).send(body);

// approveRefundRequest/approvePayoutRequest refuse to approve without a
// payoutAccount on file for the beneficiary (nowhere to record a
// SystemPayout going) — this is a valid shape for any test that needs
// one set up to get past that check.
const TEST_PAYOUT_ACCOUNT = {
  accountName: "Test Beneficiary",
  accountNumber: "0123456789",
  bankName: "Test Bank",
  country: "NG",
};

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

  it("rejects a currency that isn't a real ISO 4217 code, as a clean 400 not a 500", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();

    const res = await createJobAs(generateToken(clientUser), {
      counterpartyUserId: providerUser.id,
      myRole: "client",
      jobTitle: "Build a fence",
      jobDescription: "Wooden fence around the back yard",
      totalAmount: 1000,
      currency: "NOT_REAL",
    });

    expect(res.status).toBe(400);
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
    expect(res.body.amountHistory).toHaveLength(1);
    expect(res.body.amountHistory[0].previousAmount).toBe(1000);
    expect(res.body.amountHistory[0].changedBy).toBe(clientUser.id);
  });

  it("does not record a price-history entry when totalAmount doesn't actually change", async () => {
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
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .send({ totalAmount: 1000 });

    expect(res.body.amountHistory).toHaveLength(0);
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

  it("getJob returns full detail with no contract files when none uploaded yet", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const job = await createActiveJob(clientUser, providerUser);

    const res = await request(app)
      .get(`/api/jobs/${job._id}`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`);

    expect(res.status).toBe(200);
    expect(res.body.stages).toHaveLength(1);
    expect(res.body.client.contractFile).toBeUndefined();
    expect(res.body.provider.contractFile).toBeUndefined();
  });

  it("lists jobs for both the client and the provider, filterable by status — as a trimmed summary, not the full job", async () => {
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

    const summary = asClient.body.data[0];
    expect(summary.jobTitle).toEqual(expect.any(String));
    expect(summary.status).toBe("active");
    expect(summary.client.userId).toBe(clientUser.id);
    expect(summary.provider.isConfirmed).toBe(true);
    expect(summary.stages).toBeUndefined();
    expect(summary.amountHistory).toBeUndefined();
    expect(summary.disputeHistory).toBeUndefined();
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

    const clientNotifications = await request(app)
      .get("/api/notifications")
      .set("Authorization", `Bearer ${clientToken}`);
    expect(clientNotifications.body.data).toHaveLength(1);
    expect(clientNotifications.body.data[0].type).toBe("job_stage_done");

    const verifyA = await request(app)
      .patch(`/api/jobs/${job._id}/stages/${stageA}/verify`)
      .set("Authorization", `Bearer ${clientToken}`);

    expect(verifyA.status).toBe(200);
    // 40% of 1000 = 400, minus PLATFORM_FEE_PERCENT (5% test default) = 380
    expect(verifyA.body.amountDisbursed).toBeCloseTo(380);
    expect(verifyA.body.platformFeeCollected).toBeCloseTo(20);
    expect(verifyA.body.status).toBe("active"); // stage B still pending

    await request(app).patch(`/api/jobs/${job._id}/stages/${stageB}/done`).set("Authorization", `Bearer ${providerToken}`);
    const verifyB = await request(app)
      .patch(`/api/jobs/${job._id}/stages/${stageB}/verify`)
      .set("Authorization", `Bearer ${clientToken}`);

    expect(verifyB.body.status).toBe("completed");
    expect(verifyB.body.amountDisbursed).toBeCloseTo(950); // 380 + (600 * 0.95)
    expect(verifyB.body.platformFeeCollected).toBeCloseTo(50);
  });
});

describe("POST /api/jobs/:id/contract", () => {
  it("uploads a private contract file — no FileGrant involved, getJob mints both parties' links directly", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const job = await createActiveJob(clientUser, providerUser);

    const res = await request(app)
      .post(`/api/jobs/${job._id}/contract`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .attach("file", TEST_PDF_BUFFER, "contract.pdf");

    expect(res.status).toBe(201);
    expect(res.body.client.contractFile.fileName).toEqual(expect.any(String));
    expect(res.body.client.contractFile.mime).toBe("application/pdf");

    const detail = await request(app)
      .get(`/api/jobs/${job._id}`)
      .set("Authorization", `Bearer ${generateToken(providerUser)}`);

    expect(detail.status).toBe(200);
    expect(detail.body.client.contractFile.requestUrl).toEqual(expect.any(String));
    expect(detail.body.client.contractFile.downloadUrl).toEqual(expect.any(String));

    // That signed link works with no Authorization header at all.
    const requestUrl = new URL(detail.body.client.contractFile.requestUrl);
    const view = await request(app).get(requestUrl.pathname + requestUrl.search);
    expect(view.status).toBe(200);
  });

  it("accepts a .docx contract too", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const job = await createActiveJob(clientUser, providerUser);

    const res = await request(app)
      .post(`/api/jobs/${job._id}/contract`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .attach("file", TEST_DOCX_BUFFER, "contract.docx");

    expect(res.status).toBe(201);
    expect(res.body.client.contractFile.mime).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("rejects a contract that isn't a pdf or docx", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const job = await createActiveJob(clientUser, providerUser);

    const res = await request(app)
      .post(`/api/jobs/${job._id}/contract`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .attach("file", TEST_PNG_BUFFER, "contract.png");

    expect(res.status).toBe(400);
  });

  it("rejects more than one attached file, saving none of them", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const job = await createActiveJob(clientUser, providerUser);

    const res = await request(app)
      .post(`/api/jobs/${job._id}/contract`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .attach("file", TEST_PDF_BUFFER, "contract-1.pdf")
      .attach("file2", TEST_PDF_BUFFER, "contract-2.pdf");

    expect(res.status).toBe(400);

    const after = await Job.findById(job._id);
    expect(after?.client.contractFile).toBeFalsy();
  });

  it("blocks a non-party from uploading a contract", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const stranger = await createUser();
    const job = await createActiveJob(clientUser, providerUser);

    const res = await request(app)
      .post(`/api/jobs/${job._id}/contract`)
      .set("Authorization", `Bearer ${generateToken(stranger)}`)
      .attach("file", TEST_PDF_BUFFER, "contract.pdf");

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

    const clientNotifications = await request(app)
      .get("/api/notifications")
      .set("Authorization", `Bearer ${generateToken(clientUser)}`);
    expect(clientNotifications.body.data[0].type).toBe("job_dispute_resolved");

    const providerNotifications = await request(app)
      .get("/api/notifications")
      .set("Authorization", `Bearer ${generateToken(providerUser)}`);
    expect(providerNotifications.body.data[0].type).toBe("job_dispute_resolved");
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

  it("lets customer_care view the queue but not resolve a dispute", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const customerCare = await createCustomerCare();
    const disputedJob = await createActiveJob(clientUser, providerUser);

    await request(app)
      .patch(`/api/jobs/${disputedJob._id}/dispute`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .send({ reason: "Work not as described" });

    const list = await request(app)
      .get("/api/jobs/disputes")
      .set("Authorization", `Bearer ${generateToken(customerCare)}`);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);

    const resolve = await request(app)
      .patch(`/api/jobs/${disputedJob._id}/dispute/resolve`)
      .set("Authorization", `Bearer ${generateToken(customerCare)}`)
      .send({ note: "Refunded per agreement" });
    expect(resolve.status).toBe(401);
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

describe("GET /api/jobs/:id/payments", () => {
  it("lists every payment made toward the job, for admin and customer_care", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const admin = await createAdmin();
    const customerCare = await createCustomerCare();
    const job = await createActiveJob(clientUser, providerUser);

    await request(app)
      .post(`/api/jobs/${job._id}/payments`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({ amount: 300 });
    await request(app)
      .post(`/api/jobs/${job._id}/payments`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({ amount: 200 });

    for (const viewer of [admin, customerCare]) {
      const res = await request(app)
        .get(`/api/jobs/${job._id}/payments`)
        .set("Authorization", `Bearer ${generateToken(viewer)}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body.map((p: { amount: number }) => p.amount).sort()).toEqual([200, 300]);
    }
  });

  it("blocks a non-admin, non-customer_care caller", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const job = await createActiveJob(clientUser, providerUser);

    const res = await request(app)
      .get(`/api/jobs/${job._id}/payments`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`);

    expect(res.status).toBe(401);
  });

  it("404s for an unknown job", async () => {
    const admin = await createAdmin();

    const res = await request(app)
      .get("/api/jobs/507f1f77bcf86cd799439011/payments")
      .set("Authorization", `Bearer ${generateToken(admin)}`);

    expect(res.status).toBe(404);
  });
});

describe("POST /api/jobs/:id/refund-requests", () => {
  it("blocks anyone other than the job's client", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const stranger = await createUser();
    const job = await createActiveJob(clientUser, providerUser);

    const asProvider = await request(app)
      .post(`/api/jobs/${job._id}/refund-requests`)
      .set("Authorization", `Bearer ${generateToken(providerUser)}`)
      .send({ reason: "x" });
    expect(asProvider.status).toBe(403);

    const asStranger = await request(app)
      .post(`/api/jobs/${job._id}/refund-requests`)
      .set("Authorization", `Bearer ${generateToken(stranger)}`)
      .send({ reason: "x" });
    expect(asStranger.status).toBe(403);
  });

  it("requires a reason", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const job = await createActiveJob(clientUser, providerUser);

    const res = await request(app)
      .post(`/api/jobs/${job._id}/refund-requests`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .send({});

    expect(res.status).toBe(400);
  });

  // There's no amount field at all anymore — PolyGrid computes exactly
  // what's refundable itself, excluding whatever's already been
  // disbursed to the provider (and the fee collected on it), never a
  // caller-supplied number.
  it("computes the refundable amount itself, excluding anything already disbursed to the provider", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const admin = await createAdmin();
    const job = await createActiveJob(clientUser, providerUser, {
      totalAmount: 1000,
      stages: [{ details: ["a"], payment: 40 }, { details: ["b"], payment: 60 }],
    });
    const stageA = job.stages[0]._id;

    await request(app)
      .post(`/api/jobs/${job._id}/payments`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({ amount: 1000 });

    // 40% of 1000 = 400, minus the 5% test-default fee = 380 disbursed —
    // that share must not be reclaimable.
    await request(app)
      .patch(`/api/jobs/${job._id}/stages/${stageA}/done`)
      .set("Authorization", `Bearer ${generateToken(providerUser)}`);
    await request(app)
      .patch(`/api/jobs/${job._id}/stages/${stageA}/verify`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`);

    const res = await request(app)
      .post(`/api/jobs/${job._id}/refund-requests`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .send({ reason: "overpaid correction" });

    expect(res.status).toBe(201);
    // 1000 paid - 380 disbursed - 20 fee collected = 600 still in escrow.
    expect(res.body.refunds[0].amount).toBeCloseTo(600);
  });

  it("rejects when there's nothing left to refund (everything already disbursed)", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const admin = await createAdmin();
    const job = await createActiveJob(clientUser, providerUser, { totalAmount: 1000 });
    const stageId = job.stages[0]._id;

    await request(app)
      .post(`/api/jobs/${job._id}/payments`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({ amount: 1000 });

    await request(app)
      .patch(`/api/jobs/${job._id}/stages/${stageId}/done`)
      .set("Authorization", `Bearer ${generateToken(providerUser)}`);
    await request(app)
      .patch(`/api/jobs/${job._id}/stages/${stageId}/verify`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`);

    const res = await request(app)
      .post(`/api/jobs/${job._id}/refund-requests`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .send({ reason: "nothing to refund" });

    expect(res.status).toBe(400);
  });

  it("blocks a second pending request while one is already pending", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const admin = await createAdmin();
    const job = await createActiveJob(clientUser, providerUser);
    const clientToken = generateToken(clientUser);

    await request(app)
      .post(`/api/jobs/${job._id}/payments`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({ amount: 500 });

    await request(app)
      .post(`/api/jobs/${job._id}/refund-requests`)
      .set("Authorization", `Bearer ${clientToken}`)
      .send({ reason: "first" });

    const res = await request(app)
      .post(`/api/jobs/${job._id}/refund-requests`)
      .set("Authorization", `Bearer ${clientToken}`)
      .send({ reason: "second" });

    expect(res.status).toBe(400);
  });

  it("doesn't touch the job's balance or status until approved", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const admin = await createAdmin();
    const job = await createActiveJob(clientUser, providerUser);

    await request(app)
      .post(`/api/jobs/${job._id}/payments`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({ amount: 500 });

    const res = await request(app)
      .post(`/api/jobs/${job._id}/refund-requests`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .send({ reason: "client cancelled" });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("active");
    expect(res.body.totalRefunded).toBe(0);
    expect(res.body.refunds).toHaveLength(1);
    expect(res.body.refunds[0].status).toBe("pending");
    expect(res.body.refunds[0].amount).toBe(500);
    expect(res.body.refunds[0].requestedBy).toBe(clientUser.id);
  });
});

describe("GET /api/jobs/refund-requests + approve/decline", () => {
  it("lists pending refund requests for admin/customer_care, blocks everyone else", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const admin = await createAdmin();
    const customerCare = await createCustomerCare();
    const job = await createActiveJob(clientUser, providerUser);

    await request(app)
      .post(`/api/jobs/${job._id}/payments`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({ amount: 500 });
    await request(app)
      .post(`/api/jobs/${job._id}/refund-requests`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .send({ reason: "client cancelled" });

    for (const viewer of [admin, customerCare]) {
      const res = await request(app)
        .get("/api/jobs/refund-requests")
        .set("Authorization", `Bearer ${generateToken(viewer)}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].jobId).toBe(job._id);
      expect(res.body.data[0].refund.status).toBe("pending");
    }

    const blocked = await request(app)
      .get("/api/jobs/refund-requests")
      .set("Authorization", `Bearer ${generateToken(clientUser)}`);
    expect(blocked.status).toBe(401);
  });

  it("refuses to approve when the client has no payout account on file", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const admin = await createAdmin();
    const job = await createActiveJob(clientUser, providerUser);
    const adminToken = generateToken(admin);

    await request(app)
      .post(`/api/jobs/${job._id}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amount: 500 });
    const requested = await request(app)
      .post(`/api/jobs/${job._id}/refund-requests`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .send({ reason: "client cancelled" });
    const refundId = requested.body.refunds[0]._id;

    const res = await request(app)
      .patch(`/api/jobs/${job._id}/refund-requests/${refundId}/approve`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
  });

  it("approving closes the job, moves totalRefunded, and records a SystemPayout; a later correction appends without re-closing", async () => {
    const clientUser = await createUser({ payoutAccount: TEST_PAYOUT_ACCOUNT });
    const providerUser = await createUser();
    const admin = await createAdmin();
    const job = await createActiveJob(clientUser, providerUser);
    const adminToken = generateToken(admin);

    await request(app)
      .post(`/api/jobs/${job._id}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amount: 500 });
    const requested = await request(app)
      .post(`/api/jobs/${job._id}/refund-requests`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .send({ reason: "client cancelled" });
    const refundId = requested.body.refunds[0]._id;

    const approved = await request(app)
      .patch(`/api/jobs/${job._id}/refund-requests/${refundId}/approve`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("closed");
    expect(approved.body.totalRefunded).toBe(500);
    expect(approved.body.refunds[0].status).toBe("approved");
    expect(approved.body.refunds[0].decidedBy).toBe(admin.id);
    const closedAt = approved.body.closedAt;
    expect(closedAt).toBeTruthy();
    expect(sendTemplatedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: clientUser.email,
        template: "paymentRequestDecision",
        variables: expect.objectContaining({ requestType: "refund", approved: true, amount: 500 }),
      }),
    );

    const clientNotifications = await request(app)
      .get("/api/notifications")
      .set("Authorization", `Bearer ${generateToken(clientUser)}`);
    expect(clientNotifications.body.data[0].type).toBe("payment_request_decided");

    const systemPayout = await SystemPayout.findOne({ requestId: refundId });
    expect(systemPayout?.requestType).toBe(SYSTEM_PAYOUT_REQUEST_TYPE.REFUND);
    expect(systemPayout?.user.toString()).toBe(clientUser.id);
    expect(systemPayout?.amount).toBe(500);
    expect(systemPayout?.status).toBe("pending");
    expect(systemPayout?.payoutAccount.accountNumber).toBe(TEST_PAYOUT_ACCOUNT.accountNumber);

    // A second, corrective request on an already-closed job — approving
    // it should append, not fail or re-close/move closedAt.
    await request(app)
      .post(`/api/jobs/${job._id}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amount: 200 });
    const secondRequest = await request(app)
      .post(`/api/jobs/${job._id}/refund-requests`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .send({ reason: "found an extra duplicate payment" });
    const secondRefundId = secondRequest.body.refunds[1]._id;

    const secondApproved = await request(app)
      .patch(`/api/jobs/${job._id}/refund-requests/${secondRefundId}/approve`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(secondApproved.status).toBe(200);
    expect(secondApproved.body.status).toBe("closed");
    expect(secondApproved.body.totalRefunded).toBe(700);
    expect(secondApproved.body.refunds).toHaveLength(2);
    expect(secondApproved.body.closedAt).toBe(closedAt);
    expect(await SystemPayout.countDocuments({ targetId: job._id })).toBe(2);
  });

  it("declining requires a reason and leaves the job untouched", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const admin = await createAdmin();
    const job = await createActiveJob(clientUser, providerUser);
    const adminToken = generateToken(admin);

    await request(app)
      .post(`/api/jobs/${job._id}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amount: 500 });
    const requested = await request(app)
      .post(`/api/jobs/${job._id}/refund-requests`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .send({ reason: "client cancelled" });
    const refundId = requested.body.refunds[0]._id;

    const missingReason = await request(app)
      .patch(`/api/jobs/${job._id}/refund-requests/${refundId}/decline`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(missingReason.status).toBe(400);

    const declined = await request(app)
      .patch(`/api/jobs/${job._id}/refund-requests/${refundId}/decline`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ declineReason: "dispute not raised, work was completed" });

    expect(declined.status).toBe(200);
    expect(declined.body.status).toBe("active"); // never closed
    expect(declined.body.totalRefunded).toBe(0);
    expect(declined.body.refunds[0].status).toBe("declined");
    expect(declined.body.refunds[0].declineReason).toBe(
      "dispute not raised, work was completed",
    );
    expect(sendTemplatedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: clientUser.email,
        template: "paymentRequestDecision",
        variables: expect.objectContaining({
          requestType: "refund",
          approved: false,
          declineReason: "dispute not raised, work was completed",
        }),
      }),
    );
  });
});

describe("POST /api/jobs/:id/payout-requests", () => {
  it("blocks anyone other than the job's provider", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const job = await createActiveJob(clientUser, providerUser);

    const res = await request(app)
      .post(`/api/jobs/${job._id}/payout-requests`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`);

    expect(res.status).toBe(403);
  });

  it("blocks a request when nothing has been released from escrow yet", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const job = await createActiveJob(clientUser, providerUser);

    const res = await request(app)
      .post(`/api/jobs/${job._id}/payout-requests`)
      .set("Authorization", `Bearer ${generateToken(providerUser)}`);

    expect(res.status).toBe(400);
  });

  it("blocks a second pending request while one is already pending", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const admin = await createAdmin();
    const job = await createActiveJob(clientUser, providerUser);
    const clientToken = generateToken(clientUser);
    const providerToken = generateToken(providerUser);

    await request(app)
      .post(`/api/jobs/${job._id}/payments`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({ amount: 1000 });
    await request(app).patch(`/api/jobs/${job._id}/stages/${job.stages[0]._id}/done`).set("Authorization", `Bearer ${providerToken}`);
    await request(app).patch(`/api/jobs/${job._id}/stages/${job.stages[0]._id}/verify`).set("Authorization", `Bearer ${clientToken}`);

    await request(app)
      .post(`/api/jobs/${job._id}/payout-requests`)
      .set("Authorization", `Bearer ${providerToken}`);

    const res = await request(app)
      .post(`/api/jobs/${job._id}/payout-requests`)
      .set("Authorization", `Bearer ${providerToken}`);

    expect(res.status).toBe(400);
  });

  it("blocks a request on a disputed, cancelled, or closed job", async () => {
    const clientUser = await createUser({ payoutAccount: TEST_PAYOUT_ACCOUNT });
    const providerUser = await createUser();
    const admin = await createAdmin();
    const job = await createActiveJob(clientUser, providerUser);

    await request(app)
      .patch(`/api/jobs/${job._id}/dispute`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .send({ reason: "x" });

    const disputed = await request(app)
      .post(`/api/jobs/${job._id}/payout-requests`)
      .set("Authorization", `Bearer ${generateToken(providerUser)}`);
    expect(disputed.status).toBe(400);

    const created = await createJobAs(generateToken(clientUser), {
      counterpartyUserId: providerUser.id,
      myRole: "client",
      jobTitle: "t",
      jobDescription: "d",
      totalAmount: 1000,
    });
    await request(app)
      .patch(`/api/jobs/${created.body._id}/cancel`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`);

    const cancelled = await request(app)
      .post(`/api/jobs/${created.body._id}/payout-requests`)
      .set("Authorization", `Bearer ${generateToken(providerUser)}`);
    expect(cancelled.status).toBe(400);

    const closedJob = await createActiveJob(clientUser, providerUser);
    await request(app)
      .post(`/api/jobs/${closedJob._id}/payments`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({ amount: 500 });
    const refundReq = await request(app)
      .post(`/api/jobs/${closedJob._id}/refund-requests`)
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .send({ reason: "cancelled by agreement" });
    await request(app)
      .patch(`/api/jobs/${closedJob._id}/refund-requests/${refundReq.body.refunds[0]._id}/approve`)
      .set("Authorization", `Bearer ${generateToken(admin)}`);

    const closed = await request(app)
      .post(`/api/jobs/${closedJob._id}/payout-requests`)
      .set("Authorization", `Bearer ${generateToken(providerUser)}`);
    expect(closed.status).toBe(400);
  });
});

describe("GET /api/jobs/payout-requests + approve/decline", () => {
  it("approving pays out exactly what's available (capped by whichever of amountPaid/amountDisbursed is smaller), across multiple stages, and records a SystemPayout each time", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser({ payoutAccount: TEST_PAYOUT_ACCOUNT });
    const admin = await createAdmin();
    const job = await createActiveJob(clientUser, providerUser, {
      totalAmount: 1000,
      stages: [{ details: ["a"], payment: 40 }, { details: ["b"], payment: 60 }],
    });
    const clientToken = generateToken(clientUser);
    const providerToken = generateToken(providerUser);
    const adminToken = generateToken(admin);

    await request(app)
      .post(`/api/jobs/${job._id}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amount: 1000 });

    await request(app).patch(`/api/jobs/${job._id}/stages/${job.stages[0]._id}/done`).set("Authorization", `Bearer ${providerToken}`);
    await request(app).patch(`/api/jobs/${job._id}/stages/${job.stages[0]._id}/verify`).set("Authorization", `Bearer ${clientToken}`);
    // amountDisbursed is now 380 (40% of 1000, minus the 5% test platform fee)

    const firstRequest = await request(app)
      .post(`/api/jobs/${job._id}/payout-requests`)
      .set("Authorization", `Bearer ${providerToken}`);
    expect(firstRequest.status).toBe(201);

    const queue = await request(app)
      .get("/api/jobs/payout-requests")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(queue.body.data).toHaveLength(1);
    const firstPayoutId = queue.body.data[0].payout._id;

    const firstApproved = await request(app)
      .patch(`/api/jobs/${job._id}/payout-requests/${firstPayoutId}/approve`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(firstApproved.status).toBe(200);
    expect(firstApproved.body.payouts).toHaveLength(1);
    expect(firstApproved.body.payouts[0].amount).toBeCloseTo(380);
    expect(firstApproved.body.payouts[0].status).toBe("approved");
    expect(firstApproved.body.amountPaidOut).toBeCloseTo(380);
    expect(sendTemplatedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: providerUser.email,
        template: "paymentRequestDecision",
        variables: expect.objectContaining({ requestType: "payout", approved: true }),
      }),
    );

    const firstSystemPayout = await SystemPayout.findOne({ requestId: firstPayoutId });
    expect(firstSystemPayout?.requestType).toBe(SYSTEM_PAYOUT_REQUEST_TYPE.PAYOUT);
    expect(firstSystemPayout?.user.toString()).toBe(providerUser.id);
    expect(firstSystemPayout?.amount).toBeCloseTo(380);
    expect(firstSystemPayout?.payoutAccount.accountNumber).toBe(TEST_PAYOUT_ACCOUNT.accountNumber);

    const nothingLeft = await request(app)
      .post(`/api/jobs/${job._id}/payout-requests`)
      .set("Authorization", `Bearer ${providerToken}`);
    expect(nothingLeft.status).toBe(400);

    await request(app).patch(`/api/jobs/${job._id}/stages/${job.stages[1]._id}/done`).set("Authorization", `Bearer ${providerToken}`);
    await request(app).patch(`/api/jobs/${job._id}/stages/${job.stages[1]._id}/verify`).set("Authorization", `Bearer ${clientToken}`);
    // amountDisbursed is now 950 (380 + 60% of 1000 minus fee)

    const secondRequest = await request(app)
      .post(`/api/jobs/${job._id}/payout-requests`)
      .set("Authorization", `Bearer ${providerToken}`)
      .send({ note: "please wire to my bank" });
    expect(secondRequest.status).toBe(201);
    const secondPayoutId = secondRequest.body.payouts[1]._id;

    const secondApproved = await request(app)
      .patch(`/api/jobs/${job._id}/payout-requests/${secondPayoutId}/approve`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(secondApproved.status).toBe(200);
    expect(secondApproved.body.payouts[1].note).toBe("please wire to my bank");
    expect(secondApproved.body.amountPaidOut).toBeCloseTo(950);
    expect(await SystemPayout.countDocuments({ targetId: job._id })).toBe(2);
  });

  it("declining requires a reason and leaves amountPaidOut untouched", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const admin = await createAdmin();
    const job = await createActiveJob(clientUser, providerUser);
    const adminToken = generateToken(admin);
    const providerToken = generateToken(providerUser);

    await request(app)
      .post(`/api/jobs/${job._id}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amount: 1000 });
    await request(app).patch(`/api/jobs/${job._id}/stages/${job.stages[0]._id}/done`).set("Authorization", `Bearer ${providerToken}`);
    await request(app).patch(`/api/jobs/${job._id}/stages/${job.stages[0]._id}/verify`).set("Authorization", `Bearer ${generateToken(clientUser)}`);

    const requested = await request(app)
      .post(`/api/jobs/${job._id}/payout-requests`)
      .set("Authorization", `Bearer ${providerToken}`);
    const payoutId = requested.body.payouts[0]._id;

    const missingReason = await request(app)
      .patch(`/api/jobs/${job._id}/payout-requests/${payoutId}/decline`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(missingReason.status).toBe(400);

    const declined = await request(app)
      .patch(`/api/jobs/${job._id}/payout-requests/${payoutId}/decline`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ declineReason: "wrong bank details on file" });

    expect(declined.status).toBe(200);
    expect(declined.body.amountPaidOut).toBe(0);
    expect(declined.body.payouts[0].status).toBe("declined");
    expect(declined.body.payouts[0].declineReason).toBe("wrong bank details on file");
    expect(sendTemplatedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: providerUser.email,
        template: "paymentRequestDecision",
        variables: expect.objectContaining({
          requestType: "payout",
          approved: false,
          // requestPayout computed this itself — the single implicit
          // 100% stage released 1000 minus the 5% test platform fee.
          amount: 950,
          declineReason: "wrong bank details on file",
        }),
      }),
    );
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
