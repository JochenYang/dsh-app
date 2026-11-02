/**
 * Source-level invariants of the settings-page section.
 *
 * Three things here are not visible from a type check, and each has already
 * gone wrong once in this suite:
 *   - a dialog drawn by hand instead of composed from the host's `Modal`
 *     primitive (mask, blur, elevation, focus handling and Escape all come with
 *     the primitive; a hand-rolled copy gets the tokens right and the
 *     composition wrong);
 *   - a native `alert`/`confirm`/`prompt`, which this app forbids in client UI;
 *   - user-visible copy written outside the plugin's own dictionary, which is
 *     the only place Han characters may live under `src/`.
 *
 * The file is read from source rather than from the bundle, and its line
 * endings are normalised first: this checkout is CRLF on Windows, and a CRLF
 * line never equals a bare `\n`-terminated one.
 *
 * @module @dsh-app/plugin-archives/tests/client
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const srcDir = join(here, '..', 'src')

/** One source file, with CRLF folded to LF. */
function source(relative: string): string {
  return readFileSync(join(srcDir, relative), 'utf8').replace(/\r\n/gu, '\n')
}

/** Every file under `src/`, recursively. */
function allSources(dir = srcDir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? allSources(path) : [path]
  })
}

test('the destructive trash actions use the host dialog primitive', () => {
  const section = source('client/archives-section.tsx')
  assert.match(section, /import \{[^}]*\bModal\b[^}]*\} from '@deepseek-ai\/dsh-client-ui-primitives'/s)
  assert.match(section, /import \{[^}]*\bButton\b[^}]*\} from '@deepseek-ai\/dsh-client-ui-primitives'/s)
  // The dialog is a Modal, not a div dressed as one.
  assert.match(section, /<Modal\n/)
  // And no surface draws its own mask/elevation to fake a dialog.
  assert.doesNotMatch(section, /dshar_(mask|dialog|overlay)/)
  // Both destructive flows open one: the pending delete/prune confirmation and
  // the trash actions. A page-inline confirm block would be the second shape
  // this page used to carry.
  assert.ok((section.match(/<Modal\n/gu) ?? []).length >= 2)
  // That block is gone, with the role and the button row it hand-drew: the
  // primitive owns the dialog role, the mask, the focus trap and its actions.
  assert.doesNotMatch(section, /dshar_confirm(Actions)?"/)
  assert.doesNotMatch(section, /role="alertdialog"/)
})

test('no client surface opens a native dialog', () => {
  for (const path of allSources()) {
    const text = readFileSync(path, 'utf8')
    assert.doesNotMatch(text, /window\.(alert|confirm|prompt)\s*\(/u, `${path} uses a native dialog`)
    assert.doesNotMatch(text, /[^.\w](alert|confirm|prompt)\s*\(/u, `${path} calls a native dialog`)
  }
})

test('user-visible copy of this page lives only in the plugin dictionary', () => {
  // The dictionary is the one place Han characters may sit. `client.ts` already
  // carries two Han words in comments from an earlier round, so the scan covers
  // the surfaces whose TEXT a user reads — the page, its stylesheet, and the
  // host halves that must send codes rather than sentences.
  for (const relative of ['client/archives-section.tsx', 'client/styles.ts', 'routes.ts', 'types.ts', 'trash.ts']) {
    const offenders = source(relative).match(/[\p{Script=Han}]/gu) ?? []
    assert.deepEqual(offenders, [], `${relative} holds user-visible copy outside the dictionary`)
  }
})

test('the new inputs are the host controls, not hand-drawn ones', () => {
  const section = source('client/archives-section.tsx')
  // A checkbox and a switch come from the primitives package for the same reason a
  // dialog does: focus, keyboard and label semantics are the primitive's.
  assert.match(section, /import \{[^}]*\bCheckbox\b[^}]*\} from '@deepseek-ai\/dsh-client-ui-primitives'/s)
  assert.match(section, /import \{[^}]*\bSwitch\b[^}]*\} from '@deepseek-ai\/dsh-client-ui-primitives'/s)
  // No hand-rolled checkmark or slider either.
  assert.doesNotMatch(section, /type="checkbox"/)
})

test('stopFirst travels with the delete request, and only when it was ticked', () => {
  const section = source('client/archives-section.tsx')
  // The host refuses a non-boolean, and an always-present `false` would read as a
  // decision the user never made.
  assert.match(section, /stopFirst \? \{ stopFirst: true \} : \{\}/)
  // ... and the delete dialog carries the checkbox that sets it, through the
  // primitive, with the sentence that says what ticking it changes.
  assert.match(section, /archives\.confirm\.stopFirst'/)
  assert.match(section, /archives\.confirm\.stopFirstHint/)
  assert.match(section, /<Checkbox\n\s*checked=\{stopFirst\}/)
})

test('the batch and sweep confirmations are the modal, with their counts', () => {
  const section = source('client/archives-section.tsx')
  // Every irreversible action the page grew in this round opens the modal: the
  // batch purge and the retention sweep name their counts, sessions and bytes.
  assert.match(section, /'purgeMany'/)
  assert.match(section, /'sweep'/)
  assert.match(section, /archives\.trash\.confirm\.bulkBody/)
  assert.match(section, /archives\.retention\.confirm\.body/)
})

test('a transient result is announced through the host toast primitive', () => {
  const section = source('client/archives-section.tsx')
  // The same rule the dialogs follow: an announcement is `Toast`, and a banner of
  // this page's own would get the tokens right and the fade, layering and portal
  // wrong.
  assert.match(section, /import \{[^}]*\bToast\b[^}]*\} from '@deepseek-ai\/dsh-client-ui-primitives'/s)
  assert.match(section, /<Toast\n/)
  assert.doesNotMatch(section, /dshar_(toast|banner)/)
  // A repeated sentence has to replay, or the second show inherits the first
  // one's nearly-elapsed hold and vanishes before it can be read.
  assert.match(section, /key=\{toast\.seq\}/)
  // A result carrying skipped ids or a warning holds long enough to be read; one
  // reporting clean work uses the announcement default.
  assert.match(section, /const TOAST_READ_HOLD_MS = 8000/)
  assert.match(section, /const TOAST_HOLD_MS = 3000/)
  assert.match(section, /holdMs=\{toast\.tone === 'warn' \? TOAST_READ_HOLD_MS : TOAST_HOLD_MS\}/)
  // The delete sentence keeps the control that leads to the panel it points at.
  assert.match(section, /archives\.notice\.action\.viewTrash/)
  assert.match(section, /viewTrash: true/)
  // A CONDITION the page is in is NOT a banner: it stays inline, because a banner
  // that clears itself reads as the condition clearing with it.
  assert.match(section, /archives\.retention\.malformed/)
  assert.match(section, /dshar_notice dshar_noticeWarn/)
})

test('a skipped id renders the sessions it was about and the host diagnostic', () => {
  const section = source('client/archives-section.tsx')
  // Both fields were carried by the host and dropped on the floor: a counted reason
  // does not say WHICH sessions a tree refusal covered, and `detail` is the only
  // place a stop failure's own message appears.
  assert.match(section, /archives\.notice\.skippedSessions/)
  assert.match(section, /archives\.notice\.skippedDetail/)
  assert.match(section, /skip\.sessions !== undefined/)
  assert.match(section, /skip\.detail !== undefined/)
})

test('a destructive PRIMARY button paints a red fill, not red text on a dark one', () => {
  const section = source('client/archives-section.tsx')
  const styles = source('client/styles.ts')
  // Measured on the shipped panel: `variant="primary"` brings the dark fill and the
  // white foreground, and `dshar_btnDanger` only overrides `color` — so the two
  // together rendered dark-fill-plus-red-text, which is neither danger idiom and
  // reads as a broken control beside every other button in the dialog.
  assert.doesNotMatch(section, /variant="primary"\s*\n\s*className="dshar_btnDanger"/)
  // The confirm action of empty/purge IS a primary, and it gets its own seat.
  assert.match(section, /className="dshar_dangerPrimary"/)
  // That seat moves the primitive's own fill tokens, so the primitive still decides
  // the foreground and the shape — overriding `background` would be a redraw.
  assert.match(styles, /\.dshar_dangerPrimary\s*\{/)
  assert.match(styles, /--dsw-alias-button-primary-fill:\s*var\(--dsw-alias-state-error-primary/)
  // `dshar_btnDanger` stays the OUTLINE idiom (red text, no fill) and is never
  // paired with a primary variant.
  assert.match(styles, /\.dshar_btnDanger\s*\{\s*\n\s*color:/)
})
