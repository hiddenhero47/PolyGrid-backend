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

    expect(mockGet).toHaveBeenCalledWith("/api/v1/kyc/bvn", { params: { bvn: "12345678901" } });
    expect(result.matched).toBe(true);
    expect(result.reference).toBe("dojah_ref_1");
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
