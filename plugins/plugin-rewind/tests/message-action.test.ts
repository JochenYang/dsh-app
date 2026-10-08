/**
 * Tests for the per-message icon's click path.
 *
 * The icon knew only the node's SEQUENCE, but the host command takes an
 * ORDINAL, and the resolution went through a root-context service lookup. That
 * lookup returned nothing usable in the page, so the icon rendered and did
 * nothing when clicked — the failure mode a user reports as "点击无效".
 *
 * The fix resolves the ordinal from the projection the component already
 * receives (the slot is session-scoped, so its standard kit carries
 * `sessionId` and `useProjection`), and the entry runs the command for THAT
 * session. These tests pin both halves.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const action = readFileSync(
  fileURLToPath(new URL('../src/client/message-action.tsx', import.meta.url)),
  'utf8',
)
const entry = readFileSync(
  fileURLToPath(new URL('../src/client.ts', import.meta.url)),
  'utf8',
)

test('the icon reads its session and projection from the slot props', () => {
  // The slot is session-scoped, so the standard kit supplies both. A
  // root-context lookup is the path that failed.
  assert.match(action, /props as \{ sessionId\?: unknown \}\)\.sessionId/)
  assert.match(action, /props as \{ useProjection\?:/)
  assert.match(action, /useProjection\('rewindAnchors'\)/)
})

test('the icon resolves the ordinal from the projection, not from the seq', () => {
  assert.match(action, /anchors\?\.find\(\(item\) => item\.seq === seq\)/)
  assert.match(action, /deps\.plan\(anchor\.n, sessionId\)/)
})

test('the icon PREVIEWS before it recalls', () => {
  // A recall rewrites files. Performing it on the click and reporting afterwards
  // asks the user to consent to something already done, so the click asks the
  // host what would happen and opens the confirmation instead.
  assert.match(action, /void deps\.plan\(anchor\.n, sessionId\)\.then\(\(planned\) => \{/)
  assert.match(action, /setPending\(\{ n: anchor\.n, sessionId, plan: planned\.plan \}\)/)
  assert.match(action, /<ConfirmDialog/)
  // The recall itself is wired to the dialog's confirm, not to the icon's click.
  assert.match(action, /onConfirm=\{\(\) => \{/)
  assert.match(action, /void deps\.recall\(target\.n, target\.sessionId\)/)
})

test('the icon is hidden when the node is not recallable', () => {
  // No anchor means the node is injected context, or already cut. Rendering a
  // button that cannot act is worse than rendering none.
  assert.match(action, /anchor !== undefined/)
})

test('the entry forwards the session id to the command', () => {
  // `t` travels too: the revert summary is built from the DICTIONARY, not from an
  // English literal — a hardcoded sentence showed up untranslated in a Chinese UI.
  assert.match(entry, /recallByOrdinal\(ctx, t, ordinal, sessionId as SessionId, handled\)/)
  assert.doesNotMatch(entry, /recallBySeq/)
})

test('one recall prefills once, even though both paths see it', () => {
  // The icon path prefills from the command RESULT; the same recall then lands
  // in the append feed as a `command/done`, and a second write reported
  // `the composer already holds text` on a recall that worked perfectly —
  // measured on a real machine against the FIRST message of a session, where
  // there is nothing else it could have been. The result's `sourceEventSeq`
  // names the placeholder the host appended, so it is the same id on both.
  assert.match(entry, /const handled = new Set<number>\(\)/)
  assert.match(entry, /if \(typeof outcome\.sourceEventSeq === 'number'\) handled\.add\(outcome\.sourceEventSeq\)/)
  assert.match(entry, /if \(typeof data\.sourceEventSeq === 'number' && handled\.has\(data\.sourceEventSeq\)\) continue/)
  // Claimed BEFORE the write, so the observer cannot win the race and write first.
  const claim = entry.indexOf('handled.add(outcome.sourceEventSeq)')
  const write = entry.indexOf('const blocked = prefillRecalled')
  assert.ok(claim !== -1 && write !== -1 && claim < write, 'the claim must precede the write')
})

test('a refused recall is visible, not silent', () => {
  // The icon hands the whole outcome back and reports it. A synthetic
  // `{ ok: false }` read as a dead button; the host's own reason ("the turn is
  // still running") is the difference between a refused recall and a broken one.
  assert.match(action, /void deps\.recall\(target\.n, target\.sessionId\)\.then\(\(outcome\) => \{/)
  // The overlay is handed a FINISHED sentence. Passing it `{code}` printed the
  // raw dictionary key (`rewind.host.busy`) with every param dropped.
  assert.match(action, /showRecallNote\(outcome\.note\)/)
  assert.match(action, /deps\.t\(outcome\.code, outcome\.params\)/)
  assert.doesNotMatch(action, /showRecallNote\(\{/)
})

test('the preview asks a command that cannot change anything', () => {
  // The plan is a separate verb (`/rewind plan <n>`), not a flag on the recall: a
  // preview that could change things is not a preview. Its refusals arrive as
  // codes and are turned into sentences where `t` lives.
  assert.match(entry, /function planRecall/)
  assert.match(entry, /remote\.execute\(sessionId, `\/rewind plan \$\{n\}`, \[\]\)/)
  assert.match(entry, /return \{ note: coded === undefined \? t\('rewind\.error\.unavailable'\) : t\(coded\.code, coded\.params\) \}/)
})

test('the observer prefills on the RECALL answer only, never on the preview', () => {
  // The plan payload carries the recalled text too, so the dialog can show what
  // is coming. Matching any successful command therefore wrote the message back
  // to the composer the moment the dialog OPENED — before the user confirmed
  // anything. Measured on a real machine.
  assert.match(entry, /if \(!data\.text\.includes\(`"\$\{RECALL_DONE_CODE\}"`\)\) continue/)
  assert.match(entry, /const RECALL_DONE_CODE = 'rewind\.host\.done'/)
})

test('the confirmation composes the host primitives instead of redrawing them', () => {
  // An earlier version drew its own mask, card, buttons AND a two-column "diff".
  // The tokens were right and the composition was not: it looked subtly wrong in
  // both themes and drifted from every other dialog in the suite. Modal, Button
  // and DiffBlock are the host's own; they bring the mask, blur, elevation, close
  // affordance, focus handling, Escape, the modal layer, and real line-level diff
  // marking.
  const dialog = readFileSync(
    fileURLToPath(new URL('../src/client/confirm-dialog.tsx', import.meta.url)),
    'utf8',
  )
  assert.match(dialog, /import \{ Button, DiffBlock, Modal \} from '@deepseek-ai\/dsh-client-ui-primitives'/)
  assert.match(dialog, /<Modal\b/)
  assert.match(dialog, /<Button\b/)
  assert.match(dialog, /<DiffBlock\b/)
  // No hand-rolled frame, and no hand-rolled diff panes.
  assert.doesNotMatch(dialog, /createPortal/)
  assert.doesNotMatch(dialog, /aria-modal/)
  assert.doesNotMatch(dialog, /className="dshRewind-dialog(Wrap|Card|Title|Message|Actions|Button)"/)
  assert.doesNotMatch(dialog, /dshRewind-diffPane/)
  // And the stylesheet carries no rules for a frame or a diff it no longer draws.
  const styles = readFileSync(
    fileURLToPath(new URL('../src/client/styles.ts', import.meta.url)),
    'utf8',
  )
  assert.doesNotMatch(styles, /\.dshRewind-dialog(Wrap|Card|Title|Message|Actions|Button)/)
  assert.doesNotMatch(styles, /\.dshRewind-(fileDiff|diffPane)/)
})

test('the dialog widens through the primitive seat, not by redrawing the frame', () => {
  // A diff needs room its 380px default does not give: a code line wraps three
  // times. The width goes through `Modal`'s own `className` prop, and the
  // selector is DOUBLED because the primitive's `.dialog` is an equal-specificity
  // single class — an equal rule would win or lose by stylesheet load order, which
  // is a race rather than a decision.
  const dialog = readFileSync(
    fileURLToPath(new URL('../src/client/confirm-dialog.tsx', import.meta.url)),
    'utf8',
  )
  const styles = readFileSync(
    fileURLToPath(new URL('../src/client/styles.ts', import.meta.url)),
    'utf8',
  )
  assert.match(dialog, /className="dshRewind-confirmDialog"/)
  assert.match(styles, /\.dshRewind-confirmDialog\.dshRewind-confirmDialog\s*\{/)
  assert.match(styles, /width:\s*min\(\d+px, 100%\)/)
})

test('the outcome note cannot be hidden by the turn it reports on', () => {
  // It rendered inside the icon row, which lives in the turn the recall just
  // hid: display:none took the note with it, in exactly the case it existed for.
  // The note now goes through the host's `Toast`, which portals to `document.body`
  // — outside every React tree and outside the hiding stylesheet's reach.
  const host = readFileSync(
    fileURLToPath(new URL('../src/client/recall-note-host.tsx', import.meta.url)),
    'utf8',
  )
  // The host mounts its own React root on the body: that is what puts it out of
  // reach, and it must be mounted ONCE (the wrapper runs per bubble).
  assert.match(host, /document\.body\.appendChild\(container\)/)
  assert.match(host, /createRoot\(container\)/)
  assert.match(entry, /ctx\.effect\(\(\) => mountRecallNoteHost\(\)/)
  assert.match(host, /console\.warn/)
  assert.doesNotMatch(action, /dshRewind-iconNote/)
})

test('a prefill that did not happen says so, even on a successful recall', () => {
  // The recall and the composer write are two steps, and only the second one is
  // invisible when it fails: the message leaves the transcript, nothing lands in
  // the composer, and nothing says why. `prefillRecalled` therefore returns a
  // reason instead of returning void, and the entry attaches it to the outcome.
  assert.match(entry, /const blocked = prefillRecalled\(ctx, target, outcome\.text\)/)
  assert.match(entry, /return \{ ok: true, note: `composer prefill skipped: \$\{blocked\}` \}/)
  assert.match(entry, /function prefillRecalled\(\s*ctx: ClientContext,\s*sessionId: SessionId,\s*raw: string \| undefined,\s*\): string \| undefined/)
})

test('the hiding stylesheet has a mount point that outlives any one entry point', () => {
  // It was first written inside the composer-dock control. When that control was
  // removed the stylesheet went with it, and every recall then left the recalled
  // bubbles fully visible while the host reported success. The hook must live in
  // its own module and be called by a component that is mounted for every user
  // bubble, which is the only surface guaranteed to exist when there is
  // something to hide.
  const hideTurns = readFileSync(
    fileURLToPath(new URL('../src/client/hide-turns.ts', import.meta.url)),
    'utf8',
  )
  assert.match(hideTurns, /export function useHiddenTurns/)
  assert.match(action, /useHiddenTurns\(view\?\.hiddenTurns\)/)
})

test('the hiding stylesheet is never emptied by a component unmounting', () => {
  // The hook runs once PER USER BUBBLE. A component-owned element cannot work:
  // React runs an effect's cleanup before the next effect, so a second bubble's
  // mount would blank what the first wrote, and any row scrolling away would
  // un-hide the whole transcript. The rules are a pure function of the projected
  // list, so the last writer is always right and no cleanup is correct.
  const hideTurns = readFileSync(
    fileURLToPath(new URL('../src/client/hide-turns.ts', import.meta.url)),
    'utf8',
  )
  const body = hideTurns.slice(hideTurns.indexOf('export function useHiddenTurns'))
  assert.doesNotMatch(body, /textContent = ''/)
  assert.match(body, /return undefined/)
  assert.match(hideTurns, /No cleanup on purpose/)
})

test('a typed /rewind prefills too, not only the icon path', () => {
  // A recall typed by hand runs entirely on the host, so the client never calls
  // the command and nothing prefills — while the host's success sentence
  // promises the composer either way. The observer makes both paths alike.
  assert.match(entry, /function observeTypedRecalls/)
  assert.match(entry, /if \(change\?\.kind !== 'append'\) return/)
  assert.match(entry, /if \(event\?\.type !== 'command\/done'\) continue/)
  // The initial snapshot already holds every earlier recall; reacting to it
  // would re-fill the composer on every page load.
  assert.match(entry, /Only APPENDED events are considered/)
})

test('the host answer is resolved to a code, not to pre-rendered prose', () => {
  // The entry has no `t` seat of its own, so it must hand the component a code
  // the component's dictionary renders — otherwise the sentence can never
  // follow a locale switch.
  assert.match(entry, /const coded = hostCode\(outcome\.text\)/)
  assert.doesNotMatch(entry, /hostMessage\(/)
})

test('the per-message tooltip is short', () => {
  // It sat under a message and wrapped to two lines; the picker button keeps
  // the long explanatory copy.
  const locales = readFileSync(
    fileURLToPath(new URL('../src/client/locales.ts', import.meta.url)),
    'utf8',
  )
  const hint = locales.match(/'rewind\.message\.action\.hint':\s*'([^']*)'/)
  assert.ok(hint, 'icon hint key not found')
  assert.ok(hint[1].length <= 12, `icon tooltip too long: ${hint[1]}`)
})
