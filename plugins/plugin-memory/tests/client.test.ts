/**
 * The client half's contract, checked against its SOURCE.
 *
 * There is no DOM in this suite, so the page cannot be rendered and clicked;
 * what can be pinned is what a render would be built from. Three things went
 * wrong here before and were only caught on a real machine, so each has a test:
 *
 *   - the confirmation drew its own mask, card and buttons (U2). It is the
 *     host's `Modal` + `Button` now, the CANCEL button holds the initial focus,
 *     and the stylesheet carries no frame of its own;
 *   - a kernel package the client imports was missing from `dsh.client.inject`
 *     (esbuild marks it external, so nothing else on the packaging path can
 *     see it);
 *   - copy drifted between the two dictionaries, or pointed at a surface that
 *     no longer exists (U3). The pair is typed, but a placeholder that differs
 *     between zh and en, a route code the host answers and no dictionary
 *     renders, and a mapping for a code the host never sends are all invisible
 *     to the type gate.
 *
 * @module @dsh-app/plugin-memory/tests/client
 */

import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { en, zh } from '../src/client/locales.ts'

/**
 * Read one source file, with CRLF normalised: this checkout is CRLF on
 * Windows and CI's is LF, and a multi-line slice must mean the same in both.
 * @param relative - path from this test file.
 * @returns the file's text.
 */
function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8').replace(/\r\n/gu, '\n')
}

/** The client half's shipped sources: the entry file and everything under client/. */
function clientSources(): { file: string, text: string }[] {
  const clientDir = fileURLToPath(new URL('../src/client/', import.meta.url))
  const files = ['../src/client.ts', ...readdirSync(clientDir).map(name => `../src/client/${name}`)]
  return files
    .filter(file => /\.tsx?$/u.test(file))
    .map(file => ({ file, text: source(file) }))
}

/** The `{name}` placeholders in one sentence. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{([a-z][a-zA-Z0-9_]*)\}/gu)].map(match => match[1]!).sort()
}

test('the confirmation composes the host primitives instead of redrawing them', () => {
  // The hand-rolled frame had the alias tokens right and the composition
  // wrong: it looked subtly off in both themes and drifted from every other
  // dialog in the suite. Modal and Button are the host's own — mask, blur,
  // elevation, close affordance, Escape, mask click, the Tab trap and the
  // return of focus all come with them.
  const dialog = source('../src/client/confirm-dialog.tsx')
  assert.match(dialog, /import \{ Button, Modal \} from '@deepseek-ai\/dsh-client-ui-primitives'/)
  assert.match(dialog, /<Modal\b/)
  assert.match(dialog, /<Button\b/)
  // No portal, no dialog role and no frame class of its own.
  assert.doesNotMatch(dialog, /createPortal/)
  assert.doesNotMatch(dialog, /aria-modal/)
  const styles = source('../src/client/styles.ts')
  assert.doesNotMatch(styles, /\.dshm_(mask|dialogCard|dialogTitle|dialogMessage|dialogActions)/)
  for (const { file, text } of clientSources()) {
    assert.doesNotMatch(text, /dshm_(mask|dialogCard|dialogTitle|dialogMessage|dialogActions)/u, `${file} still uses a frame class`)
  }
})

test('the cancel button holds the initial focus, and the destructive one never does', () => {
  // The hand-rolled dialog put React `autoFocus` on the DELETE button: Enter on
  // a dialog opened from the keyboard deleted the card. `data-modal-autofocus`
  // is the primitive's documented seat (React autoFocus runs before the modal
  // layer can capture the invoking control, which return focus needs).
  const dialog = source('../src/client/confirm-dialog.tsx')
  const outline = dialog.indexOf('variant="outline"')
  const primary = dialog.indexOf('variant="primary"')
  assert.ok(outline !== -1 && primary !== -1 && outline < primary, 'cancel is rendered before confirm')
  const cancel = dialog.slice(outline, primary)
  const confirm = dialog.slice(primary)
  assert.match(cancel, /data-modal-autofocus=/)
  assert.match(cancel, /onClick=\{onClose\}/)
  assert.doesNotMatch(confirm, /data-modal-autofocus/)
  assert.match(confirm, /onClick=\{onConfirm\}/)
  // The JSX attribute, specifically: `autoFocus` inside a comment (this
  // dialog's header explains why it is not used) is not a usage.
  const attribute = /[\s<]autoFocus(?=[\s=>/]|\/>)/u
  for (const { file, text } of clientSources()) {
    assert.doesNotMatch(text, attribute, `${file} uses React autoFocus`)
  }
})

test('every kernel package the client imports at runtime is declared in dsh.client.inject', () => {
  // esbuild marks `@deepseek-ai/*` external: the composed loader answers the
  // specifier at runtime from the packages the manifest injects. A missing
  // entry compiles, bundles and fails in the renderer. Type-only imports are
  // erased and need no entry.
  const manifest = JSON.parse(source('../package.json')) as { dsh: { client: { inject: string[] } } }
  const injected = new Set(manifest.dsh.client.inject)
  const runtime = /^import (?!type\b)(?:\{[^}]*\}|\w+) from '(@deepseek-ai\/[^']+)'/gmu
  const missing: string[] = []
  let seen = 0
  for (const { file, text } of clientSources()) {
    for (const match of text.matchAll(runtime)) {
      seen += 1
      if (!injected.has(match[1]!)) missing.push(`${file} -> ${match[1]}`)
    }
  }
  assert.ok(seen > 0, 'no runtime kernel import found; this check would pass vacuously')
  assert.deepEqual(missing, [])
})

test('the two dictionaries cover the same keys, each with a non-empty sentence', () => {
  // Typed by `MemoryKey`, but the pair is only as good at runtime as it is at
  // compile time: a blank sentence renders a blank row in one language only.
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  for (const [key, value] of Object.entries(en)) {
    assert.equal(typeof value, 'string', `${key} is not a string`)
    assert.ok(value.trim().length > 0, `${key} is empty in en`)
  }
  for (const [key, value] of Object.entries(zh)) {
    assert.ok(value.trim().length > 0, `${key} is empty in zh`)
  }
})

test('the two dictionaries interpolate the same names', () => {
  // A `{count}` in zh and a `{n}` in en leaves a literal brace on screen: the
  // runtime keeps a placeholder it has no value for.
  for (const key of Object.keys(en) as (keyof typeof en)[]) {
    assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), `${key} interpolates different names in zh and en`)
  }
})

test('the delete confirmation says the card can be restored, and quotes nothing it is not given', () => {
  // A card delete archives a copy first (a delete whose copy cannot be written
  // is refused), so "cannot be undone" was false; and the move-overwrite
  // message quoted a `{summary}` no call site supplies — it rendered as a
  // literal brace.
  for (const dict of [zh, en]) {
    assert.match(dict['memory.confirm.forgetMessage'], /\{days\}/u)
    assert.match(dict['memory.confirm.forgetMessage'], dict === zh ? /恢复/u : /restored/iu)
    assert.doesNotMatch(dict['memory.confirm.forgetMessage'], /不可恢复|cannot be undone/iu)
    assert.doesNotMatch(dict['memory.confirm.moveOverwriteMessage'], /\{summary\}/u)
    // The copy must not point at the ledger panel: it has none on this page.
    assert.doesNotMatch(dict['memory.notice.curateRefused'], dict === zh ? /最近整理记录/u : /see the ledger/iu)
  }
})

test('every refusal the routes can answer has copy, and no mapping points at a code the host never sends', () => {
  // The host sends a code, the client owns the sentence. A code with no
  // mapping falls back to the host's English diagnostic — the wrong language
  // for this page; a mapping for a code that does not exist is dead copy.
  const section = source('../src/client/memory-section.tsx')
  const routes = source('../src/routes.ts')
  const mapped = [...section.matchAll(/'(route\.[A-Za-z]+)': t\('([^']+)'/gu)]
  assert.ok(mapped.length > 0, 'no route mapping found; this check would pass vacuously')
  for (const [, code, key] of mapped) {
    assert.ok(routes.includes(`'${code}'`), `${code} is mapped but the host never sends it`)
    assert.ok(key! in zh && key! in en, `${code} maps to ${key}, which is not in both dictionaries`)
  }
  const answered = [...new Set([...routes.matchAll(/code: '(route\.[A-Za-z]+)'/gu)].map(match => match[1]!))]
  for (const code of answered) {
    assert.ok(mapped.some(([, mappedCode]) => mappedCode === code), `the host answers ${code} and the page has no copy for it`)
  }
})
