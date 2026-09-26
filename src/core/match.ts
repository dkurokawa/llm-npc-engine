/**
 * The one place that reads what the player typed. Everything downstream of
 * this (facts, disclosure, lies) is decided by ids and booleans — this file
 * is where a line of Japanese text last exists as text.
 */

/** Folds full-width forms into half-width and case, so "ＴＲＵＴＨ" matches "truth". */
function normalize(s: string): string {
  return s.normalize("NFKC").toLowerCase();
}

/**
 * True when any of `keywords` appears as a substring of `line`, after both
 * sides are normalized. An empty `keywords` list never matches — there is
 * nothing for a bare line to trip.
 */
export function matchesAny(line: string, keywords: readonly string[]): boolean {
  if (keywords.length === 0) return false;
  const normalized = normalize(line);
  return keywords.some((k) => normalized.includes(normalize(k)));
}
