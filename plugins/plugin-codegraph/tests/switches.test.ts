/**
 * The environment switches, as pure functions, and the one contract that ties
 * them to the page: every switch whose behaviour is wired has a sentence in both
 * dictionaries, or the settings page would render a row with nothing to say.
 *
 * @module plugin-codegraph/tests/switches
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { SWITCH_ENV, WIRED_SWITCHES, readSwitches, switchIsOn } from '../src/switches.ts'
import { en, zh } from '../src/client/locales.ts'

describe('switchIsOn', () => {
  it('is on unless the variable says 0 or false', () => {
    assert.equal(switchIsOn({}, 'DSH_APP_CODEGRAPH_SOURCE'), true, 'absent is on')
    assert.equal(switchIsOn({ DSH_APP_CODEGRAPH_SOURCE: '' }, 'DSH_APP_CODEGRAPH_SOURCE'), true, 'empty is on')
    assert.equal(switchIsOn({ DSH_APP_CODEGRAPH_SOURCE: '0' }, 'DSH_APP_CODEGRAPH_SOURCE'), false)
    assert.equal(switchIsOn({ DSH_APP_CODEGRAPH_SOURCE: 'false' }, 'DSH_APP_CODEGRAPH_SOURCE'), false)
    // A typo in a variable meant to switch something OFF leaves the default on —
    // and a typo in one meant to switch something ON cannot switch it off.
    assert.equal(switchIsOn({ DSH_APP_CODEGRAPH_SOURCE: 'no' }, 'DSH_APP_CODEGRAPH_SOURCE'), true)
  })
})

describe('readSwitches', () => {
  it('reads each switch from the environment it is given, independently', () => {
    const state = readSwitches({ [SWITCH_ENV.prefetch]: '0', [SWITCH_ENV.source]: 'false' })
    assert.deepEqual(state, { prefetch: false, grepNote: true, source: false })
  })
})

describe('the wired switches and the dictionary', () => {
  it('every wired switch has its sentence in both languages', () => {
    assert.ok(WIRED_SWITCHES.includes('source'), 'the source switch gates the reader that already exists')
    for (const id of WIRED_SWITCHES) {
      const key = `codegraph.switches.${id}`
      assert.ok(key in en, `${key} is in the English table`)
      assert.ok(key in zh, `${key} is in the Chinese table`)
    }
  })

  it('names a distinct variable for each switch', () => {
    const names = Object.values(SWITCH_ENV)
    assert.equal(new Set(names).size, names.length)
    for (const name of names) assert.match(name, /^DSH_APP_CODEGRAPH_[A-Z_]+$/u)
  })
})
