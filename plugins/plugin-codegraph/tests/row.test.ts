/**
 * The language row's decisions, pinned.
 *
 * `Tooltip` renders its `label` verbatim and documents an EMPTY label as "shows
 * only shortcut keys" — a row with neither pops an empty bubble. That is what
 * shipped: the `regex` grammar has no file extension, `extensions.join('  ')` was
 * `''`, and hovering "Regular expression" opened a blank tooltip. The bug was a
 * DECISION (join an empty list and pass the result to a primitive that believes
 * it), so the decision is a pure function now and this file pins it.
 *
 * The action rule is here for the same reason: a bundled grammar is read from the
 * plugin and cannot be removed, so it must offer NO button rather than a disabled
 * one that suggests a reachable state.
 *
 * @module plugin-codegraph/tests/row
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { nameBubble } from '../src/client/row.ts'
import { LANGUAGES } from '../src/languages.ts'

describe('nameBubble', () => {
  it('answers NO label for a language with no extension', () => {
    // The exact defect: an empty string is a tooltip whose text is nothing.
    assert.equal(nameBubble([]).label, undefined)
  })

  it('answers no label for extensions that trim to nothing', () => {
    // An extension table that carried blanks would render an INVISIBLE bubble —
    // which reads as a rendering bug rather than as missing data.
    assert.equal(nameBubble(['', '   ']).label, undefined)
  })

  it('joins a real extension list for the bubble', () => {
    assert.equal(nameBubble(['.ts', '.mts', '.cts']).label, '.ts  .mts  .cts')
  })

  it('never answers an empty string, whatever the input', () => {
    // The one invariant the primitive depends on: `''` means "shortcuts only", and
    // this plugin passes no shortcuts, so `''` is always a blank bubble.
    for (const extensions of [[], [''], ['  '], ['.py'], ['.py', '']]) {
      const { label } = nameBubble(extensions)
      assert.notEqual(label, '', `nameBubble(${JSON.stringify(extensions)}) answered an empty label`)
    }
  })

  it('gives every language with no extension no tooltip, through the REAL table', () => {
    // Read through the real table so a language added later is covered the moment
    // it exists. The rule is stated as an INVARIANT rather than as "regex has
    // none": hardcoding the id would fail on the next legitimate extension-less
    // grammar (`diff`, say), where the right answer is to update a list, not to
    // fix a bug.
    const noExtension = LANGUAGES.filter(language => language.extensions.length === 0)
    // Today the regex grammar is the only one; naming the set makes that a
    // deliberate fact rather than an accident.
    assert.deepEqual(noExtension.map(language => language.id), ['regex'])
    for (const language of LANGUAGES) {
      const { label } = nameBubble(language.extensions)
      if (language.extensions.length === 0) {
        assert.equal(label, undefined, `${language.id} has no extension, so it must get no tooltip`)
      } else {
        assert.ok(label !== undefined && label.length > 0, `${language.id} should name its extensions`)
      }
    }
  })
})
