/**
 * Profile-patch toggle tests: the managed disable block's generation, removal,
 * idempotency, byte-level preservation of everything the plugin does not own,
 * and the id whitelist that keeps YAML injection impossible. Uses real-format
 * sample patch files (user comments, hand-written disables, insert blocks,
 * CRLF variants) in a temp directory.
 *
 * @module plugin-market/tests/toggle
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MarketValidationError } from '../src/errors.ts'
import {
  applyDisableToggle,
  disabledIdsOf,
  insertedEntryIdOf,
  toggleManagedDisable,
  ENTRY_ID_PATTERN,
  MANAGED_BLOCK_FOOTER,
  MANAGED_BLOCK_HEADER,
} from '../src/patchfile.ts'

/** A sample with the real file's three ingredients: comments, a hand-written disable, an insert block. */
const REAL_SAMPLE = `# []
- id: usage-heatmap
  disabled: true
# 2026-09-03 记录:某插件 0.6.1 实测可正常加载,保持启用。
# ── some MCP client (installed by setup; undo with setup --remove) ─
- insert:
    - id: agent-comm-hub
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        # 不要用 agent-hub：会与动态挂载的同名 serverName 冲突
        serverName: agent-comm-hub
        transport: streamable-http
        url: http://127.0.0.1:18764/mcp
`

describe('applyDisableToggle (disable)', () => {
  it('creates a marker block on an empty document (file absent)', () => {
    const next = applyDisableToggle('', 'dsh-context', false)
    assert.equal(next, `${MANAGED_BLOCK_HEADER}\n- id: dsh-context\n  disabled: true\n${MANAGED_BLOCK_FOOTER}\n`)
    assert.deepEqual([...disabledIdsOf(next)], ['dsh-context'])
  })

  it('quotes a scoped id, because a bare `@` is a reserved YAML indicator', () => {
    // Measured consequence of NOT quoting: `- id: @deepseek-ai/dsh-tool-session-query`
    // made the whole patch unparseable ("bad indentation of a mapping entry"), the
    // kernel child died on it, and neither the installed app nor a dev run could
    // start until that one line was quoted by hand.
    const next = applyDisableToggle('', '@deepseek-ai/dsh-tool-session-query', false)
    assert.match(next, /- id: "@deepseek-ai\/dsh-tool-session-query"\n/u)
    // The reader must still recognise the id — quotes are syntax, not part of it —
    // or a toggle would stop seeing its own row and write a duplicate.
    assert.deepEqual([...disabledIdsOf(next)], ['@deepseek-ai/dsh-tool-session-query'])
    // Removing it leaves the kernel's empty-patch template, not a zero-byte file
    // (an empty document is not valid YAML) — same as the unquoted path.
    assert.equal(applyDisableToggle(next, '@deepseek-ai/dsh-tool-session-query', true), '[]\n')
  })

  it('appends the block after existing content byte-for-byte', () => {
    const next = applyDisableToggle(REAL_SAMPLE, 'dsh-context', false)
    assert.ok(next.startsWith(REAL_SAMPLE), 'existing content must be untouched')
    assert.ok(next.endsWith(`${MANAGED_BLOCK_HEADER}\n- id: dsh-context\n  disabled: true\n${MANAGED_BLOCK_FOOTER}\n`))
    assert.deepEqual([...disabledIdsOf(next)].sort(), ['dsh-context', 'usage-heatmap'])
  })

  it('appends with CRLF when the file uses CRLF', () => {
    const crlfSample = REAL_SAMPLE.replace(/\n/g, '\r\n')
    const next = applyDisableToggle(crlfSample, 'dsh-context', false)
    assert.ok(next.includes(`- id: dsh-context\r\n  disabled: true\r\n`))
    assert.ok(next.startsWith(crlfSample))
  })

  it('is idempotent: an existing row returns the input unchanged', () => {
    const once = applyDisableToggle(REAL_SAMPLE, 'usage-heatmap', false)
    // usage-heatmap is already disabled by the user's own row — no second row.
    assert.equal(once, REAL_SAMPLE)
  })

  it('completes an unterminated block instead of duplicating the header', () => {
    const truncated = `${REAL_SAMPLE}${MANAGED_BLOCK_HEADER}\n- id: other\n  disabled: true\n`
    const next = applyDisableToggle(truncated, 'dsh-context', false)
    assert.equal(next.split(MANAGED_BLOCK_HEADER).length, 2)
    assert.ok(next.endsWith(`${MANAGED_BLOCK_FOOTER}\n`))
    assert.deepEqual([...disabledIdsOf(next)].sort(), ['dsh-context', 'other', 'usage-heatmap'])
  })

  it('rejects ids outside the whitelist', () => {
    assert.throws(() => applyDisableToggle('', 'a\nb', false), MarketValidationError)
  })
})

describe('applyDisableToggle (enable)', () => {
  it('removes only the target row and keeps the rest of the block', () => {
    const disabled = applyDisableToggle(REAL_SAMPLE, 'dsh-context', false)
    const disabledMore = applyDisableToggle(disabled, 'dsh-other', false)
    const enabled = applyDisableToggle(disabledMore, 'dsh-context', true)
    assert.deepEqual([...disabledIdsOf(enabled)].sort(), ['dsh-other', 'usage-heatmap'])
    // Round trip back to the two-row state, then to the original bytes.
    const restored = applyDisableToggle(enabled, 'dsh-other', true)
    assert.equal(restored, REAL_SAMPLE)
  })

  it('removes the whole block when the last managed row goes', () => {
    const disabled = applyDisableToggle(REAL_SAMPLE, 'dsh-context', false)
    const enabled = applyDisableToggle(disabled, 'dsh-context', true)
    assert.equal(enabled, REAL_SAMPLE)
    assert.equal(disabledIdsOf(enabled).size, 1) // the user's own row survives
  })

  it('anchors a comment-only file with [] but keeps the comments (they are user content)', () => {
    const commentsOnly = '# 我的笔记\n\n'
    const disabled = applyDisableToggle(commentsOnly, 'dsh-context', false)
    const enabled = applyDisableToggle(disabled, 'dsh-context', true)
    assert.equal(enabled, '# 我的笔记\n\n[]\n')
    // A managed block whose rows all go away with nothing else around still
    // collapses to the bare canonical array (the boot rejects non-array docs).
    const blockOnly = `${MANAGED_BLOCK_HEADER}\n- id: x\n  disabled: true\n${MANAGED_BLOCK_FOOTER}\n`
    assert.equal(applyDisableToggle(blockOnly, 'x', true), '[]\n')
  })

  it('is a no-op when the block or the row is absent', () => {
    assert.equal(applyDisableToggle(REAL_SAMPLE, 'dsh-context', true), REAL_SAMPLE)
    assert.equal(applyDisableToggle('', 'dsh-context', true), '')
  })

  it('preserves a hand-written disable row outside the block', () => {
    const disabled = applyDisableToggle(REAL_SAMPLE, 'dsh-context', false)
    const enabled = applyDisableToggle(disabled, 'usage-heatmap', true)
    // Enabling a user-authored row is a no-op (the block row for it never
    // existed); the managed row for dsh-context still holds.
    assert.equal(enabled, disabled)
    assert.deepEqual([...disabledIdsOf(enabled)].sort(), ['dsh-context', 'usage-heatmap'])
  })
})

describe('toggleManagedDisable (file level)', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-market-toggle-'))
    path = join(dir, 'profiles', 'web', 'cordis.patch.yml')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('creates the profile directory and file on disable', () => {
    assert.equal(existsSync(path), false)
    assert.deepEqual(toggleManagedDisable(path, 'dsh-context', false), { changed: true, foreign: false })
    assert.deepEqual([...disabledIdsOf(readFileSync(path, 'utf8'))], ['dsh-context'])
  })

  it('enabling without a file is a no-op that creates nothing', () => {
    assert.deepEqual(toggleManagedDisable(path, 'dsh-context', true), { changed: false, foreign: false })
    assert.equal(existsSync(path), false)
  })

  it('round trips through the real sample and restores the original bytes', () => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, REAL_SAMPLE, 'utf8')
    toggleManagedDisable(path, 'dsh-context', false)
    toggleManagedDisable(path, 'dsh-other', false)
    toggleManagedDisable(path, 'dsh-context', true)
    toggleManagedDisable(path, 'dsh-other', true)
    assert.equal(readFileSync(path, 'utf8'), REAL_SAMPLE)
  })

  it('is idempotent at the file level (second disable writes nothing)', () => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, REAL_SAMPLE, 'utf8')
    assert.deepEqual(toggleManagedDisable(path, 'dsh-context', false), { changed: true, foreign: false })
    assert.deepEqual(toggleManagedDisable(path, 'dsh-context', false), { changed: false, foreign: false })
    assert.deepEqual(toggleManagedDisable(path, 'dsh-context', true), { changed: true, foreign: false })
    assert.deepEqual(toggleManagedDisable(path, 'dsh-context', true), { changed: false, foreign: false })
    assert.equal(readFileSync(path, 'utf8'), REAL_SAMPLE)
  })
})

describe('disabledIdsOf (read heuristics)', () => {
  it('does not count nested insert rows or plain name mappings as disables', () => {
    const ids = disabledIdsOf(REAL_SAMPLE)
    assert.deepEqual([...ids], ['usage-heatmap'])
  })

  it('recognizes quoted ids and ignores non-true disabled values', () => {
    const text = "- id: 'a'\n  disabled: true\n- id: b\n  disabled: false\n- id: c\n  enabled: true\n"
    assert.deepEqual([...disabledIdsOf(text)], ['a'])
  })
})

describe('insertedEntryIdOf (bundle-patch id lookup)', () => {
  it('reads the insert row matching the package name', () => {
    assert.equal(insertedEntryIdOf(REAL_SAMPLE, 'agent-comm-hub'), undefined)
    const patch = "# bundle patch\n- insert:\n    - id: usage-heatmap\n      name: dsh-usage-heatmap\n      config:\n        storePath: \"\"\n"
    assert.equal(insertedEntryIdOf(patch, 'dsh-usage-heatmap'), 'usage-heatmap')
  })

  it('answers undefined for unquoted mismatches and missing rows', () => {
    const patch = "- insert:\n    - id: other-entry\n      name: other-package\n"
    assert.equal(insertedEntryIdOf(patch, 'dsh-usage-heatmap'), undefined)
    assert.equal(insertedEntryIdOf('{}\n', 'anything'), undefined)
  })
})

describe('ENTRY_ID_PATTERN (injection fence)', () => {
  it('admits the shapes real entry ids use', () => {
    for (const id of ['usage-heatmap', 'dsh-better-edit', 'agent-comm-hub', '@scope/pkg-name', 'a'.repeat(120)]) {
      assert.equal(ENTRY_ID_PATTERN.test(id), true, id)
    }
  })

  it('rejects anything that could break out of the `- id: <id>` row', () => {
    for (const id of ['', 'a\nb', 'a b', 'a:b', "a'b", 'a"b', 'a#b', 'a #b', '~', '*', 'a*b', '&a', '!a', '-a', '.a', '@', 'a\n  disabled: true', `${'a'.repeat(121)}`]) {
      assert.equal(ENTRY_ID_PATTERN.test(id), false, JSON.stringify(id))
    }
  })
})
