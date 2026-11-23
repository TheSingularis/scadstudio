// The smallest single range that turns `before` into `after`: the common
// prefix and suffix are left alone, so the cursor, folding and the undo
// step all stay local to what the visual edit actually changed.
export function minimalReplacement(before: string, after: string): { start: number; end: number; text: string } {
  let start = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (start < maxPrefix && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let suffix = 0;
  const maxSuffix = Math.min(before.length, after.length) - start;
  while (
    suffix < maxSuffix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix++;
  }
  return { start, end: before.length - suffix, text: after.slice(start, after.length - suffix) };
}
