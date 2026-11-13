// A shared identity-matching helper — three real consumers:
// providers/identityVerificationProviders/dojahProvider.ts (Dojah's own
// registry record vs. the submitted name), userController.ts's
// updatePayoutAccount (a payout account's accountName vs. the user's own
// fullName), and updateUserProfile's reset logic (a payout account that
// might no longer match after a name change). One definition so all
// three agree on what "the same person" means.

// Case/whitespace-insensitive, and tolerant of punctuation a registry
// might include that a user wouldn't type (e.g. a hyphenated name) —
// strips anything that isn't a letter before comparing. Middle names are
// deliberately never part of this comparison anywhere they're used.
export const normalizeNamePart = (name: string): string => name.toLowerCase().replace(/[^a-z]/g, "");

export const namesMatch = (
  a: { firstName: string; lastName: string },
  b: { firstName: string; lastName: string },
): boolean =>
  normalizeNamePart(a.firstName) === normalizeNamePart(b.firstName) &&
  normalizeNamePart(a.lastName) === normalizeNamePart(b.lastName);

// First word = first name, remainder = last name — the same heuristic
// payoutKycController.ts used to derive a Dojah-matchable name from the
// old plain-string fullName, before fullName became a real
// {firstName, lastName} pair. Still needed for free-text fields that
// stay plain strings (a payout account's accountName, and the
// one-time migration backfill from the old fullName string).
export const splitFullName = (name: string): { firstName: string; lastName: string } => {
  const [firstName, ...rest] = name.trim().split(/\s+/);
  return { firstName, lastName: rest.join(" ") || firstName };
};
