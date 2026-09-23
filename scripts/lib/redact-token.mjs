/**
 * Mask the session token in one line before printing it.
 *
 * A ready kernel prints its authenticated address into its own output
 * (`dsh web: http://…/?token=…`), and a diagnostic script quotes that output
 * verbatim — so the line the application itself redacts (`src/main/redact.ts`,
 * measured: one side prints `[redacted]`, the other the token) reaches a
 * terminal or a CI log in the clear.
 *
 * The two shapes are deliberately narrow — a query-string token and a Bearer
 * credential. A wider rule would eat ordinary output, and this output is a
 * diagnostic someone has to read.
 *
 * @module dsh-app/scripts/lib/redact-token
 */

/**
 * Replace the token-shaped parts of one line with `[redacted]`.
 * @param line - one line of child-process output.
 * @returns the same line with query-string tokens and Bearer credentials masked.
 */
export function redactToken(line) {
  return line
    .replace(/([?&](?:token|access_token|api_key|apikey)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/(\bBearer\s+)[\w.~+/=-]+/gi, '$1[redacted]')
}
