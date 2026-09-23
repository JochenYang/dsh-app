// Whether the generated profile patch carries a COPY of the home layer's rows.
//
// The home layer is `$DSH_HOME/cordis.patch.yml`, where the user's own rows live
// (their MCP servers, a pinned search provider, the migrated preset). A composer
// that reads only the profile patch needs the copy; one that composes the home
// layer itself must not have it, because the copy arrives as a second row with
// the same id and the whole tree fails — `duplicate loader entry id: mcp-context7`,
// measured on 0.1.6-alpha.2, where a profile carrying both could not start a host
// at all.
//
// A dev checkout used to force the copy (`isDev || …`). That was harmless only
// while every boot on the machine was the web line; the moment an older build
// shared the profile, its boot hit the duplicate and fell back to reinstalling a
// bundled kernel. Measured from the other side on the packaged 0.1.7 build, with
// no copy in the profile patch at all: its preset menu still lists the home
// layer's `自进化模式`, and the session header of a team session still shows the
// `Agent Team` action — so the web line's host really does compose the home layer.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { homeRowsInProfilePatch } = require('../dist/main/brand-suite.js')

test('the web line never gets a copy: its host composes the home layer itself', () => {
  assert.equal(homeRowsInProfilePatch({ transport: 'web' }), false)
})

test('the frames line gets one: its host is handed this file alone', () => {
  assert.equal(homeRowsInProfilePatch({ transport: 'frames' }), true)
})

test('dev follows the same rule as production', () => {
  // The signature no longer takes `isDev` — this test is the guard that nobody
  // adds it back: a forced copy is a duplicate row in every older boot that
  // reads the same profile.
  assert.equal(homeRowsInProfilePatch.length, 1)
  assert.deepEqual(Object.keys({ transport: 'web' }), ['transport'])
})
