import * as yup from "yup";

// `specialties`/`links` deliberately aren't validated here — the
// controller's own resolvedSpecialties/filterValidLinks filters
// silently drop invalid entries rather than rejecting the request
// (business logic, not a shape check), and the MAX_PROFILE_LINKS cap
// (checked post-filter) stays there too. Country format is already
// enforced once, at the Mongoose schema level.
export const createContractorProfileSchema = yup
  .object({
    headline: yup.string().trim().required("Please add a headline and country"),
    bio: yup.string().trim().notRequired(),
    specialties: yup.array().notRequired(),
    country: yup.string().trim().required("Please add a headline and country"),
    city: yup.string().trim().notRequired(),
    yearsOfExperience: yup.number().min(0).notRequired(),
    links: yup.array().notRequired(),
  })
  .noUnknown(true);

export const updateContractorProfileSchema = yup
  .object({
    headline: yup.string().trim().notRequired(),
    bio: yup.string().trim().notRequired(),
    specialties: yup.array().notRequired(),
    country: yup.string().trim().notRequired(),
    city: yup.string().trim().notRequired(),
    yearsOfExperience: yup.number().min(0).notRequired(),
    links: yup.array().notRequired(),
  })
  .noUnknown(true);

// Ownership, req.files counts/caps, and the media-removal endpoints (no
// body fields of their own) all stay in contractorProfileController.ts.
export const addPortfolioItemSchema = yup
  .object({
    title: yup.string().trim().required("Please add a title"),
    description: yup.string().trim().notRequired(),
    tags: yup.array().of(yup.string()).notRequired().default([]),
    startedAt: yup.date().notRequired(),
    completedAt: yup.date().notRequired(),
  })
  .noUnknown(true)
  .test("date-order", "completedAt must be on or after startedAt", (value) => {
    if (!value?.startedAt || !value?.completedAt) return true;
    return value.completedAt >= value.startedAt;
  });
