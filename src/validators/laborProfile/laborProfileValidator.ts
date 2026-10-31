import * as yup from "yup";
import { selfServiceProfileStatus } from "../common";

// `skills`/`links` deliberately aren't validated here — the controller's
// own resolvedSkills/filterValidLinks filters silently drop invalid
// entries rather than rejecting the request (business logic, not a
// shape check), and the MAX_PROFILE_LINKS cap (checked post-filter)
// stays there too. Country format is already enforced once, at the
// Mongoose schema level.
export const createLaborProfileSchema = yup
  .object({
    headline: yup.string().trim().required("Please add a headline and country"),
    bio: yup.string().trim().notRequired(),
    skills: yup.array().notRequired(),
    country: yup.string().trim().required("Please add a headline and country"),
    city: yup.string().trim().notRequired(),
    yearsOfExperience: yup.number().min(0).notRequired(),
    links: yup.array().notRequired(),
  })
  .noUnknown(true);

export const updateLaborProfileSchema = yup
  .object({
    headline: yup.string().trim().notRequired(),
    bio: yup.string().trim().notRequired(),
    skills: yup.array().notRequired(),
    country: yup.string().trim().notRequired(),
    city: yup.string().trim().notRequired(),
    yearsOfExperience: yup.number().min(0).notRequired(),
    links: yup.array().notRequired(),
    status: selfServiceProfileStatus(),
  })
  .noUnknown(true);

// Ownership, req.files counts/caps, and the media-removal endpoints (no
// body fields of their own) all stay in laborProfileController.ts.
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

// Same shape as addPortfolioItemSchema, every field optional — a partial
// edit of an existing item, not a replacement of it. Cross-field ordering
// against whichever of startedAt/completedAt the request *doesn't* touch
// is left to portfolioItemSchema's own model-level validator (it checks
// against the item's final, merged state at save time, which this schema
// can't see in isolation).
export const updatePortfolioItemSchema = yup
  .object({
    title: yup.string().trim().notRequired(),
    description: yup.string().trim().notRequired(),
    tags: yup.array().of(yup.string()).notRequired(),
    startedAt: yup.date().notRequired(),
    completedAt: yup.date().notRequired(),
  })
  .noUnknown(true)
  .test("date-order", "completedAt must be on or after startedAt", (value) => {
    if (!value?.startedAt || !value?.completedAt) return true;
    return value.completedAt >= value.startedAt;
  });
