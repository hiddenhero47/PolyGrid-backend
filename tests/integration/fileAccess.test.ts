import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import {
  createUser,
  createAdmin,
  generateToken,
  createPrivateFile,
  TEST_PNG_BUFFER,
} from "../setup/fixtures";
import { FileGrant } from "../../src/models/fileGrantModel";
import { signFileUrl, FILE_URL_MODE } from "../../src/helpers/fileSigning";
import { unlockUrl } from "../../src/helpers/fileLinkLock";

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

// signFileUrl returns an absolute URL (BASE_URL + path + ?token=) — pull
// just the path+query supertest needs to hit the app directly.
const pathOf = (absoluteUrl: string): string => {
  const url = new URL(absoluteUrl);
  return `${url.pathname}${url.search}`;
};

describe("POST /api/files/private", () => {
  it("requires authentication", async () => {
    const res = await request(app)
      .post("/api/files/private")
      .attach("file", TEST_PNG_BUFFER, "doc.png");
    expect(res.status).toBe(401);
  });

  it("uploads and hands back working view/download links for the uploader", async () => {
    const owner = await createUser();

    const res = await request(app)
      .post("/api/files/private")
      .set("Authorization", `Bearer ${generateToken(owner)}`)
      .attach("file", TEST_PNG_BUFFER, "doc.png");

    expect(res.status).toBe(201);
    expect(res.body.ownerId).toBe(owner.id);
    expect(await FileGrant.findOne({ fileName: res.body.fileName })).toBeNull();

    const view = await request(app).get(pathOf(res.body.requestUrl));
    expect(view.status).toBe(200);
    expect(view.headers["content-type"]).toContain("image/png");

    const download = await request(app).get(pathOf(res.body.downloadUrl));
    expect(download.status).toBe(200);
    expect(download.headers["content-disposition"]).toContain("attachment");
  });

  it("writes a FileGrant naming only valid, existing users", async () => {
    const owner = await createUser();
    const granted = await createUser();

    const res = await request(app)
      .post("/api/files/private")
      .set("Authorization", `Bearer ${generateToken(owner)}`)
      .field("allowedUserIds[]", granted.id)
      .field("allowedUserIds[]", "not-a-real-id")
      .attach("file", TEST_PNG_BUFFER, "doc.png");

    expect(res.status).toBe(201);
    const grant = await FileGrant.findOne({ fileName: res.body.fileName });
    expect(grant?.allowedUsers.map((id) => id.toString())).toEqual([granted.id]);
  });

  it("fails the whole request when no valid file is provided — this route's only job is the file", async () => {
    const owner = await createUser();

    const res = await request(app)
      .post("/api/files/private")
      .set("Authorization", `Bearer ${generateToken(owner)}`)
      .attach("file", Buffer.from("not a real file"), "notes.txt");

    expect(res.status).toBe(400);
  });
});

describe("GET /api/files/private/:ownerId/:fileName/link", () => {
  it("mints links for the owner with no FileGrant needed", async () => {
    const owner = await createUser();
    const file = await createPrivateFile({ uploader: owner });

    const res = await request(app)
      .get(`/api/files/private/${owner.id}/${file.fileName}/link`)
      .set("Authorization", `Bearer ${generateToken(owner)}`);

    expect(res.status).toBe(200);
    expect(res.body.requestUrl).toContain("/private/view/");
    expect(res.body.downloadUrl).toContain("/private/download/");
  });

  it("mints links for an admin regardless of grants", async () => {
    const owner = await createUser();
    const admin = await createAdmin();
    const file = await createPrivateFile({ uploader: owner });

    const res = await request(app)
      .get(`/api/files/private/${owner.id}/${file.fileName}/link`)
      .set("Authorization", `Bearer ${generateToken(admin)}`);

    expect(res.status).toBe(200);
  });

  it("mints links for an explicitly granted user", async () => {
    const owner = await createUser();
    const granted = await createUser();
    const file = await createPrivateFile({ uploader: owner, allowedUsers: [granted] });

    const res = await request(app)
      .get(`/api/files/private/${owner.id}/${file.fileName}/link`)
      .set("Authorization", `Bearer ${generateToken(granted)}`);

    expect(res.status).toBe(200);
  });

  it("blocks a stranger", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const file = await createPrivateFile({ uploader: owner });

    const res = await request(app)
      .get(`/api/files/private/${owner.id}/${file.fileName}/link`)
      .set("Authorization", `Bearer ${generateToken(stranger)}`);

    expect(res.status).toBe(403);
  });
});

describe("GET /private/view|download/:ownerId/:fileName (signed link)", () => {
  it("needs no Authorization header at all — the token is the credential", async () => {
    const owner = await createUser();
    const file = await createPrivateFile({ uploader: owner });
    const url = signFileUrl({ ownerId: owner.id, fileName: file.fileName, mode: FILE_URL_MODE.VIEW });

    const res = await request(app).get(pathOf(url));
    expect(res.status).toBe(200);
  });

  it("rejects a request with no token", async () => {
    const owner = await createUser();
    const file = await createPrivateFile({ uploader: owner });

    const res = await request(app).get(`/private/view/${owner.id}/${file.fileName}`);
    expect(res.status).toBe(401);
  });

  it("rejects a garbled token", async () => {
    const owner = await createUser();
    const file = await createPrivateFile({ uploader: owner });

    const res = await request(app).get(
      `/private/view/${owner.id}/${file.fileName}?token=garbled.token.value`,
    );
    expect(res.status).toBe(403);
  });

  it("rejects an expired token", async () => {
    const owner = await createUser();
    const file = await createPrivateFile({ uploader: owner });
    const url = signFileUrl({
      ownerId: owner.id,
      fileName: file.fileName,
      mode: FILE_URL_MODE.VIEW,
      expiresInSeconds: -1,
    });

    const res = await request(app).get(pathOf(url));
    expect(res.status).toBe(403);
  });

  it("rejects a view token replayed against the download route", async () => {
    const owner = await createUser();
    const file = await createPrivateFile({ uploader: owner });
    const viewUrl = signFileUrl({ ownerId: owner.id, fileName: file.fileName, mode: FILE_URL_MODE.VIEW });
    const token = new URL(viewUrl).searchParams.get("token");

    const res = await request(app).get(`/private/download/${owner.id}/${file.fileName}?token=${token}`);
    expect(res.status).toBe(403);
  });

  it("rejects a token minted for a different file", async () => {
    const owner = await createUser();
    const fileA = await createPrivateFile({ uploader: owner });
    const fileB = await createPrivateFile({ uploader: owner });
    const urlForA = signFileUrl({ ownerId: owner.id, fileName: fileA.fileName, mode: FILE_URL_MODE.VIEW });
    const token = new URL(urlForA).searchParams.get("token");

    const res = await request(app).get(`/private/view/${owner.id}/${fileB.fileName}?token=${token}`);
    expect(res.status).toBe(403);
  });

  it("never caches a response", async () => {
    const owner = await createUser();
    const file = await createPrivateFile({ uploader: owner });
    const url = signFileUrl({ ownerId: owner.id, fileName: file.fileName, mode: FILE_URL_MODE.VIEW });

    const res = await request(app).get(pathOf(url));
    expect(res.headers["cache-control"]).toContain("no-store");
  });
});

describe("lock key — the returned URL is encrypted, not gated at redemption", () => {
  it("mints ordinary, unlocked (plain string) links when no lock key header is sent", async () => {
    const owner = await createUser();
    const file = await createPrivateFile({ uploader: owner });

    const res = await request(app)
      .get(`/api/files/private/${owner.id}/${file.fileName}/link`)
      .set("Authorization", `Bearer ${generateToken(owner)}`);

    expect(res.body.locked).toBe(false);
    expect(typeof res.body.requestUrl).toBe("string");

    const view = await request(app).get(pathOf(res.body.requestUrl));
    expect(view.status).toBe(200);
  });

  it("returns encrypted {iv, data} envelopes instead of plain URLs when a lock key is sent while minting", async () => {
    const owner = await createUser();
    const file = await createPrivateFile({ uploader: owner });

    const res = await request(app)
      .get(`/api/files/private/${owner.id}/${file.fileName}/link`)
      .set("Authorization", `Bearer ${generateToken(owner)}`)
      .set("X-File-Lock-Key", "reviewer-session-key-123");

    expect(res.body.locked).toBe(true);
    expect(typeof res.body.requestUrl).toBe("object");
    expect(res.body.requestUrl.iv).toBeTruthy();
    expect(res.body.requestUrl.data).toBeTruthy();
  });

  it("decrypting with the right lock key recovers a working URL that needs no header to redeem", async () => {
    const owner = await createUser();
    const file = await createPrivateFile({ uploader: owner });

    const minted = await request(app)
      .get(`/api/files/private/${owner.id}/${file.fileName}/link`)
      .set("Authorization", `Bearer ${generateToken(owner)}`)
      .set("X-File-Lock-Key", "reviewer-session-key-123");

    const decryptedUrl = unlockUrl(minted.body.requestUrl, "reviewer-session-key-123");

    // No X-File-Lock-Key header at all here — the key already did its job
    // client-side by being required to recover the URL in the first place.
    const res = await request(app).get(pathOf(decryptedUrl));
    expect(res.status).toBe(200);
  });

  it("decrypting with the wrong lock key fails outright — the envelope is not usable", async () => {
    const owner = await createUser();
    const file = await createPrivateFile({ uploader: owner });

    const minted = await request(app)
      .get(`/api/files/private/${owner.id}/${file.fileName}/link`)
      .set("Authorization", `Bearer ${generateToken(owner)}`)
      .set("X-File-Lock-Key", "reviewer-session-key-123");

    expect(() => unlockUrl(minted.body.requestUrl, "wrong-key")).toThrow();
  });

  it("copying the locked response's requestUrl/downloadUrl verbatim is useless — they aren't URLs at all", async () => {
    const owner = await createUser();
    const file = await createPrivateFile({ uploader: owner });

    const minted = await request(app)
      .get(`/api/files/private/${owner.id}/${file.fileName}/link`)
      .set("Authorization", `Bearer ${generateToken(owner)}`)
      .set("X-File-Lock-Key", "reviewer-session-key-123");

    // Someone who only copied the JSON response (no lock key) has an {iv,
    // data} object, not a path+token — there's nothing to even attempt a
    // request with.
    expect(() => new URL(String(minted.body.requestUrl))).toThrow();
  });
});

describe("GET /public/:fileName", () => {
  it("serves a publicly-uploaded avatar with no credentials", async () => {
    const user = await createUser();

    const upload = await request(app)
      .put("/api/users/profile")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .attach("file", TEST_PNG_BUFFER, "avatar.png");

    expect(upload.status).toBe(200);
    const fileName = upload.body.user.avatar.fileName;

    const res = await request(app).get(`/public/${fileName}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
  });
});
