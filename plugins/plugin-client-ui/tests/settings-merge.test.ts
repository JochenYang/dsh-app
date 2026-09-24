// One slot, two compilations, no shared package.
//
// The merged 维护 section is declared by THIS plugin's client entry (the
// `children` table of its `settings.section` register call) and registered into
// by plugin-presets. Both need the `settings.dsh-app-maintenance.tab` entry in
// their own `SlotMap`: the owner declares it from its copy, and the contributor's
// `inject`/`register` call is type-checked against its copy. A drift in ONE copy
// therefore compiles — the two are separate programs — and fails only at runtime,
// as an undeclared slot or a thrown registration. The copies are pinned identical
// here so that failure mode cannot ship.
//
// A THIRD copy (plugin-usage) used to carry the block as a tab contributor. The
// usage page is its own rail section now, so that copy is gone and plugin-usage
// declares no maintenance slot at all — which this test asserts, because a stale
// copy left behind would keep the file looking like a contributor.
//
// Line endings are normalized before the comparison: git stores every one of
// the three files with LF, but `core.autocrlf` hands a checkout CRLF for the
// files it has re-written and LF for the ones it has not, so equal CONTENT can
// reach this test with different endings.
//
// Paths resolve against the bundled test's own location (`<plugin>/.test-dist/`,
// see scripts/test.mjs), so they hold from any working directory.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

/** The block's sentinels, and the slot it declares. */
const START = '// BEGIN maintenance-tab-slot'
const END = '// END maintenance-tab-slot'
const SLOT = 'settings.dsh-app-maintenance.tab'

/** The two client entries carrying the block, keyed by the half they belong to. */
function copies(): Record<string, string> {
  const files = {
    'plugin-client-ui (the section owner)': new URL('../src/client.ts', import.meta.url),
    'plugin-presets': new URL('../../plugin-presets/src/client.ts', import.meta.url),
  }
  const found: Record<string, string> = {}
  for (const [name, url] of Object.entries(files)) {
    const text = readFileSync(url, 'utf8')
    const from = text.indexOf(START)
    const to = text.indexOf(END)
    assert.ok(from !== -1 && to > from, `${name} carries no ${START} … ${END} block`)
    found[name] = text.slice(from, to + END.length).replace(/\r\n/gu, '\n')
  }
  return found
}

describe('maintenance tab slot', () => {
  it('declares the same augmentation in both client entries, line for line', () => {
    const found = copies()
    const names = Object.keys(found)
    for (const name of names.slice(1)) {
      assert.equal(
        found[name],
        found[names[0]],
        `${name}'s copy of the ${SLOT} augmentation differs from ${names[0]}'s`,
      )
    }
  })

  it('declares a root-level list slot and names no other slot', () => {
    const block = copies()['plugin-client-ui (the section owner)']
    assert.match(block, new RegExp(`'${SLOT}': \\{`))
    assert.match(block, /kind: 'list'/)
    assert.match(block, /scope: 'root'/)
    // One child key per file: a second one here would be a second slot nobody
    // declares or renders.
    assert.equal(block.match(/'settings\.[a-z.-]+'/gu)?.length, 1)
  })

  it('plugin-usage carries no copy: it is a rail section, not a tab', () => {
    const text = readFileSync(new URL('../../plugin-usage/src/client.ts', import.meta.url), 'utf8')
    // A stale block here would type-check its own file and look like a
    // contributor, while the section owner no longer has a strip entry for it.
    assert.equal(text.indexOf(START), -1, 'plugin-usage still carries the maintenance tab block')
    assert.ok(
      !text.includes(`'${SLOT}'`),
      'plugin-usage still names the maintenance tab slot',
    )
    // And it registers a section of its own instead.
    assert.match(text, /ctx\.slots\.register\(\{\s*\n\s*name: 'settings\.section'/u)
  })
})
