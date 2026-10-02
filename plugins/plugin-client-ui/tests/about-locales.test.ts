/**
 * The About page's dictionary: the key parity of the two tables, the English
 * table's language, and the placeholders a translation must carry across.
 *
 * The same three guards the other page dictionaries get (see
 * `plugin-sheet/tests/locales.test.ts` for the pattern): a key present on one
 * side only is a compile error already, but a translation that quietly drops a
 * `{message}` placeholder type-checks and then renders the literal braces.
 *
 * @module @dsh-app/plugin-client-ui/tests/about-locales
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { en, zh } from '../src/client/about/locales.ts'

test('about: both tables carry the same keys, all of them prefixed', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  for (const key of Object.keys(zh)) {
    assert.ok(key.startsWith('about.'), `${key} is outside this page's prefix`)
  }
})

test('about: the English table is English and keeps the zh placeholders', () => {
  for (const [key, value] of Object.entries(en)) {
    assert.doesNotMatch(value, /[\p{Script=Han}]/u, `${key} still carries Han characters`)
    assert.equal(value.trim(), value, `${key} is padded`)
    assert.notEqual(value, '', `${key} is empty`)
    for (const placeholder of zh[key as keyof typeof zh].match(/\{(\w+)\}/g) ?? []) {
      assert.ok(value.includes(placeholder), `${key} lost ${placeholder}`)
    }
  }
})

test('about: the placeholders the page passes are the ones the copy declares', () => {
  // The page interpolates exactly these two; a key that gained or lost one
  // would render literal braces or drop the detail silently.
  assert.deepEqual(zh['about.failed'].match(/\{(\w+)\}/g), ['{message}'])
  assert.deepEqual(zh['about.actions.failed'].match(/\{(\w+)\}/g), ['{message}'])
  assert.deepEqual(en['about.failed'].match(/\{(\w+)\}/g), ['{message}'])
  assert.deepEqual(en['about.actions.failed'].match(/\{(\w+)\}/g), ['{message}'])
})
