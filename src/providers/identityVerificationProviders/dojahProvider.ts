import getDojahClient from "../../config/dojah";
import { IdentityVerificationAdapter, VerifyMatchParams, VerifyMatchResult } from "./types";

// Lookup endpoints — confirm the exact current path/response field names
// against Dojah's own docs before going live, not re-verified in this
// pass (see docs/payments-plan.md). Deliberately does its own name
// comparison against whatever the registry returns, rather than assuming
// Dojah hands back a ready-made "matched" boolean — safer than guessing
// a response shape that hasn't been confirmed.
const LOOKUP_PATH: Record<VerifyMatchParams["idType"], string> = {
  bvn: "/api/v1/kyc/bvn",
  nin: "/api/v1/kyc/nin",
};

// Case/whitespace-insensitive, and tolerant of punctuation a registry
// might include that a user wouldn't type (e.g. a hyphenated name) —
// strips anything that isn't a letter before comparing.
const normalizeName = (name: string): string => name.toLowerCase().replace(/[^a-z]/g, "");

export const dojahProvider: IdentityVerificationAdapter = {
  async verifyMatch({ idType, idNumber, firstName, lastName }: VerifyMatchParams): Promise<VerifyMatchResult> {
    const { data } = await getDojahClient().get(LOOKUP_PATH[idType], {
      params: { [idType]: idNumber },
    });

    const record = data.entity ?? data.data ?? data;
    const registryFirstName = String(record.first_name ?? "");
    const registryLastName = String(record.last_name ?? "");

    const matched =
      normalizeName(registryFirstName) === normalizeName(firstName) &&
      normalizeName(registryLastName) === normalizeName(lastName);

    return {
      matched,
      reference: String(record.reference ?? data.reference ?? `${idType}_${idNumber.slice(-4)}_${Date.now()}`),
      raw: data,
    };
  },
};
