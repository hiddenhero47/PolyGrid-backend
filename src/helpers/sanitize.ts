// Habit going forward: a controller should never spread/assign req.body
// straight onto a document. Pull out only the fields it actually accepts,
// via this helper, and drop the ones that don't carry real intent —
// `undefined` (the caller didn't send this field at all) and `""` (a form
// field left blank) both mean "no value provided," and letting either
// through can silently clobber an existing value (e.g. PATCHing a profile
// with a half-filled form would otherwise blank out every field the client
// didn't render). `null` is left alone by default, because it's the one
// value with a specific, intentional meaning: "clear this field." A field
// that's allowed to be explicitly reset to null opts in via `allowNull`.
export const pickDefinedFields = <T extends Record<string, unknown>>(
  source: Record<string, unknown>,
  keys: (keyof T)[],
  options: { allowNull?: (keyof T)[] } = {},
): Partial<T> => {
  const allowNull = new Set(options.allowNull ?? []);
  const result: Partial<T> = {};

  for (const key of keys) {
    const value = source[key as string];

    if (value === undefined) continue;
    if (value === "") continue;
    if (value === null && !allowNull.has(key)) continue;

    result[key] = value as T[typeof key];
  }

  return result;
};
