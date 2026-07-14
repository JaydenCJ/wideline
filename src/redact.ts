/**
 * Key-based redaction. Wide events routinely absorb request headers and
 * user objects, so anything whose key smells like a credential is
 * replaced with a fixed placeholder before it can reach the emitter.
 * Matching is on the last dot segment, case-insensitively, so
 * `http.header.authorization` and `user.password_hash` are both caught.
 */

import type { RedactOptions } from "./types.js";

export const REDACTED = "[REDACTED]";

/** Built-in sensitive-key substrings, matched against the last key segment. */
export const DEFAULT_REDACT_KEYS: readonly string[] = [
  "password",
  "passwd",
  "secret",
  "token",
  "authorization",
  "cookie",
  "session_id",
  "api_key",
  "apikey",
  "access_key",
  "private_key",
  "credential",
  "client_secret",
  "card_number",
  "cvv",
  "ssn",
];

export type Redactor = (key: string) => boolean;

/**
 * Build a redactor from options. String patterns match as substrings of
 * the last key segment (case-insensitive); RegExp patterns test the full
 * key. `defaults: false` drops the built-in list.
 */
export function createRedactor(options: RedactOptions = {}): Redactor {
  const substrings: string[] = [];
  const regexes: RegExp[] = [];
  if (options.defaults !== false) substrings.push(...DEFAULT_REDACT_KEYS);
  for (const p of options.keys ?? []) {
    if (typeof p === "string") substrings.push(p.toLowerCase());
    else regexes.push(p);
  }
  return (key: string): boolean => {
    const lastDot = key.lastIndexOf(".");
    const seg = (lastDot === -1 ? key : key.slice(lastDot + 1)).toLowerCase();
    for (const s of substrings) {
      if (seg.includes(s)) return true;
    }
    for (const r of regexes) {
      if (r.test(key)) return true;
    }
    return false;
  };
}
