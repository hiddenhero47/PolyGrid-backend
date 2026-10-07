import * as yup from "yup";

// `specializations`/`links` deliberately aren't validated here — the
// controller's own resolvedSpecializations/filterValidLinks filters
// silently drop invalid entries rather than rejecting the request
// (business logic, not a shape check), and the MAX_PROFILE_LINKS cap
// (checked post-filter) stays there too. `services`/`mentorship` also
// stay out of scope: the controller already trusted their shape to
// Mongoose's own sub-schema validation at `.save()` time with no inline
// check of its own, so there's no existing check to move. Country
// format is already enforced once, at the Mongoose schema level.
export const createConsultancyProfileSchema = yup
  .object({
    headline: yup.string().trim().required("Please add a headline and country"),
    bio: yup.string().trim().notRequired(),
    specializations: yup.array().notRequired(),
    country: yup.string().trim().required("Please add a headline and country"),
    city: yup.string().trim().notRequired(),
    yearsOfExperience: yup.number().min(0).notRequired(),
    links: yup.array().notRequired(),
  })
  .noUnknown(true);

export const updateConsultancyProfileSchema = yup
  .object({
    headline: yup.string().trim().notRequired(),
    bio: yup.string().trim().notRequired(),
    specializations: yup.array().notRequired(),
    country: yup.string().trim().notRequired(),
    city: yup.string().trim().notRequired(),
    yearsOfExperience: yup.number().min(0).notRequired(),
    links: yup.array().notRequired(),
    services: yup.array().notRequired(),
    // A bare yup.object() with no declared shape still counts as "shape
    // {}" for stripUnknown's purposes — every key inside it (isMentor,
    // etc.) would get silently stripped as "unknown" on an object
    // validator run with stripUnknown: true. yup.mixed() has no shape of
    // its own to strip against, so the value passes through untouched,
    // same as `services` above.
    mentorship: yup.mixed().notRequired(),
  })
  .noUnknown(true);

// Ownership, req.files counts/caps, and the media-removal endpoints (no
// body fields of their own) all stay in consultancyProfileController.ts.
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
