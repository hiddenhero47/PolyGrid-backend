// Mocked exactly like house-maduekwe-backend's own test suite mocks its
// emailSender — no real Mailgun call is ever made here, and requestReset's
// (only) send is asserted against the mock directly below.
jest.mock("../../src/helpers/emailSender", () => ({
  sendTemplatedEmail: jest.fn().mockResolvedValue({}),
  loadTemplates: jest.fn().mockResolvedValue(undefined),
}));

import request from "supertest";
import { authenticator } from "otplib";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import { createUser, createAdmin, createSuperAdmin, generateToken, TEST_PNG_BUFFER } from "../setup/fixtures";
import { SYSTEM_ROLE, ACCOUNT_TYPE } from "../../src/models/userModel";
import { sendTemplatedEmail } from "../../src/helpers/emailSender";
import bcrypt from "bcryptjs";

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

describe("POST /api/users (register)", () => {
  it("registers a new user and returns a usable token", async () => {
    const res = await request(app)
      .post("/api/users")
      .send({ fullName: "Jane Doe", email: "jane@example.com", password: "password123" });

    expect(res.status).toBe(201);
    expect(res.body.systemRole).toBe(SYSTEM_ROLE.USER);
    expect(res.body.activeAccountType).toBe(ACCOUNT_TYPE.NORMAL);
    expect(res.body.token).toEqual(expect.any(String));

    const me = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${res.body.token}`);

    expect(me.status).toBe(200);
    expect(me.body.email).toBe("jane@example.com");
    expect(me.body.verified).toBe(false);
  });

  it("sends a verification email on register, without it overwriting the auth token", async () => {
    const res = await request(app)
      .post("/api/users")
      .send({ fullName: "Jane Doe", email: "verify-me@example.com", password: "password123" });

    expect(res.status).toBe(201);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.verifyEmailToken).toEqual(expect.any(String));
    expect(res.body.token).not.toBe(res.body.verifyEmailToken);
    expect(sendTemplatedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "verify-me@example.com", template: "verifyEmail" }),
    );

    // The auth token from registration still logs them in.
    const me = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
  });

  it("rejects a duplicate email", async () => {
    await createUser({ email: "dupe@example.com" });

    const res = await request(app)
      .post("/api/users")
      .send({ fullName: "Jane", email: "dupe@example.com", password: "password123" });

    expect(res.status).toBe(400);
  });

  it("rejects missing fields", async () => {
    const res = await request(app).post("/api/users").send({ email: "x@example.com" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/users/login", () => {
  it("logs in with correct credentials", async () => {
    const password = "password123";
    const user = await createUser({ password: await bcrypt.hash(password, 4) });

    const res = await request(app)
      .post("/api/users/login")
      .send({ email: user.email, password });

    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
  });

  it("rejects a wrong password", async () => {
    const user = await createUser();

    const res = await request(app)
      .post("/api/users/login")
      .send({ email: user.email, password: "wrong-password" });

    expect(res.status).toBe(400);
  });

  it("requires a 2FA code once it's enabled, and rejects a wrong one", async () => {
    const secret = authenticator.generateSecret();
    const password = "password123";
    const user = await createUser({
      password: await bcrypt.hash(password, 4),
      user2fa: { enable: true, secret },
    });

    const noToken = await request(app)
      .post("/api/users/login")
      .send({ email: user.email, password });
    expect(noToken.status).toBe(400);
    expect(noToken.body.code).toBe("2FA_REQUIRED");

    const wrongToken = await request(app)
      .post("/api/users/login")
      .send({ email: user.email, password, token: "000000" });
    expect(wrongToken.status).toBe(400);
    expect(wrongToken.body.code).toBe("2FA_INVALID");

    const res = await request(app)
      .post("/api/users/login")
      .send({ email: user.email, password, token: authenticator.generate(secret) });
    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
  });
});

// Google/Apple OAuth login itself isn't covered here — verifying a real
// idToken/identityToken means either calling the real provider or mocking
// their SDKs deeply enough that a pass wouldn't give much confidence it
// matches real behavior (same call house-maduekwe-backend's own test suite
// makes, see its tests/README.md). What's cheaply and safely testable
// without touching a third party — basic input validation — is covered
// instead.
describe("POST /api/users/social/google", () => {
  it("requires an idToken", async () => {
    const res = await request(app).post("/api/users/social/google").send({});
    expect(res.status).toBe(400);
  });
});

describe("POST /api/users/social/apple", () => {
  it("requires an identityToken", async () => {
    const res = await request(app).post("/api/users/social/apple").send({});
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/users/profile", () => {
  it("updates fullName/phoneNumber", async () => {
    const user = await createUser();
    const token = generateToken(user);

    const res = await request(app)
      .put("/api/users/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({
        fullName: "New Name",
        phoneNumber: { number: "+2348012345678", country: "NG" },
      });

    expect(res.status).toBe(200);
    expect(res.body.user.fullName).toBe("New Name");
    expect(res.body.user.phoneNumber).toEqual({
      number: "+2348012345678",
      country: "NG",
    });
  });

  it("uploads a public avatar", async () => {
    const user = await createUser();

    const res = await request(app)
      .put("/api/users/profile")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .attach("file", TEST_PNG_BUFFER, "avatar.png");

    expect(res.status).toBe(200);
    expect(res.body.user.avatar.fileName).toEqual(expect.any(String));
    expect(res.body.user.avatar.url).toContain("/public/");
    expect(res.body.user.avatar.storagePath).toBeUndefined(); // internal only
  });

  it("does not fail the whole update when the attached file is invalid — it's one optional field among several", async () => {
    const user = await createUser();

    const res = await request(app)
      .put("/api/users/profile")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .field("fullName", "Still Updates")
      .attach("file", Buffer.from("not a real image"), "avatar.png");

    expect(res.status).toBe(200);
    expect(res.body.user.fullName).toBe("Still Updates");
    expect(res.body.user.avatar).toBeUndefined();
    expect(res.body.avatarWarnings).toEqual(expect.arrayContaining([expect.any(String)]));
  });

  it("deletes the previous avatar file when replaced", async () => {
    const user = await createUser();
    const token = generateToken(user);

    const first = await request(app)
      .put("/api/users/profile")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", TEST_PNG_BUFFER, "avatar.png");
    const firstUrl = first.body.user.avatar.url as string;
    const firstPath = new URL(firstUrl).pathname;

    const second = await request(app)
      .put("/api/users/profile")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", TEST_PNG_BUFFER, "avatar2.png");
    expect(second.status).toBe(200);

    const staleFetch = await request(app).get(firstPath);
    expect(staleFetch.status).toBe(404);
  });

  it("rejects a phoneNumber missing both number and country", async () => {
    const user = await createUser();
    const token = generateToken(user);

    const res = await request(app)
      .put("/api/users/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ phoneNumber: {} });

    expect(res.status).toBe(400);
  });

  it("rejects a phoneNumber.country that isn't a real ISO code (previously just checked it was 2 letters)", async () => {
    const user = await createUser();
    const token = generateToken(user);

    const res = await request(app)
      .put("/api/users/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ phoneNumber: { number: "+2348012345678", country: "ZZ" } });

    expect(res.status).toBe(400);
  });

  it("changes password and invalidates the old session", async () => {
    const password = "password123";
    const user = await createUser({ password: await bcrypt.hash(password, 4) });
    const token = generateToken(user);

    const res = await request(app)
      .put("/api/users/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ oldPassword: password, password: "newpassword456" });

    expect(res.status).toBe(200);

    // The token issued before the password change must now be rejected.
    const staleAttempt = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${token}`);
    expect(staleAttempt.status).toBe(401);

    const loginRes = await request(app)
      .post("/api/users/login")
      .send({ email: user.email, password: "newpassword456" });
    expect(loginRes.status).toBe(200);
  });

  it("rejects a password change without the correct old password", async () => {
    const user = await createUser();
    const token = generateToken(user);

    const res = await request(app)
      .put("/api/users/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ oldPassword: "wrong", password: "newpassword456" });

    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/users/account-type", () => {
  it("toggles between normal and business", async () => {
    const user = await createUser();
    const token = generateToken(user);

    const first = await request(app)
      .patch("/api/users/account-type")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(first.status).toBe(200);
    expect(first.body.activeAccountType).toBe(ACCOUNT_TYPE.BUSINESS);

    const second = await request(app)
      .patch("/api/users/account-type")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(second.body.activeAccountType).toBe(ACCOUNT_TYPE.NORMAL);
  });

  it("sets an explicit target type", async () => {
    const user = await createUser();
    const token = generateToken(user);

    const res = await request(app)
      .patch("/api/users/account-type")
      .set("Authorization", `Bearer ${token}`)
      .send({ activeAccountType: ACCOUNT_TYPE.BUSINESS });

    expect(res.body.activeAccountType).toBe(ACCOUNT_TYPE.BUSINESS);
  });
});

describe("2FA setup -> verify -> toggle", () => {
  it("requires the current password to start setup", async () => {
    const user = await createUser();
    const token = generateToken(user);

    const res = await request(app).post("/api/users/2fa/setup").set("Authorization", `Bearer ${token}`).send({});

    expect(res.status).toBe(400);
  });

  it("walks through generate -> verify -> enabled", async () => {
    const user = await createUser();
    const token = generateToken(user);

    const setup = await request(app)
      .post("/api/users/2fa/setup")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: "password123" });

    expect(setup.status).toBe(200);
    expect(setup.body.tempSecret).toEqual(expect.any(String));
    expect(setup.body.qrCodeDataURL).toEqual(expect.any(String));

    const wrongCode = await request(app)
      .post("/api/users/2fa/verify")
      .set("Authorization", `Bearer ${token}`)
      .send({ token: "000000" });
    expect(wrongCode.status).toBe(400);

    const verify = await request(app)
      .post("/api/users/2fa/verify")
      .set("Authorization", `Bearer ${token}`)
      .send({ token: authenticator.generate(setup.body.tempSecret) });

    expect(verify.status).toBe(200);
    expect(verify.body.user2fa.enable).toBe(true);

    const me = await request(app).get("/api/users/me").set("Authorization", `Bearer ${token}`);
    expect(me.body.user2fa.enable).toBe(true);
  });

  it("rejects verify before setup has ever run", async () => {
    const user = await createUser();
    const token = generateToken(user);

    const res = await request(app)
      .post("/api/users/2fa/verify")
      .set("Authorization", `Bearer ${token}`)
      .send({ token: "123456" });

    expect(res.status).toBe(400);
  });

  it("restarting setup while already enabled needs a valid code from the existing authenticator, not just the password", async () => {
    const secret = authenticator.generateSecret();
    const user = await createUser({ user2fa: { enable: true, secret } });
    const token = generateToken(user);

    const withPasswordOnly = await request(app)
      .post("/api/users/2fa/setup")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: "password123" });
    expect(withPasswordOnly.status).toBe(400);

    const withValidCode = await request(app)
      .post("/api/users/2fa/setup")
      .set("Authorization", `Bearer ${token}`)
      .send({ otpToken: authenticator.generate(secret) });
    expect(withValidCode.status).toBe(200);
  });

  it("toggle off requires it to already be enabled", async () => {
    const user = await createUser();
    const token = generateToken(user);

    const res = await request(app)
      .put("/api/users/2fa/toggle")
      .set("Authorization", `Bearer ${token}`)
      .send({ enable: false, currentPassword: "password123" });

    expect(res.status).toBe(400);
  });

  it("toggle off needs a valid code, then toggle on needs only the secret already confirmed by setup", async () => {
    const secret = authenticator.generateSecret();
    const user = await createUser({ user2fa: { enable: true, secret } });
    const token = generateToken(user);

    const wrongCode = await request(app)
      .put("/api/users/2fa/toggle")
      .set("Authorization", `Bearer ${token}`)
      .send({ enable: false, otpToken: "000000" });
    expect(wrongCode.status).toBe(403);

    const disabled = await request(app)
      .put("/api/users/2fa/toggle")
      .set("Authorization", `Bearer ${token}`)
      .send({ enable: false, otpToken: authenticator.generate(secret) });
    expect(disabled.status).toBe(200);
    expect(disabled.body.user2fa.enable).toBe(false);

    const reEnabled = await request(app)
      .put("/api/users/2fa/toggle")
      .set("Authorization", `Bearer ${token}`)
      .send({ enable: true, currentPassword: "password123" });
    expect(reEnabled.status).toBe(200);
    expect(reEnabled.body.user2fa.enable).toBe(true);
  });
});

describe("PUT /api/users/payout-account", () => {
  const payoutAccountPayload = {
    accountName: "Jane Doe",
    accountNumber: "0123456789",
    bankName: "Test Bank",
    country: "NG",
  };

  it("requires the current password when 2FA isn't enabled", async () => {
    const user = await createUser();
    const token = generateToken(user);

    const res = await request(app)
      .put("/api/users/payout-account")
      .set("Authorization", `Bearer ${token}`)
      .send(payoutAccountPayload);

    expect(res.status).toBe(400);
  });

  it("rejects an incorrect password", async () => {
    const user = await createUser();
    const token = generateToken(user);

    const res = await request(app)
      .put("/api/users/payout-account")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...payoutAccountPayload, currentPassword: "wrong-password" });

    expect(res.status).toBe(403);
  });

  it("sets the payout account once the current password checks out", async () => {
    const user = await createUser();
    const token = generateToken(user);

    const res = await request(app)
      .put("/api/users/payout-account")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...payoutAccountPayload, currentPassword: "password123" });

    expect(res.status).toBe(200);
    expect(res.body.payoutAccount.accountNumber).toBe("0123456789");

    const me = await request(app).get("/api/users/me").set("Authorization", `Bearer ${token}`);
    expect(me.body.payoutAccount.bankName).toBe("Test Bank");
  });

  it("takes a 2FA code instead of a password once 2FA is enabled", async () => {
    const secret = authenticator.generateSecret();
    const user = await createUser({ user2fa: { enable: true, secret } });
    const token = generateToken(user);

    const wrongCode = await request(app)
      .put("/api/users/payout-account")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...payoutAccountPayload, otpToken: "000000" });
    expect(wrongCode.status).toBe(403);

    const res = await request(app)
      .put("/api/users/payout-account")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...payoutAccountPayload, otpToken: authenticator.generate(secret) });

    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/users/invalidate", () => {
  it("logs out of every session", async () => {
    const user = await createUser();
    const token = generateToken(user);

    const res = await request(app)
      .patch("/api/users/invalidate")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const stale = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${token}`);
    expect(stale.status).toBe(401);
  });
});

describe("password reset flow", () => {
  it("requests a reset token then resets the password", async () => {
    const user = await createUser();

    const requestRes = await request(app)
      .post("/api/users/request-reset")
      .send({ email: user.email });
    expect(requestRes.status).toBe(200);
    expect(requestRes.body.token).toEqual(expect.any(String));
    expect(sendTemplatedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: user.email, template: "forgotPassword" }),
    );

    const resetRes = await request(app)
      .post("/api/users/reset-password")
      .send({ token: requestRes.body.token, password: "brandNewPassword1" });
    expect(resetRes.status).toBe(200);

    const loginRes = await request(app)
      .post("/api/users/login")
      .send({ email: user.email, password: "brandNewPassword1" });
    expect(loginRes.status).toBe(200);
  });

  it("does not reveal whether an account exists, and never emails a non-account", async () => {
    const res = await request(app)
      .post("/api/users/request-reset")
      .send({ email: "nobody@example.com" });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeUndefined();
    expect(sendTemplatedEmail).not.toHaveBeenCalled();
  });

  it("rejects an invalid reset token", async () => {
    const res = await request(app)
      .post("/api/users/reset-password")
      .send({ token: "not-a-real-token", password: "whatever123" });

    expect(res.status).toBe(400);
  });
});

describe("email verification flow", () => {
  it("verifies the email from the token registration already sent", async () => {
    const registerRes = await request(app)
      .post("/api/users")
      .send({ fullName: "Jane Doe", email: "jane-verify@example.com", password: "password123" });

    const verifyRes = await request(app)
      .post("/api/users/verify-email")
      .send({ token: registerRes.body.verifyEmailToken });

    expect(verifyRes.status).toBe(200);

    const me = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${registerRes.body.token}`);
    expect(me.body.verified).toBe(true);
  });

  it("resends a verification email, and does not reveal account existence or verified status", async () => {
    const unverified = await createUser();

    const resendRes = await request(app)
      .post("/api/users/resend-verification")
      .send({ email: unverified.email });
    expect(resendRes.status).toBe(200);
    expect(resendRes.body.verifyEmailToken).toEqual(expect.any(String));
    expect(sendTemplatedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: unverified.email, template: "verifyEmail" }),
    );

    (sendTemplatedEmail as jest.Mock).mockClear();

    const nobodyRes = await request(app)
      .post("/api/users/resend-verification")
      .send({ email: "nobody@example.com" });
    expect(nobodyRes.status).toBe(200);
    expect(nobodyRes.body.verifyEmailToken).toBeUndefined();
    expect(nobodyRes.body.message).toBe(resendRes.body.message);
    expect(sendTemplatedEmail).not.toHaveBeenCalled();

    const verified = await createUser({ verified: true });
    const alreadyVerifiedRes = await request(app)
      .post("/api/users/resend-verification")
      .send({ email: verified.email });
    expect(alreadyVerifiedRes.body.message).toBe(resendRes.body.message);
    expect(sendTemplatedEmail).not.toHaveBeenCalled();
  });

  it("rejects an invalid or already-used verification token", async () => {
    const invalid = await request(app)
      .post("/api/users/verify-email")
      .send({ token: "not-a-real-token" });
    expect(invalid.status).toBe(400);

    const registerRes = await request(app)
      .post("/api/users")
      .send({ fullName: "Reuse Test", email: "reuse-verify@example.com", password: "password123" });

    const first = await request(app)
      .post("/api/users/verify-email")
      .send({ token: registerRes.body.verifyEmailToken });
    expect(first.status).toBe(200);

    // Already verified — a second use of the same token is a no-op, not
    // an error, since the account is already in the state it asked for.
    const second = await request(app)
      .post("/api/users/verify-email")
      .send({ token: registerRes.body.verifyEmailToken });
    expect(second.status).toBe(200);
    expect(second.body.message).toBe("Email already verified");
  });
});

describe("admin-only user management", () => {
  it("blocks a basic user from creating an admin", async () => {
    const user = await createUser();
    const token = generateToken(user);

    const res = await request(app)
      .post("/api/users/admin-create")
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: "New Admin", email: "admin@example.com", password: "password123" });

    expect(res.status).toBe(401);
  });

  it("lets a super admin create an admin", async () => {
    const superAdmin = await createSuperAdmin();
    const token = generateToken(superAdmin);

    const res = await request(app)
      .post("/api/users/admin-create")
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: "New Admin", email: "admin@example.com", password: "password123" });

    expect(res.status).toBe(201);
    expect(res.body.systemRole).toBe(SYSTEM_ROLE.ADMIN);
  });

  it("lists users with pagination", async () => {
    const superAdmin = await createSuperAdmin();
    const token = generateToken(superAdmin);
    await createUser();
    await createUser();

    const res = await request(app)
      .get("/api/users?limit=2")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(2);
    expect(res.body.pagination.total).toBeGreaterThanOrEqual(3);
  });

  it("lets a plain admin list users too (read-only — admin-create/role/account-status stay super_admin-only)", async () => {
    const admin = await createAdmin();
    const token = generateToken(admin);
    await createUser();

    const res = await request(app).get("/api/users").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const blocked = await request(app)
      .post("/api/users/admin-create")
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: "New Admin", email: "nope@example.com", password: "password123" });
    expect(blocked.status).toBe(401);
  });

  it("finds a user by a case-insensitive match on email or fullName via ?q=", async () => {
    const superAdmin = await createSuperAdmin();
    const token = generateToken(superAdmin);
    await createUser({ fullName: "Charles Okonkwo", email: "charles.okonkwo@example.com" });
    await createUser({ fullName: "Someone Else", email: "someone@example.com" });

    const byName = await request(app)
      .get("/api/users?q=charles")
      .set("Authorization", `Bearer ${token}`);
    expect(byName.body.data).toHaveLength(1);
    expect(byName.body.data[0].email).toBe("charles.okonkwo@example.com");

    const byEmail = await request(app)
      .get("/api/users?q=OKONKWO@EXAMPLE")
      .set("Authorization", `Bearer ${token}`);
    expect(byEmail.body.data).toHaveLength(1);

    // A regex metacharacter in the query must never throw a 500.
    const weird = await request(app)
      .get("/api/users?q=" + encodeURIComponent("a.b*c("))
      .set("Authorization", `Bearer ${token}`);
    expect(weird.status).toBe(200);
  });

  it("changes a user's role", async () => {
    const superAdmin = await createSuperAdmin();
    const token = generateToken(superAdmin);
    const user = await createUser();

    const res = await request(app)
      .patch(`/api/users/${user.id}/role`)
      .set("Authorization", `Bearer ${token}`)
      .send({ systemRole: SYSTEM_ROLE.ADMIN });

    expect(res.status).toBe(200);
    expect(res.body.user.systemRole).toBe(SYSTEM_ROLE.ADMIN);
  });

  it("prevents modifying the Super Admin's own role", async () => {
    const superAdmin = await createSuperAdmin();
    const token = generateToken(superAdmin);

    const res = await request(app)
      .patch(`/api/users/${superAdmin.id}/role`)
      .set("Authorization", `Bearer ${token}`)
      .send({ systemRole: SYSTEM_ROLE.ADMIN });

    expect(res.status).toBe(400);
  });

  it("promotes a user to customer_care", async () => {
    const superAdmin = await createSuperAdmin();
    const token = generateToken(superAdmin);
    const user = await createUser();

    const res = await request(app)
      .patch(`/api/users/${user.id}/role`)
      .set("Authorization", `Bearer ${token}`)
      .send({ systemRole: SYSTEM_ROLE.CUSTOMER_CARE });

    expect(res.status).toBe(200);
    expect(res.body.user.systemRole).toBe(SYSTEM_ROLE.CUSTOMER_CARE);
  });
});

describe("PATCH /api/users/:id/account-status", () => {
  it("suspends a user, and their very next request gets rejected", async () => {
    const superAdmin = await createSuperAdmin();
    const adminToken = generateToken(superAdmin);
    const user = await createUser();
    const userToken = generateToken(user);

    const before = await request(app).get("/api/users/me").set("Authorization", `Bearer ${userToken}`);
    expect(before.status).toBe(200);

    const res = await request(app)
      .patch(`/api/users/${user.id}/account-status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ accountStatus: "suspended" });

    expect(res.status).toBe(200);
    expect(res.body.user.accountStatus).toBe("suspended");

    const after = await request(app).get("/api/users/me").set("Authorization", `Bearer ${userToken}`);
    expect(after.status).toBe(403);
  });

  it("reinstates a suspended user", async () => {
    const superAdmin = await createSuperAdmin();
    const adminToken = generateToken(superAdmin);
    const user = await createUser({ accountStatus: "suspended" });
    const userToken = generateToken(user);

    const blocked = await request(app).get("/api/users/me").set("Authorization", `Bearer ${userToken}`);
    expect(blocked.status).toBe(403);

    const res = await request(app)
      .patch(`/api/users/${user.id}/account-status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ accountStatus: "active" });
    expect(res.status).toBe(200);

    const restored = await request(app).get("/api/users/me").set("Authorization", `Bearer ${userToken}`);
    expect(restored.status).toBe(200);
  });

  it("prevents suspending your own account", async () => {
    const superAdmin = await createSuperAdmin();
    const token = generateToken(superAdmin);

    const res = await request(app)
      .patch(`/api/users/${superAdmin.id}/account-status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ accountStatus: "suspended" });

    expect(res.status).toBe(400);
  });

  it("blocks a non-super-admin from suspending anyone", async () => {
    const admin = await createAdmin();
    const user = await createUser();

    const res = await request(app)
      .patch(`/api/users/${user.id}/account-status`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({ accountStatus: "suspended" });

    expect(res.status).toBe(401);
  });
});
