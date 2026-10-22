/**
 * The git face's list presentation, pinned: the tree's depth, its single-child
 * compaction and its row labels are the rules that decide whether a deep path
 * reads as a hierarchy or as one long string, and all of them are pure
 * functions the panel calls rather than re-derives.
 *
 * @module plugin-sidebar/tests/git-list
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { buildPathTree } from '../src/client/git-list.ts'
import { diffRulerMarks, diffRulerScrollTop, parseDiffRows } from '../src/client/diff-ruler.ts'

/** The only slice these helpers read. */
const at = (path: string): { readonly path: string } => ({ path })

describe('buildPathTree', () => {
  it('nests by EVERY segment, not just the first', () => {
    const tree = buildPathTree([at('src/client/panel.tsx')])
    const src = tree.dirs[0]
    // `src` holds exactly one subdirectory and no file of its own, so the
    // chain compacts — the point of the next case. The depth is what matters
    // here: the file is NOT a child of `src` alone.
    assert.equal(src?.name, 'src/client')
    assert.equal(src?.path, 'src/client')
    assert.equal(src?.dirs.length, 0)
    assert.deepEqual(src?.files.map(file => file.name), ['panel.tsx'])
  })

  it('compacts a single-child chain into one header', () => {
    const tree = buildPathTree([at('apps/api/src/modules/agent/tools/detail.tool.ts')])
    assert.equal(tree.dirs.length, 1)
    assert.equal(tree.dirs[0]?.name, 'apps/api/src/modules/agent/tools')
    assert.equal(tree.dirs[0]?.path, 'apps/api/src/modules/agent/tools')
    assert.deepEqual(tree.dirs[0]?.files.map(file => file.name), ['detail.tool.ts'])
  })

  it('stops compacting where a second child appears', () => {
    const tree = buildPathTree([
      at('apps/api/src/modules/agent/tools/a.ts'),
      at('apps/api/src/modules/agent/service.ts'),
    ])
    const agent = tree.dirs[0]
    assert.equal(agent?.name, 'apps/api/src/modules/agent')
    // Two children now: the directory `tools/` and the file `service.ts`.
    assert.deepEqual(agent?.dirs.map(dir => dir.name), ['tools'])
    assert.deepEqual(agent?.files.map(file => file.name), ['service.ts'])
  })

  it('keeps sibling directories apart and sorts them by name', () => {
    const tree = buildPathTree([at('src/b/two.ts'), at('src/a/one.ts'), at('docs/x.md')])
    assert.deepEqual(tree.dirs.map(dir => dir.name), ['docs', 'src'])
    assert.deepEqual(tree.dirs[1]?.dirs.map(dir => dir.name), ['a', 'b'])
  })

  it('counts every file at or below a header', () => {
    const tree = buildPathTree([
      at('src/a/one.ts'),
      at('src/b/two.ts'),
      at('src/b/three.ts'),
    ])
    assert.equal(tree.dirs[0]?.fileCount, 3)
    assert.equal(tree.dirs[0]?.dirs.find(dir => dir.name === 'b')?.fileCount, 2)
  })

  it('puts root files beside the directories, sorted', () => {
    const tree = buildPathTree([at('README.md'), at('src/a.ts'), at('package.json')])
    assert.deepEqual(tree.dirs.map(dir => dir.name), ['src'])
    assert.deepEqual(tree.files.map(file => file.name), ['README.md', 'package.json'])
    // A root file keeps its own name — there is no header above it.
    assert.equal(tree.files[0]?.path, 'README.md')
  })

  it('carries the whole path on every leaf, so a row can still be requested', () => {
    const tree = buildPathTree([at('apps/api/src/x.ts')])
    const leaf = tree.dirs[0]?.files[0]
    assert.equal(leaf?.name, 'x.ts')
    assert.equal(leaf?.path, 'apps/api/src/x.ts')
  })

  it('answers an empty tree for no entries and skips a pathless one', () => {
    assert.deepEqual(buildPathTree([]), { dirs: [], files: [] })
    assert.deepEqual(buildPathTree([at('')]), { dirs: [], files: [] })
  })

  it('never renders a row whose label repeats its own folder', () => {
    const entries = [
      at('apps/api/src/modules/agent/tools/detail.tool.ts'),
      at('apps/api/src/modules/agent/service.ts'),
      at('README.md'),
    ]
    const walk = (dir: { name: string, dirs: readonly unknown[], files: readonly { name: string, path: string }[] }): void => {
      for (const file of dir.files) {
        assert.equal(file.name.includes('/'), false, `${file.path} renders as ${file.name}`)
        assert.equal(file.path.endsWith(`/${file.name}`) || file.path === file.name, true, file.path)
      }
      for (const child of dir.dirs) walk(child as never)
    }
    walk(buildPathTree(entries) as never)
  })
})

describe('diffRulerMarks', () => {
  const lines = (...kinds: ('add' | 'del' | 'context' | 'meta')[]) => kinds.map(kind => ({ kind }))

  it('merges a run of adjacent changed lines into ONE mark', () => {
    const marks = diffRulerMarks(lines('context', 'add', 'add', 'add', 'context'))
    assert.equal(marks.length, 1)
    assert.deepEqual(marks[0], { kind: 'add', from: 1, to: 3, top: 0.2, span: 0.6 })
  })

  it('splits a mark where the kind changes', () => {
    const marks = diffRulerMarks(lines('del', 'del', 'add', 'add'))
    assert.deepEqual(marks.map(mark => [mark.kind, mark.from, mark.to]), [['del', 0, 1], ['add', 2, 3]])
  })

  it('does NOT merge across unchanged lines', () => {
    // add at 0, one context line, add at 2: two marks. The old rule merged
    // these into one covering 0..2, which painted the unchanged line as
    // changed and made a small scattered edit read as a long band.
    const marks = diffRulerMarks(lines('add', 'context', 'add'))
    assert.equal(marks.length, 2)
    assert.deepEqual(marks.map(mark => [mark.from, mark.to]), [[0, 0], [2, 2]])
  })

  it('paints no more than the lines that actually changed', () => {
    // The fact the user sees: two three-line runs with three unchanged lines
    // between them. The painted fraction must total 6/12 changed lines, not
    // the 9/12 the merge rule reported.
    const rows = [
      'add', 'add', 'add',
      'context', 'context', 'context',
      'add', 'add', 'add',
      'context', 'context', 'context',
    ] as const
    const marks = diffRulerMarks(lines(...rows))
    const changed = rows.filter(kind => kind === 'add' || kind === 'del').length
    const painted = marks.reduce((sum, mark) => sum + mark.span, 0)
    assert.equal(marks.length, 2)
    assert.equal(painted, changed / rows.length,
      'the marks together must cover exactly the changed lines and no gap')
  })

  it('keeps every mark inside its own run', () => {
    // No mark may span a context line: the gap between two marks IS the gap
    // between two edits, which is what the ruler exists to show.
    const rows = ['add', 'add', 'context', 'context', 'del', 'del'] as const
    const marks = diffRulerMarks(lines(...rows))
    assert.deepEqual(marks.map(mark => [mark.kind, mark.from, mark.to]), [['add', 0, 1], ['del', 4, 5]])
    for (const mark of marks) {
      for (let index = mark.from; index <= mark.to; index += 1) {
        assert.equal(rows[index], mark.kind, `row ${index} is '${rows[index]}', not part of a '${mark.kind}' mark`)
      }
    }
  })

  it('keeps distant runs apart', () => {
    const far = diffRulerMarks(lines('add', 'context', 'context', 'context', 'context', 'context', 'add'))
    assert.equal(far.length, 2)
    assert.deepEqual(far.map(mark => [mark.from, mark.to]), [[0, 0], [6, 6]])
  })

  it('counts hunk headers toward the document, so a mark never drifts', () => {
    // Four rows, the mark on the last one: top is 3/4, not 1/3.
    const marks = diffRulerMarks(lines('meta', 'context', 'context', 'add'))
    assert.equal(marks[0]?.top, 0.75)
    assert.equal(marks[0]?.span, 0.25)
  })

  it('answers no marks when nothing changed', () => {
    assert.deepEqual(diffRulerMarks([]), [])
    assert.deepEqual(diffRulerMarks(lines('meta', 'context', 'context')), [])
  })
})

describe('diffRulerScrollTop', () => {
  const mark = { kind: 'add' as const, from: 50, to: 51, top: 0.5, span: 0.02 }

  it('maps the mark fraction onto the real scroll range', () => {
    assert.equal(diffRulerScrollTop(mark, 2000, 500), 750)
  })

  it('answers 0 when there is nothing to scroll', () => {
    assert.equal(diffRulerScrollTop(mark, 400, 500), 0)
    assert.equal(diffRulerScrollTop(mark, 500, 500), 0)
  })

  it('reaches the very end for a mark at the bottom', () => {
    const last = { ...mark, top: 1 }
    assert.equal(diffRulerScrollTop(last, 2000, 500), 1500)
  })
})

/**
 * The ruler against a REAL `git diff`, end to end through the parser.
 *
 * The suites above feed `diffRulerMarks` a hand-written array of kinds, which is
 * how a rule that merged across unchanged lines survived review: nothing in a
 * kind array distinguishes "three lines apart" from "adjacent", so the gap the
 * rule destroyed was never in the input. These cases start from the text the
 * host actually hands the renderer (`git diff --no-ext-diff --no-color`), so the
 * gap is real and the painted total is checkable against the changed lines.
 */
describe('parseDiffRows + diffRulerMarks over a real git diff', () => {
  /**
   * A diff with the shape that exposed the bug: one hunk, three separate edit
   * runs, and unchanged lines between them. Captured from `git diff` on a real
   * file rather than composed by hand.
   */
  const REAL = [
    'diff --git a/src/WirelessBatteryTray/AutoStart.cs b/src/WirelessBatteryTray/AutoStart.cs',
    'index 2171cae..4a2a9c1 100644',
    '--- a/src/WirelessBatteryTray/AutoStart.cs',
    '+++ b/src/WirelessBatteryTray/AutoStart.cs',
    '@@ -2,13 +2,21 @@ using Microsoft.Win32;',
    ' ',
    ' namespace WirelessBatteryTray',
    ' {',
    '+    // Moved to a scheduled task; the Run key stays readable for old installs.',
    '     internal static class AutoStart',
    '     {',
    '+        const string RunKeyPath = @"Software\\Microsoft\\Windows\\CurrentVersion\\Run";',
    '+',
    '+        public static bool IsEnabled()',
    '+        {',
    '+            using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath);',
    '+            return key?.GetValue(ValueName) != null;',
    '+        }',
    '+',
    '         public static void SetEnabled(bool enabled)',
    '         {',
    '-            using var key = Registry.CurrentUser.CreateSubKey(RunKeyPath, writable: true);',
    '-            if (enabled) key.SetValue(ValueName, BuildCommand());',
    '-            else key.DeleteValue(ValueName, throwOnMissingValue: false);',
    '+            if (enabled) CreateTask();',
    '+            else DeleteTask();',
    '         }',
    '     }',
    ' }',
    '',
  ].join('\n')

  it('reads the file headers as meta, not as a one-line deletion and addition', () => {
    // `--- a/x` and `+++ b/x` both start with a sign character. Without the
    // header rule they become a del and an add, which is a change that does not
    // exist — and it lands at the very top of the ruler, where it is most
    // visible.
    const rows = parseDiffRows(REAL)
    assert.equal(rows[2]?.kind, 'meta')
    assert.equal(rows[3]?.kind, 'meta')
  })

  it('paints exactly the changed lines, with the gaps left as gaps', () => {
    const rows = parseDiffRows(REAL)
    const marks = diffRulerMarks(rows)
    const changed = rows.filter(row => row.kind === 'add' || row.kind === 'del').length
    const painted = marks.reduce((sum, mark) => sum + mark.span, 0)

    // 30 rows (git's diff ends with a trailing newline, which is a row here),
    // 14 of them changed. The merge rule this replaced painted 60% and drew one
    // 53.3% bar covering rows 8..23 — the two unchanged rows at 19-20 were
    // swallowed into it, which is what the screenshot showed.
    assert.equal(rows.length, 30)
    assert.equal(changed, 14)
    assert.equal(marks.length, 4, 'four separate edit runs, not two merged bars')
    assert.deepEqual(marks.map(mark => [mark.from, mark.to]), [[8, 8], [11, 18], [21, 23], [24, 25]])
    assert.ok(Math.abs(painted - changed / rows.length) < 1e-9,
      `marks cover ${String(painted)} of the document; the changed lines are ${String(changed / rows.length)}`)
  })

  it('leaves every mark on lines that really changed', () => {
    const rows = parseDiffRows(REAL)
    const marks = diffRulerMarks(rows)
    for (const mark of marks) {
      for (let index = mark.from; index <= mark.to; index += 1) {
        assert.equal(rows[index]?.kind, mark.kind,
          `row ${String(index)} is '${String(rows[index]?.kind)}' but sits inside a '${mark.kind}' mark`)
      }
    }
    // The two unchanged rows the old rule swallowed must stay uncovered.
    for (const index of [19, 20]) {
      assert.ok(marks.every(mark => index < mark.from || index > mark.to),
        `row ${String(index)} did not change and must not be painted`)
    }
  })
})

