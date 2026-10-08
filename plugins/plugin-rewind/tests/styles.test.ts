/**
 * Tests for the injected stylesheet's load-bearing rules.
 *
 * The per-message icon is invisible by default and revealed on hover, so the
 * reveal selector is behaviour, not decoration: it was written once as
 * `.dshRewind-iconRow:hover`, which never fired because that row sits BELOW the
 * bubble — hovering the message left the pointer outside it. These tests pin the
 * selector to the chat flow item, which is what the user actually hovers.
 *
 * The stylesheet is read from source rather than from the bundle so a rule that
 * the minifier drops is still caught here.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(
  fileURLToPath(new URL('../src/client/styles.ts', import.meta.url)),
  'utf8',
)

test('the icon reveal keys off the chat flow item, not the icon row', () => {
  // The user hovers the message; the flow item wraps both the bubble and the
  // icon row, so it is the only element whose :hover the pointer reliably hits.
  assert.match(source, /\[data-chat-flow-kind="user"\]:hover\s+\.dshRewind-iconRow/)
  assert.match(source, /\[data-chat-flow-kind="steering"\]:hover\s+\.dshRewind-iconRow/)
})

test('the reveal no longer depends on hovering the icon row itself', () => {
  assert.doesNotMatch(source, /\.dshRewind-iconRow:hover/)
})

test('the icon row is positioned onto the actions line, not stacked below it', () => {
  // Appending a plain sibling after the bubble produced a second row under the
  // built-in actions. The icon must be absolutely positioned instead, over the
  // message block, and the block must be its containing block.
  const row = source.slice(source.indexOf('.dshRewind-iconRow {'), source.indexOf('.dshRewind-iconAction {'))
  assert.match(row, /position:\s*absolute/)
  assert.match(source, /\[data-chat-flow-kind="user"\],\s*\n\[data-chat-flow-kind="steering"\]\s*\{\s*\n\s*position:\s*relative/)
})

test('the space for the icon is made on the built-in actions row itself', () => {
  // The row that must shift left is the built-in actions line, identified by its
  // stable `data-clock` attribute. An earlier version used a structural
  // `> :first-child > :last-child` selector, which matched the ICON ROW instead
  // and pushed the icon onto the time label.
  assert.match(source, /\[data-chat-flow-kind="user"\] \[data-clock="start"\]\s*\{\s*\n\s*margin-right/)
  assert.doesNotMatch(source, /> :first-child > :last-child/)
})

test('the icon stays reachable without hover, and on focus', () => {
  // A touch device has no hover; keyboard users need it on focus.
  assert.match(source, /@media \(hover: none\)/)
  assert.match(source, /\.dshRewind-iconRow:focus-within/)
})

test('the note is the host Toast, not a hand-rolled overlay', () => {  // The outcome note went through two wrong shapes before this: inside the icon
  // row (where display:none hid it with the turn it reported on), then a
  // body-level div with plugin CSS (right tokens, wrong placement, layering,
  // fade and dismissal). The host ships `Toast` for exactly this, and the kernel's
  // own refusal banner uses it anchored at the composer card.
  const host = readFileSync(
    fileURLToPath(new URL('../src/client/recall-note-host.tsx', import.meta.url)),
    'utf8',
  )
  assert.match(host, /import \{ IconWarningOutlineRegular, Toast \} from '@deepseek-ai\/dsh-client-ui-primitives'/)
  assert.match(host, /<Toast/)
  // Anchored where the kernel anchors its own refusal, so it lands beside the
  // input box rather than over it.
  assert.match(host, /anchor=\{noteAnchor\(\)\}/)
  assert.match(host, /noteAnchor/)
  const note = readFileSync(
    fileURLToPath(new URL('../src/client/recall-note.ts', import.meta.url)),
    'utf8',
  )
  assert.match(note, /COMPOSER_CARD_SELECTOR = 'div\[data-composer-card\]'/)
  // A sentence a user must READ gets the kernel's refusal hold, not the 3s default.
  assert.match(note, /NOTE_HOLD_MS = 8_000/)
  // And no plugin CSS draws the toast surface.
  assert.doesNotMatch(source, /\.dshRewind-note\s*\{/)
})

test('the stylesheet carries no backtick inside its template literal', () => {
  // The CSS is a backtick literal; an embedded backtick silently truncates it.
  // This has now bitten THREE times, every time inside a comment.
  //
  // The first version of this test took the first backtick after the opening one
  // as the literal's end — which is the offending character itself, so the scan
  // stopped exactly where the damage was and always passed. It is anchored on the
  // NEXT code instead: everything between the opening backtick and the line that
  // follows the literal is the literal, and it must contain no backtick at all.
  const open = source.indexOf('const cssText = `')
  assert.notEqual(open, -1, 'cssText literal not found')
  const after = source.indexOf('\n/** Inject the stylesheet once per document. */', open)
  assert.notEqual(after, -1, 'the literal is not followed by the injectStyles doc block')
  const literal = source.slice(open + 'const cssText = `'.length, after)
  const lines = literal.split('\n')
  // The literal's own CLOSING backtick is a line of its own, and there may be a
  // blank line after it. Find that line and check everything BEFORE it — the
  // check is for a backtick INSIDE the literal, so the terminator is the
  // boundary, not a suspect.
  const closing = lines.lastIndexOf('`')
  assert.notEqual(closing, -1, 'cssText is not closed before the next declaration')
  const body = lines.slice(0, closing)
  const offenders = body
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.includes('`'))
  assert.deepEqual(
    offenders,
    [],
    `backtick(s) inside cssText at line(s): ${offenders.map((o) => o.index).join(', ')} — an embedded one truncates the literal`,
  )
  assert.ok(body.join('\n').includes('.dshRewind-iconAction'), 'cssText looks truncated')
})

test('the stylesheet only uses theme tokens for colour', () => {
  const body = source.slice(source.indexOf('const cssText = `'))
  const hex = body.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
  assert.deepEqual(hex, [], `literal colours found: ${hex.join(', ')}`)
})
