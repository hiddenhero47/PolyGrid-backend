import getDojahClient from "../../config/dojah";
import { IdentityVerificationAdapter, VerifyMatchParams, VerifyMatchResult } from "./types";
import { normalizeNamePart } from "../../helpers/nameMatch";

// Lookup endpoints — confirmed live against sandbox.dojah.io with the
// documented sandbox test values (bvn=22222222222, nin=70123456789; both
// return the same mock identity: John [middle: Doe] Adamu). NOTE: the
// plain /api/v1/kyc/bvn endpoint is NOT a lookup — it's a separate
// match/confidence-score endpoint (it expects first_name/last_name as
// input and returns {status, confidence_value} per field, no actual name
// data) and was wrong here; /bvn/full is the one that returns real
// registry data. /api/v1/kyc/nin was already correct. Deliberately does
// its own name comparison against whatever the registry returns, rather
// than assuming Dojah hands back a ready-made "matched" boolean — safer
// than guessing a response shape that hasn't been confirmed.
const LOOKUP_PATH: Record<VerifyMatchParams["idType"], string> = {
  bvn: "/api/v1/kyc/bvn/full",
  nin: "/api/v1/kyc/nin",
};

export const dojahProvider: IdentityVerificationAdapter = {
  async verifyMatch({ idType, idNumber, firstName, lastName }: VerifyMatchParams): Promise<VerifyMatchResult> {
    const { data } = await getDojahClient().get(LOOKUP_PATH[idType], {
      params: { [idType]: idNumber },
    });

    const record = data.entity ?? data.data ?? data;
    const registryFirstName = String(record.first_name ?? "");
    const registryLastName = String(record.last_name ?? "");

    const matched =
      normalizeNamePart(registryFirstName) === normalizeNamePart(firstName) &&
      normalizeNamePart(registryLastName) === normalizeNamePart(lastName);

    return {
      matched,
      // Dojah's own lookup response carries no "reference" field —
      // `customer` (a UUID, confirmed live) is its closest equivalent;
      // falls back to a generated one if that's ever absent too.
      reference: String(record.customer ?? record.reference ?? data.reference ?? `${idType}_${idNumber.slice(-4)}_${Date.now()}`),
      raw: data,
    };
  },
};
