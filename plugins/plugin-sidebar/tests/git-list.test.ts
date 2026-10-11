/**
 * The git face's list presentation, pinned: the grouping depth and the row
 * label are the two rules that decide whether the tree reads correctly, and
 * both are pure functions the panel calls rather than re-derives.
 *
 * @module plugin-sidebar/tests/git-list
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { groupByTopDir, rowPathOf } from '../src/client/git-list.ts'

/** The only slice these helpers read. */
const at = (path: string): { readonly path: string } => ({ path })

describe('groupByTopDir', () => {
  it('groups by the FIRST segment only, keeping each group in input order', () => {
    const groups = groupByTopDir([
      at('src/client/panel.tsx'),
      at('docs/README.md'),
      at('src/host.ts'),
      at('docs/guide/x.md'),
    ])
    assert.deepEqual(groups.map(group => group.key), ['docs', 'src'])
    assert.deepEqual(groups[0]!.files.map(file => file.path), ['docs/README.md', 'docs/guide/x.md'])
    // A deeper path stays inside its first segment: the tree is one level.
    assert.deepEqual(groups[1]!.files.map(file => file.path), ['src/client/panel.tsx', 'src/host.ts'])
  })

  it('sorts root entries last, under the empty key', () => {
    const groups = groupByTopDir([at('README.md'), at('src/a.ts'), at('package.json')])
    assert.deepEqual(groups.map(group => group.key), ['src', ''])
    assert.deepEqual(groups[1]!.files.map(file => file.path), ['README.md', 'package.json'])
  })

  it('answers an empty list for no entries, and one group for a single directory', () => {
    assert.deepEqual(groupByTopDir([]), [])
    const one = groupByTopDir([at('src/a.ts'), at('src/b.ts')])
    assert.equal(one.length, 1)
    assert.equal(one[0]!.key, 'src')
  })
})

describe('rowPathOf', () => {
  it('drops the group prefix the header already names', () => {
    assert.equal(rowPathOf('src/client/panel.tsx', 'src'), 'client/panel.tsx')
    assert.equal(rowPathOf('src/host.ts', 'src'), 'host.ts')
  })

  it('keeps the full path for a root row', () => {
    assert.equal(rowPathOf('README.md', ''), 'README.md')
  })

  it('never slices a path that does not carry the group prefix', () => {
    // Defensive: a caller pairing a row with the wrong group gets the path
    // back rather than a truncated lie.
    assert.equal(rowPathOf('docs/a.md', 'src'), 'docs/a.md')
    // `src-extra/` is not `src/`: the boundary is the separator, not the text.
    assert.equal(rowPathOf('src-extra/a.ts', 'src'), 'src-extra/a.ts')
  })

  it('round-trips with the grouping: a labelled row never repeats its folder', () => {
    const entries = [at('src/client/panel.tsx'), at('src/host.ts'), at('docs/a.md'), at('README.md')]
    for (const group of groupByTopDir(entries)) {
      for (const file of group.files) {
        const label = rowPathOf(file.path, group.key)
        if (group.key !== '') {
          assert.equal(label.startsWith(`${group.key}/`), false, `${file.path} under ${group.key}`)
          assert.equal(`${group.key}/${label}`, file.path)
        }
      }
    }
  })
})
