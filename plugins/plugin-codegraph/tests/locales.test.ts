/**
 * The client dictionary contract.
 *
 * A settings page with a missing translation is a silent half-answer: the key
 * resolves to nothing and the row renders blank in one language only. The pair is
 * typed by `CodegraphKey`, so a gap fails `tsc` — this suite covers what the type
 * cannot: that both tables are non-empty, that every value is a real sentence, and
 * that a placeholder in one language has a counterpart in the other. A `{count}`
 * in zh and a `{n}` in en renders one language with a literal brace.
 *
 * @module plugin-codegraph/tests/locales
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { NS, en, zh } from '../src/client/locales.ts'

/** The `{name}` placeholders in one string. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{([a-z][a-zA-Z0-9_]*)\}/gu)].map(match => match[1]!).sort()
}

describe('locale tables', () => {
  it('covers exactly the same keys in both languages', () => {
    const enKeys = Object.keys(en).sort()
    const zhKeys = Object.keys(zh).sort()
    assert.deepEqual(zhKeys, enKeys, 'a key in one table and not the other renders blank in that locale')
  })

  it('has a non-empty sentence for every key', () => {
    for (const [key, value] of Object.entries(en)) {
      assert.equal(typeof value, 'string', `${key} is not a string`)
      assert.ok(value.trim().length > 0, `${key} is empty in en`)
    }
    for (const [key, value] of Object.entries(zh)) {
      assert.ok(value.trim().length > 0, `${key} is empty in zh`)
    }
  })

  it('uses the same placeholders in both languages', () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      assert.deepEqual(
        placeholders(zh[key]),
        placeholders(en[key]),
        `${key} interpolates different names in zh and en — one language would render a literal brace`,
      )
    }
  })

  it('namespaces every key under the plugin id', () => {
    // A key outside the namespace would not resolve through this plugin's `t`,
    // and `check:graph` treats a stray prefix as drift.
    assert.equal(NS, 'dsh-app-codegraph')
    for (const key of Object.keys(en)) {
      assert.ok(key.startsWith('codegraph.'), `${key} is outside the codegraph namespace`)
    }
  })

  it('carries a rendering for every host failure code the routes can answer', () => {
    // The host sends a code, the client owns the sentence. A route code with no
    // key here falls back to the host's English diagnostic, which is the wrong
    // language for this UI — so the set is pinned.
    const hostCodes = [
      'statusFailed', 'languagesFailed', 'idRequired', 'unknownLanguage',
      'bundledLanguage', 'cwdRequired', 'unknownProject', 'unknownAction', 'actionFailed',
    ]
    for (const code of hostCodes) {
      const key = `codegraph.host.${code}`
      assert.ok(key in en, `the host answers route.${code} but there is no ${key}`)
    }
  })

  it('renders every host sentence without leaving a placeholder or doubling a suffix', () => {
    // Measured defect: `'{id} ships with the plugin and cannot be {action}ed.'`
    // with `action = 'removed'` produced "cannot be removeded" — and the route
    // test passed, because it asserted the STATUS CODE and the host code, never
    // the sentence. Two rules are pinned here, both about the HOST sentences
    // (the copy the client renders from a code plus params).
    const params = { id: 'typescript', cwd: 'D:/p', action: 'remove', detail: 'boom', count: 1 }
    const hostKeys = Object.keys(en).filter(key => key.startsWith('codegraph.host.'))
    assert.ok(hostKeys.length > 0, 'no host keys found; this check would pass vacuously')
    for (const key of hostKeys) {
      const template = en[key as CodegraphKey]
      const filled = template.replace(/\{([a-z][a-zA-Z0-9_]*)\}/gu, (whole, name: string) => {
        const value = (params as Record<string, unknown>)[name]
        return value === undefined ? whole : String(value)
      })
      assert.equal(/\{[a-z]/iu.test(filled), false, `${key} leaves an unfilled placeholder: ${filled}`)
      // `removeded`, `downloadedd`: a template that appends letters to a word.
      const doubled = /\b([a-z]+)\1(?:ed|s|ing)\b/iu.exec(filled)
      assert.equal(doubled, null, `${key} doubles a suffix: ${filled}`)
    }
  })

})
