/**
 * Log-line redaction for everything the shell writes down or shows about its
 * child processes. A dsh child can print credential material in its own
 * diagnostics (an API key echoed back by a provider error, a signed URL with a
 * token), and every consumer here is durable or user-visible: the log file, the
 * kernel log tail on the diagnostics page, the status line in the failure card.
 *
 * Lives in its own module because both the process transport
 * (desktop-host.ts) and the kernel lifecycle (server.ts) need it, and neither
 * may import the other.
 */

/** Cap a diagnostic line so a runaway child cannot grow logs unbounded. */
export const MAX_LOG_LINE = 2_000

/** Redact credential-looking fragments before a line reaches logs or events. */
export function redact(line: string): string {
  return line
    // JSON quoted pairs first: "apiKey": "sk-..." keeps only the key name.
    .replace(/("(?:api[_-]?key|authorization|token|secret|passwd|password|set-cookie)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"')
    // Single-quoted pairs in the same shape — `{'set-cookie': 'sid=…'}` is how
    // node's own inspect() prints an object, and a child's dump reaches the
    // logs verbatim.
    .replace(/('(?:api[_-]?key|authorization|token|secret|passwd|password|set-cookie)'\s*:\s*)'[^']*'/gi, "$1'[redacted]'")
    // A whole Set-Cookie header: every attribute after the name is session
    // material (sid=…, session=…), none of which a log needs. The bare form
    // runs to the end of the line — attributes are part of the value — and
    // `[ \t]*` (not `\s*`) keeps it from eating the line break.
    .replace(/(set-cookie[ \t]*:[ \t]*)(?!\[redacted\]).*/gi, '$1[redacted]')
    // A bearer token carries no key name at all, and is never a short word:
    // "bearer auth" must stay readable, so the token must be long enough to be
    // one (16+ chars, well under any real token). A JWT (three base64url
    // segments, the first starting with the JSON header prefix) is the bearer
    // token's most common encoded form.
    .replace(/(\bbearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, '$1[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '[redacted]')
    // Provider key prefixes with no key name in sight (sk-…, sk-proj-…).
    .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{15,}/g, '[redacted]')
    // Query-string token (?token=abc&next=/) keeps only the key name: the bare
    // rule below would swallow the rest of the URL with \S+, so this rule must
    // land first AND the bare rule must not re-match the value it produced
    // (hence its lookahead) — otherwise `&next=/x` disappears from the log.
    .replace(/([?&](?:token|api[_-]?key)=)[^&\s]+/gi, '$1[redacted]')
    // Bare key=value / key: value pairs last (key name kept, value dropped).
    .replace(/(api[_-]?key|authorization|token|secret|passwd|password)(\s*[:=]\s*)(?!\[redacted\])\S+/gi, '$1$2[redacted]')
    .slice(0, MAX_LOG_LINE)
}
