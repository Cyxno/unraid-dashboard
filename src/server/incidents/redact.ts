/**
 * Secret redaction for support bundles and diagnostics (v1.5.0 Fase 29).
 *
 * Defense in depth: bundles are built from sanitized fields ONLY, and
 * then run through this scrubber anyway — any string that accidentally
 * carries credential-shaped material is masked before it can leave the
 * process. Patterns are deliberately broad (false positives just redact
 * a bit too much; false negatives would leak).
 */

const REDACTED = "[REDACTED]";

const KEY_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "api-key", re: /(?:api[_-]?key|apikey|unraid[_-]?api[_-]?key|action[_-]?key|agent[_-]?api[_-]?token|update[_-]?helper[_-]?token|ghcr[_-]?token|bearer)/i },
  { label: "authorization", re: /(?:authorization|cookie|set-cookie|proxy-auth|auth[_-]?token|x-api-key)/i },
  { label: "vapid", re: /(?:vapid|private[_-]?key|privatekey)/i },
  { label: "password", re: /(?:password|passwd|secret)/i },
  { label: "push-key", re: /(?:p256dh|push[_-]?auth)/i },
];

/** Long high-entropy tokens (JWTs, base64url keys, digests with secrets). */
const VALUE_PATTERNS: RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redactString(value: string): string {
  let out = value;
  for (const { re } of KEY_PATTERNS) {
    // "key: value" / "key=value" / "key": "value" shapes → mask the value.
    // Groups: 1=key, 2=separator, 3=optional quote (backreferenced).
    out = out.replace(
      new RegExp(`(${re.source})(\\s*[:=]\\s*)(["']?)([^"'\\s,}]{4,})(\\3)`, "gi"),
      (_match, key: string, sep: string, quote: string) => `${key}${sep}${quote}${REDACTED}${quote}`,
    );
  }
  for (const re of VALUE_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  // Standalone long base64url/hex secrets (≥32 chars) — masks real keys,
  // at the cost of also masking long ids (acceptable for a support bundle).
  out = out.replace(/\b[A-Za-z0-9_-]{32,}\b/g, (match) => {
    if (/^[a-f0-9]{64}$/.test(match)) return match; // sha256 image digests are public
    return REDACTED;
  });
  return out;
}

/** Deep redaction of JSON-ish structures (objects/arrays/strings). */
export function redactValue<T>(value: T): T {
  if (typeof value === "string") return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (KEY_PATTERNS.some(({ re }) => re.test(key))) {
        out[key] = REDACTED;
      } else {
        out[key] = redactValue(entry);
      }
    }
    return out as unknown as T;
  }
  return value;
}

/** Push subscription endpoints are credential-adjacent URLs: keep only a
 *  countable, non-callable shape (scheme + host + short hash). */
export function redactPushEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const hash = Array.from(endpoint).reduce<number>(
      (acc, char) => ((acc * 31 + char.charCodeAt(0)) >>> 0),
      0,
    );
    return `${url.protocol}//${url.host}/…#${hash.toString(16).slice(0, 8)}`;
  } catch {
    return REDACTED;
  }
}
