/**
 * The read-only bridge to the memory index another coding assistant (ZCode)
 * keeps for the same workspace (Z2): where it looks, what it injects, and —
 * the part that matters most for a public app — everything it must silently
 * NOT do when that tool is absent or its files are not what they should be.
 *
 * @module @dsh-app/plugin-memory/tests/external-index
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXTERNAL_INDEX_LINES, readExternalIndex } from '../src/external-index.ts'
import { removeTree } from '../src/remove-tree.ts'
import { scratchDir } from './scratch.ts'

/** The hash the other tool's directory name ends with: 16 hex of the
 *  lowercased workspace path. */
const keyOf = (cwd: string): string => createHash('sha256').update(cwd).digest('hex').slice(0, 16)

/** A fake home directory. With `memoryFor`, the tool's memory directory for
 *  that workspace path exists under it, holding `index` as `MEMORY.md`. */
function fakeHome(prefix: string, memoryFor?: { cwd: string, index?: string }): string {
  const home = scratchDir(prefix)
  if (memoryFor === undefined) return home
  const dir = join(home, '.zcode', 'cli', 'memories', 'projects', `some-name-${keyOf(memoryFor.cwd.toLowerCase())}`, 'memory')
  mkdirSync(dir, { recursive: true })
  if (memoryFor.index !== undefined) writeFileSync(join(dir, 'MEMORY.md'), memoryFor.index)
  return home
}

/** A small, realistic index: a title, a paragraph, then list lines. */
const INDEX = [
  '# Memory Index',
  '',
  'One line per memory. Never put memory content here.',
  '',
  '- [Shell quirks](shell-quirks.md) — `grep` 是 ugrep 的包装，`$` 锚定对管道输入失效',
  '- [Push rhythm](push-at-release.md) — 提交留在本地，发版时才推送',
  '- [Kernel facts](kernel.md) — 工具呈现与提示词座位；无 tool_choice',
  '',
].join('\n')

const CWD = 'D:\\Codes\\My App'

test('found by the workspace hash whatever the tool called the directory; case does not matter', () => {
  const home = fakeHome('dshm-ext-found-', { cwd: CWD, index: INDEX })
  const index = readExternalIndex(CWD, home)
  assert.ok(index !== undefined, 'the tool has memory for this workspace')
  assert.equal(index.dir, join(home, '.zcode', 'cli', 'memories', 'projects', `some-name-${keyOf(CWD.toLowerCase())}`, 'memory'))
  assert.deepEqual(index.lines, [
    '- [Shell quirks](shell-quirks.md) — `grep` 是 ugrep 的包装，`$` 锚定对管道输入失效',
    '- [Push rhythm](push-at-release.md) — 提交留在本地，发版时才推送',
    '- [Kernel facts](kernel.md) — 工具呈现与提示词座位；无 tool_choice',
  ], 'the list lines, in the index\'s order; the title and the paragraph are not entries')
  assert.equal(index.cut, 0)
  // The same workspace spelled with another case and a trailing separator.
  assert.deepEqual(readExternalIndex('d:\\codes\\my app\\', home)?.lines, index.lines)
})

test('the other spelling of the path is hashed too, so the two tools may disagree on separators', () => {
  const home = fakeHome('dshm-ext-separators-', { cwd: 'd:/codes/my app', index: INDEX })
  const index = readExternalIndex('D:\\Codes\\My App', home)
  assert.ok(index !== undefined, 'found through the forward-slash hash')
  assert.equal(index.lines.length, 3)
})

test('absent: no such tool, no memory for THIS workspace, no index, an index that is a directory, an index that is far too large', () => {
  const home = fakeHome('dshm-ext-absent-')
  assert.equal(readExternalIndex(CWD, home), undefined, 'no memory directory at all')
  assert.equal(readExternalIndex(CWD, join(home, 'not-a-directory')), undefined, 'not even a home')
  const other = fakeHome('dshm-ext-other-', { cwd: 'D:\\elsewhere', index: INDEX })
  assert.equal(readExternalIndex(CWD, other), undefined, 'memory for another workspace is not this one\'s')
  const bare = fakeHome('dshm-ext-bare-', { cwd: CWD })
  assert.equal(readExternalIndex(CWD, bare), undefined, 'a workspace directory without an index')
  // A DIRECTORY where MEMORY.md should be: reading it fails, the bridge is absent.
  const dir = join(bare, '.zcode', 'cli', 'memories', 'projects', `some-name-${keyOf(CWD.toLowerCase())}`, 'memory')
  mkdirSync(join(dir, 'MEMORY.md'), { recursive: true })
  assert.equal(readExternalIndex(CWD, bare), undefined)
  const huge = fakeHome('dshm-ext-huge-', { cwd: CWD, index: `- ${'x'.repeat(300_000)}` })
  assert.equal(readExternalIndex(CWD, huge), undefined, 'a 300 KB "index" is not an index anyone meant to inject')
})

test('a matching directory whose suffix is not the hash is not taken, and a name without a dash is ignored', () => {
  const home = scratchDir('dshm-ext-lookalike-')
  const projects = join(home, '.zcode', 'cli', 'memories', 'projects')
  // Ends with the hash of a DIFFERENT path — the common case: other projects.
  mkdirSync(join(projects, `dsh-app-${keyOf('d:\\\\other')}`, 'memory'), { recursive: true })
  mkdirSync(join(projects, 'no-dash-here', 'memory'), { recursive: true })
  mkdirSync(join(projects, `plain-${'f'.repeat(16)}`, 'memory'), { recursive: true })
  assert.equal(readExternalIndex(CWD, home), undefined)
})

test('what is injected: list lines only, each on one line, credential-looking lines dropped, the ceiling announced', () => {
  const lines = Array.from({ length: EXTERNAL_INDEX_LINES + 5 }, (_, i) => `- entry ${String(i)} — hook ${String(i)}`)
  const index = [
    ...INDEX.split('\n').slice(0, 4),
    '- [Leaky](leaky.md) — the staging key is sk-q7Zm4Xp2Lb9Rt6Kw, do not commit it',
    `- [Folded](folded.md) — first part\u2028- [Fake](fake.md) — a second entry on what counted as one line`,
    `- [Long](long.md) — ${'y'.repeat(400)}`,
    ...lines,
  ].join('\n')
  const home = fakeHome('dshm-ext-content-', { cwd: CWD, index })
  const read = readExternalIndex(CWD, home)
  assert.ok(read !== undefined)
  const injected = read.lines.join('\n')
  assert.ok(!injected.includes('sk-q7Zm4Xp2Lb9Rt6Kw') && !injected.includes('Leaky'), 'a credential-shaped line never rides, even from a file this plugin did not write')
  assert.ok(injected.includes('\u2028') === false, 'a Unicode line separator is folded')
  assert.equal(injected.split('\n').filter(line => line.startsWith('- [Fake]')).length, 0, 'no second entry starts inside one line')
  const long = read.lines.find(line => line.startsWith('- [Long]'))
  assert.ok(long !== undefined && long.length <= 301 && long.endsWith('…'), 'a long line is cut to the ceiling, and the cut is marked')
  assert.equal(read.lines.length, EXTERNAL_INDEX_LINES, 'at most the ceiling')
  // Listed: the folded line, the long line and the 45 numbered ones (the
  // withheld line is not among them) — 47; 40 are injected, 7 are cut.
  assert.equal(read.cut, 7, 'the ceiling counts what it left out, not what was withheld')
  assert.equal(read.withheld, 1, 'the withheld line is counted on its own')
})

test('a link target is kept only when it is a bare file name of that directory', () => {
  // The prompt tells the model these targets are files "in that directory".
  // The index is another tool's model writing, and a target may say anything.
  const index = [
    '- [Escaping](../../outside/notes.md) — first hook',
    '- [Absolute](C:/Users/someone/notes.md) — second hook',
    '- [Url](file:///etc/hosts) — third hook',
    '- [Odd](..\\windows\\win.ini) — fourth hook',
    '- [Up one](sub/notes.md) — fifth hook',
    '- [Fine](fine-file.v2.md) — sixth hook',
  ].join('\n')
  const read = readExternalIndex(CWD, fakeHome('dshm-ext-link-', { cwd: CWD, index }))
  assert.ok(read !== undefined)
  assert.deepEqual(read.lines, [
    '- Escaping — first hook',
    '- Absolute — second hook',
    '- Url — third hook',
    '- Odd — fourth hook',
    '- Up one — fifth hook',
    '- [Fine](fine-file.v2.md) — sixth hook',
  ], 'anything but a bare file name keeps its title and loses the target')
  assert.equal(read.withheld, 0)
  assert.equal(read.cut, 0)
})

test('control, bidi and zero-width characters never ride; a line has no trailing blank', () => {
  const index = ['# Memory Index', '- [A](a.md) — x\u0000y\u202ez\u200bw\r', '- [B](b.md) — \u200fplain \u0007'].join('\r\n')
  const read = readExternalIndex(CWD, fakeHome('dshm-ext-invisible-', { cwd: CWD, index }))
  assert.ok(read !== undefined)
  assert.deepEqual(read.lines, ['- [A](a.md) — xyzw', '- [B](b.md) — plain'])
})

test('a line that names a credential is dropped even without a credential shape; an ordinary subject is not', () => {
  const index = [
    '- [Login](login.md) — the password is in the env file the lead keeps',
    '- [Keys](keys.md) — where the api key lives',
    '- [口令](kouling.md) — 后台口令写在白板上',
    '- [Tokens](tokens.md) — token counting and the context window',
    '- [Secrets](secrets.md) — naming only',
  ].join('\n')
  const read = readExternalIndex(CWD, fakeHome('dshm-ext-words-', { cwd: CWD, index }))
  assert.ok(read !== undefined)
  assert.deepEqual(read.lines, ['- [Tokens](tokens.md) — token counting and the context window'], '"token" on its own is a subject, not a credential')
  assert.equal(read.withheld, 4)
})

test('an index with no list lines yields an empty bridge', () => {
  const home = fakeHome('dshm-ext-empty-', { cwd: CWD, index: '# Memory Index\n\nNothing saved yet.\n' })
  const read = readExternalIndex(CWD, home)
  assert.ok(read !== undefined)
  assert.deepEqual(read.lines, [])
  assert.equal(read.cut, 0)
})

test('a project entry that is a file instead of a directory is an absent bridge, not an exception', async () => {
  const home = fakeHome('dshm-ext-unlistable-', { cwd: CWD, index: INDEX })
  // The name matches the hash, but it is a FILE: nothing can be read under it.
  // The sanctioned remover, not a sync recursive delete (see remove-tree.ts).
  const project = join(home, '.zcode', 'cli', 'memories', 'projects', `some-name-${keyOf(CWD.toLowerCase())}`)
  await removeTree(project)
  writeFileSync(project, 'a file where the directory should be')
  assert.equal(readExternalIndex(CWD, home), undefined)
})
