import request from "supertest";
import createApp from "../../src/app";

const app = createApp();

describe("GET /api/reference/countries", () => {
  it("is public and lists real countries", async () => {
    const res = await request(app).get("/api/reference/countries");

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(100);
    expect(res.body.data).toContainEqual(
      expect.objectContaining({ isoCode: "NG", name: "Nigeria", currency: "NGN" }),
    );
  });
});

describe("GET /api/reference/countries/:countryCode/states", () => {
  it("lists a country's states", async () => {
    const res = await request(app).get("/api/reference/countries/NG/states");

    expect(res.status).toBe(200);
    expect(res.body.data).toContainEqual({ isoCode: "LA", name: "Lagos" });
  });

  it("404s for an unknown country code", async () => {
    const res = await request(app).get("/api/reference/countries/ZZ/states");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/reference/countries/:countryCode/cities", () => {
  it("lists a country's cities", async () => {
    const res = await request(app).get("/api/reference/countries/NG/cities");

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it("scopes to a state when ?state= is given", async () => {
    const res = await request(app).get("/api/reference/countries/NG/cities?state=LA");

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((city: { stateCode: string }) => city.stateCode === "LA")).toBe(true);
  });

  it("404s for an unknown country code", async () => {
    const res = await request(app).get("/api/reference/countries/ZZ/cities");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/reference/currencies", () => {
  it("lists ISO 4217 currencies with their decimal digits", async () => {
    const res = await request(app).get("/api/reference/currencies");

    expect(res.status).toBe(200);
    expect(res.body.data).toContainEqual({ code: "USD", digits: 2 });
    expect(res.body.data).toContainEqual({ code: "JPY", digits: 0 });
  });
});
