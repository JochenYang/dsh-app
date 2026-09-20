/**
 * Comment stripping that preserves line numbers, for the static checks that
 * read source text (the plugin-graph Han check and the type-escape ratchet).
 *
 * Why not a regex: `/\/\*[\s\S]*?\*\//` treats a `/*` INSIDE a string literal
 * (a glob like `'**\/*.ts'`) as a comment start and swallows everything up to
 * the next `*\/` — silently hiding real occurrences in between. This scanner
 * tracks quote state, so only real comments are removed. Removed block
 * comments are replaced with their own newlines, so a caller's `index + 1`
 * is still the line in the FILE.
 *
 * Limitations (accepted): regex literals and template-literal `${}`
 * expressions are not parsed as such; a `//` sequence inside a regex literal
 * would be read as a line comment. Both would only ever remove MORE text than
 * a real parser, which the callers treat as a report, not a gate.
 *
 * @param {string} source - file text.
 * @returns {string} the text with comments removed and line breaks kept.
 */
export function stripComments(source) {
  let out = ''
  let quote = null
  let i = 0
  const n = source.length
  while (i < n) {
    const ch = source[i]
    const next = source[i + 1]
    if (quote !== null) {
      out += ch
      if (ch === '\\' && quote !== '`') {
        out += next ?? ''
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n'
        i += 1
      }
      i += 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      out += ch
      i += 1
      continue
    }
    out += ch
    i += 1
  }
  return out
}
