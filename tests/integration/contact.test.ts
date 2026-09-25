import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import { createUser, generateToken } from "../setup/fixtures";
import { Contact } from "../../src/models/contactModel";

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

describe("POST /api/contacts", () => {
  it("requires authentication", async () => {
    const res = await request(app).post("/api/contacts").send({});
    expect(res.status).toBe(401);
  });

  it("connects two users mutually by userId", async () => {
    const me = await createUser();
    const other = await createUser();

    const res = await request(app)
      .post("/api/contacts")
      .set("Authorization", `Bearer ${generateToken(me)}`)
      .send({ userId: other.id });

    expect(res.status).toBe(200);

    const mine = await Contact.findOne({ userId: me._id });
    const theirs = await Contact.findOne({ userId: other._id });
    expect(mine?.list.map((e) => e.user.toString())).toEqual([other.id]);
    expect(theirs?.list.map((e) => e.user.toString())).toEqual([me.id]);
  });

  it("connects by email", async () => {
    const me = await createUser();
    const other = await createUser();

    const res = await request(app)
      .post("/api/contacts")
      .set("Authorization", `Bearer ${generateToken(me)}`)
      .send({ email: other.email });

    expect(res.status).toBe(200);
    const mine = await Contact.findOne({ userId: me._id });
    expect(mine?.list.map((e) => e.user.toString())).toEqual([other.id]);
  });

  it("is idempotent — connecting twice doesn't duplicate the entry", async () => {
    const me = await createUser();
    const other = await createUser();
    const token = generateToken(me);

    await request(app).post("/api/contacts").set("Authorization", `Bearer ${token}`).send({ userId: other.id });
    await request(app).post("/api/contacts").set("Authorization", `Bearer ${token}`).send({ userId: other.id });

    const mine = await Contact.findOne({ userId: me._id });
    expect(mine?.list).toHaveLength(1);
  });

  it("rejects connecting to yourself", async () => {
    const me = await createUser();

    const res = await request(app)
      .post("/api/contacts")
      .set("Authorization", `Bearer ${generateToken(me)}`)
      .send({ userId: me.id });

    expect(res.status).toBe(400);
  });

  it("404s for an unknown user", async () => {
    const me = await createUser();

    const res = await request(app)
      .post("/api/contacts")
      .set("Authorization", `Bearer ${generateToken(me)}`)
      .send({ userId: "507f1f77bcf86cd799439011" });

    expect(res.status).toBe(404);
  });
});

describe("GET /api/contacts", () => {
  it("lists my contacts, newest first", async () => {
    const me = await createUser();
    const a = await createUser();
    const b = await createUser();
    const token = generateToken(me);

    await request(app).post("/api/contacts").set("Authorization", `Bearer ${token}`).send({ userId: a.id });
    await request(app).post("/api/contacts").set("Authorization", `Bearer ${token}`).send({ userId: b.id });

    const res = await request(app).get("/api/contacts").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].user).toBe(b.id); // most recently connected first
    expect(res.body.pagination.total).toBe(2);
  });

  it("returns an empty list for a user with no contacts", async () => {
    const me = await createUser();

    const res = await request(app)
      .get("/api/contacts")
      .set("Authorization", `Bearer ${generateToken(me)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe("DELETE /api/contacts/:userId", () => {
  it("removes a contact from only my own list", async () => {
    const me = await createUser();
    const other = await createUser();

    await request(app)
      .post("/api/contacts")
      .set("Authorization", `Bearer ${generateToken(me)}`)
      .send({ userId: other.id });

    const res = await request(app)
      .delete(`/api/contacts/${other.id}`)
      .set("Authorization", `Bearer ${generateToken(me)}`);
    expect(res.status).toBe(200);

    const mine = await Contact.findOne({ userId: me._id });
    const theirs = await Contact.findOne({ userId: other._id });
    expect(mine?.list).toHaveLength(0);
    expect(theirs?.list.map((e) => e.user.toString())).toEqual([me.id]); // untouched
  });
});
