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
    .replace(/("(?:api[_-]?key|authorization|token|secret|passwd|password)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"')
    .replace(/('(?:api[_-]?key|authorization|token|secret|passwd|password)'\s*:\s*)'[^']*'/gi, "$1'[redacted]'")
    // Query-string token (?token=abc&next=/) keeps only the key name: the bare
    // rule below would swallow the rest of the URL with \S+, so this rule must
    // land first AND the bare rule must not re-match the value it produced
    // (hence its lookahead) — otherwise `&next=/x` disappears from the log.
    .replace(/([?&](?:token|api[_-]?key)=)[^&\s]+/gi, '$1[redacted]')
    // Bare key=value / key: value pairs last (key name kept, value dropped).
    .replace(/(api[_-]?key|authorization|token|secret|passwd|password)(\s*[:=]\s*)(?!\[redacted\])\S+/gi, '$1$2[redacted]')
    .slice(0, MAX_LOG_LINE)
}
