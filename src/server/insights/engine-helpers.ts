/** Shared small helpers for the insight layer (kept dependency-light). */

/** Escapes a value for an exact-match PromQL string literal. */
export function escapePromQL(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
