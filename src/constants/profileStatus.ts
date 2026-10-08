// Shared by every PROFILE_MODEL_REGISTRY entry (see profileTypes.ts) —
// one profile-level status, same values regardless of pillar. `active`
// is the default every profile is created with. `inactive` is
// self-service ("I'm taking a break") — the owner's own update endpoint
// can toggle between `active`/`inactive` freely, but never to/from
// `banned`. `banned` is admin-only, set through the generic
// PATCH /api/admin/profiles/:profileType/:id/status endpoint
// (adminProfileController.ts) — the one place a profile can ever become
// (or stop being) banned, and the owner's own update endpoint refuses
// any change at all while a profile is banned.
//
// Both `inactive` and `banned` drop a profile out of search/browse
// results and fail every loadEligibleXProfile-style check (can't post,
// bid, apply, or sell while on a break or banned) — see each pillar
// controller's own search/eligibility query. `banned` additionally hides
// the profile's own direct page (the same {available: false} shape an
// unsubscribed profile already gets); `inactive` leaves the direct page
// visible, since existing reputation/reviews shouldn't disappear just
// because the owner is on a short break.
export const PROFILE_STATUS = {
  ACTIVE: "active",
  INACTIVE: "inactive",
  BANNED: "banned",
} as const;
export type ProfileStatus = (typeof PROFILE_STATUS)[keyof typeof PROFILE_STATUS];
