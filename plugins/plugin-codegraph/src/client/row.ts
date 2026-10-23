/**
 * The row decisions the settings page makes, as pure functions.
 *
 * They live apart from `section.tsx` for one reason: the component imports the
 * primitives package, whose entry pulls in `.module.css` files, so a `node:test`
 * suite cannot bundle it. Every rule that decides what a language row SAYS is
 * therefore here, where a test can call it — and the rules are exactly where the
 * reported defects were.
 *
 * The tooltip rule is the subtle one. `Tooltip` renders `label` verbatim, and the
 * primitives document an EMPTY label as "shows only shortcut keys" — a row with
 * no shortcuts and no label pops an empty bubble under the cursor. That is what
 * shipped: the `regex` grammar has no file extension, `extensions.join('  ')` was
 * `''`, and hovering "Regular expression" opened a blank tooltip. The empty
 * string and "no extensions" are the same fact, so the answer is `undefined` —
 * and the RENDER SITE skips the primitive for it. That skip is the real fix: the
 * primitive treats `''` and `undefined` identically, so a caller that always
 * rendered `<Tooltip>` would bring the blank bubble back with this module
 * unchanged. `tests/styles.test.ts` pins the call site for exactly that reason.
 *
 * @module @dsh-app/plugin-codegraph/client/row
 */

/** What the name cell of one language row should show on hover. */
export interface NameBubble {
  /** The tooltip text, or undefined when the row gets NO tooltip. */
  readonly label: string | undefined
}

/**
 * The hover text for a language's name.
 *
 * @param extensions - the extensions that select this language; empty for a
 *   grammar with no file extension (`regex`).
 * @returns the bubble text, with `label` undefined when there must be no tooltip.
 */
export function nameBubble(extensions: readonly string[]): NameBubble {
  // Trimmed, not just length-checked: an extension table that produced `['', ' ']`
  // would render a bubble whose text is invisible, which reads as a rendering bug
  // rather than as missing data.
  const text = extensions.map(extension => extension.trim()).filter(extension => extension !== '').join('  ')
  return { label: text === '' ? undefined : text }
}
