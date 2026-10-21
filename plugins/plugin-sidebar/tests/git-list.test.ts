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
import { diffRulerMarks, diffRulerScrollTop } from '../src/client/diff-ruler.ts'

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

  it('merges runs separated by a short gap, keeping the FIRST run kind', () => {
    // add at 0, one context line, add at 2: closer than MIN_GAP, so one mark.
    const marks = diffRulerMarks(lines('add', 'context', 'add'))
    assert.equal(marks.length, 1)
    assert.deepEqual([marks[0]?.kind, marks[0]?.from, marks[0]?.to], ['add', 0, 2])
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
