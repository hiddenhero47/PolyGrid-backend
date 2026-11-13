const mockGet = jest.fn();

jest.mock("../../src/config/dojah", () => ({
  __esModule: true,
  default: () => ({ get: mockGet }),
}));

import { dojahProvider } from "../../src/providers/identityVerificationProviders/dojahProvider";

afterEach(() => {
  jest.clearAllMocks();
});

describe("dojahProvider.verifyMatch", () => {
  it("matches when the registry's name equals the submitted name, case/whitespace-insensitive", async () => {
    mockGet.mockResolvedValue({
      data: { entity: { first_name: " Ada ", last_name: "OKAFOR", reference: "dojah_ref_1" } },
    });

    const result = await dojahProvider.verifyMatch({
      idType: "bvn",
      idNumber: "12345678901",
      firstName: "ada",
      lastName: "okafor",
    });

    expect(mockGet).toHaveBeenCalledWith("/api/v1/kyc/bvn/full", { params: { bvn: "12345678901" } });
    expect(result.matched).toBe(true);
    expect(result.reference).toBe("dojah_ref_1");
  });

  // Confirmed live against sandbox.dojah.io's actual response shape —
  // bvn=22222222222 (Dojah's own documented sandbox test value) returns
  // exactly this record, including the real "customer" field name (not
  // "reference" — the lookup endpoint has no reference field of its own).
  it("matches the real sandbox response shape for Dojah's documented test BVN", async () => {
    mockGet.mockResolvedValue({
      data: {
        entity: {
          bvn: "22222222222",
          date_of_birth: "2000-05-01",
          first_name: "John",
          gender: "Male",
          last_name: "Adamu",
          middle_name: "Doe",
          phone_number1: "07012345678",
          customer: "6bb82c41-e15e-4308-b99d-e9640818eca9",
        },
      },
    });

    const result = await dojahProvider.verifyMatch({
      idType: "bvn",
      idNumber: "22222222222",
      firstName: "John",
      lastName: "Adamu",
    });

    expect(result.matched).toBe(true);
    expect(result.reference).toBe("6bb82c41-e15e-4308-b99d-e9640818eca9");
  });

  it("fails to match on a genuine name mismatch", async () => {
    mockGet.mockResolvedValue({ data: { entity: { first_name: "Chidi", last_name: "Eze" } } });

    const result = await dojahProvider.verifyMatch({
      idType: "nin",
      idNumber: "10987654321",
      firstName: "Ada",
      lastName: "Okafor",
    });

    expect(mockGet).toHaveBeenCalledWith("/api/v1/kyc/nin", { params: { nin: "10987654321" } });
    expect(result.matched).toBe(false);
  });

  it("falls back to a generated reference when the vendor doesn't provide one", async () => {
    mockGet.mockResolvedValue({ data: { entity: { first_name: "Ada", last_name: "Okafor" } } });

    const result = await dojahProvider.verifyMatch({
      idType: "bvn",
      idNumber: "12345678901",
      firstName: "Ada",
      lastName: "Okafor",
    });

    expect(result.reference).toContain("bvn_8901_");
  });
});
