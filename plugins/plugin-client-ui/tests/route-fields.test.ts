/**
 * The route-parameter vocabulary, pinned.
 *
 * Three rules carry real risk and are what these tests exist for:
 *
 *   1. **Only touched keys are written.** A save that emitted every managed key
 *      would rewrite fields the user never opened from a possibly stale view.
 *   2. **A cleared field becomes an `unset`**, which is what restores the
 *      inherited value — writing `undefined` or an empty string instead would
 *      leave an override that says nothing.
 *   3. **A draft that does not parse is refused, never coerced.** A credential
 *      reference outside the grammar and a negative timeout must both fail the
 *      field, because the namespace validator would refuse the write anyway and
 *      the user deserves to hear it before the round trip.
 *
 * @module plugin-client-ui/tests/route-fields
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  MANAGED_ROUTE_KEYS, managedSubset, overriddenKeys, parseCredentialRef, parseDurationMs,
  parseEnumChoice, parseRatio, routeOps,
} from '../src/client/models-advanced/route-fields.ts'

describe('parseCredentialRef', () => {
  it('accepts a bare environment variable name', () => {
    assert.equal(parseCredentialRef('DEEPSEEK_API_KEY'), 'DEEPSEEK_API_KEY')
    assert.equal(parseCredentialRef('  _my_key2 '), '_my_key2')
  })

  it('treats empty as "inherit" and anything outside the grammar as invalid', () => {
    assert.equal(parseCredentialRef(''), undefined)
    assert.equal(parseCredentialRef('   '), undefined)
    // The kernel's reference grammar is a bare name: no $ENV: form, no dashes.
    assert.equal(parseCredentialRef('$ENV:FOO'), null)
    assert.equal(parseCredentialRef('MY-KEY'), null)
    assert.equal(parseCredentialRef('2KEY'), null)
    assert.equal(parseCredentialRef('MY KEY'), null)
  })
})

describe('parseDurationMs', () => {
  it('accepts positive integers only', () => {
    assert.equal(parseDurationMs('60000'), 60000)
    assert.equal(parseDurationMs(' 1 '), 1)
  })

  it('treats empty as "inherit" and everything else as invalid', () => {
    assert.equal(parseDurationMs(''), undefined)
    assert.equal(parseDurationMs('0'), Number.NaN, 'a zero timeout is not a timeout')
    assert.equal(parseDurationMs('-1'), Number.NaN)
    assert.equal(parseDurationMs('1.5'), Number.NaN)
    assert.equal(parseDurationMs('60s'), Number.NaN)
  })
})

describe('parseRatio', () => {
  it('accepts 0..1 only', () => {
    assert.equal(parseRatio('0'), 0)
    assert.equal(parseRatio('0.25'), 0.25)
    assert.equal(parseRatio('1'), 1)
    assert.equal(parseRatio(''), undefined)
  })

  it('refuses anything outside the range or unparseable', () => {
    assert.equal(parseRatio('1.5'), Number.NaN)
    assert.equal(parseRatio('-0.1'), Number.NaN)
    assert.equal(parseRatio('half'), Number.NaN)
  })
})

describe('parseEnumChoice', () => {
  it('matches an accepted value, empty means inherit', () => {
    assert.equal(parseEnumChoice('sse', ['auto', 'sse']), 'sse')
    assert.equal(parseEnumChoice('', ['auto', 'sse']), undefined)
  })

  it('refuses a value outside the list', () => {
    assert.equal(parseEnumChoice('http2', ['auto', 'sse']), null)
  })
})

describe('routeOps', () => {
  const path = ['providers', 'my-gateway']

  it('writes only the touched keys, addressed inside the profile', () => {
    const ops = routeOps(path, { timeoutMs: 30_000, cacheRetention: 'short' }, new Set(['timeoutMs']))
    assert.deepEqual(ops, [{ op: 'set', path: ['providers', 'my-gateway', 'timeoutMs'], value: 30_000 }])
  })

  it('turns a cleared key into an unset, which restores the inherited value', () => {
    const ops = routeOps(path, {}, new Set(['timeoutMs']))
    assert.deepEqual(ops, [{ op: 'unset', path: ['providers', 'my-gateway', 'timeoutMs'] }])
  })

  it('writes nothing when nothing was touched', () => {
    assert.deepEqual(routeOps(path, { timeoutMs: 1 }, new Set()), [])
  })

  it('never emits a key outside the managed set', () => {
    const ops = routeOps(path, { chatTemplateKwargs: { a: 1 } }, new Set(['chatTemplateKwargs']))
    assert.deepEqual(ops, [], 'a hand-written escape hatch must survive a save')
    assert.ok(!(MANAGED_ROUTE_KEYS as readonly string[]).includes('chatTemplateKwargs'))
  })

  it('emits a structured key whole, as a JSON object', () => {
    const ops = routeOps(path, { thinkingBudgets: { low: 1024 } }, new Set(['thinkingBudgets']))
    assert.deepEqual(ops, [{
      op: 'set',
      path: ['providers', 'my-gateway', 'thinkingBudgets'],
      value: { low: 1024 },
    }])
  })
})

describe('managedSubset', () => {
  it('keeps the managed keys of a profile and drops everything else', () => {
    const draft = managedSubset({
      apiKeyEnv: 'MY_KEY', timeoutMs: 1000, chatTemplateKwargs: { a: 1 }, models: [],
    })
    assert.deepEqual(draft, { apiKeyEnv: 'MY_KEY', timeoutMs: 1000 })
  })

  it('answers an empty draft for a missing profile', () => {
    assert.deepEqual(managedSubset(undefined), {})
    assert.deepEqual(managedSubset(null), {})
  })
})

describe('overriddenKeys', () => {
  it('reads the keys the user layer actually carries', () => {
    const profile = { timeoutMs: 5000, headers: { a: 'b' } }
    assert.deepEqual([...overriddenKeys(profile)].sort(), ['headers', 'timeoutMs'])
  })

  it('ignores keys this card does not manage', () => {
    assert.deepEqual([...overriddenKeys({ models: [], displayName: 'X' })], [])
  })

  it('answers nothing for a missing or malformed profile', () => {
    assert.deepEqual([...overriddenKeys(undefined)], [])
    assert.deepEqual([...overriddenKeys('nope')], [])
    assert.deepEqual([...overriddenKeys([])], [])
  })
})

