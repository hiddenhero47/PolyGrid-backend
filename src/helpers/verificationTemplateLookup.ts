import { VerificationTemplate, IVerificationTemplate } from "../models/verificationTemplateModel";

// Exact state match first, falling back to the country's nationwide default
// (`state: null`) — lets an admin configure a country-wide template once and
// only add state/region-specific overrides where a location genuinely needs
// different documents or fields. Used by both the submission flow (which
// profileType + location a Verification validates against) and the
// frontend-facing lookup route (which form to render).
export const findActiveTemplate = async (
  profileType: string,
  country: string,
  state?: string | null,
): Promise<IVerificationTemplate | null> => {
  const normalizedCountry = country.toUpperCase();

  if (state) {
    const stateMatch = await VerificationTemplate.findOne({
      profileType,
      country: normalizedCountry,
      state: state.toUpperCase(),
      isActive: true,
    });
    if (stateMatch) return stateMatch;
  }

  return VerificationTemplate.findOne({
    profileType,
    country: normalizedCountry,
    state: null,
    isActive: true,
  });
};
