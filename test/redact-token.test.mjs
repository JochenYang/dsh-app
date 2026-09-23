// The redaction that keeps a session token out of a terminal and out of CI.
//
// A ready kernel prints its authenticated address into its own output
// (`dsh web: http://127.0.0.1:19387/?token=…`), and `check-plugin-compat.mjs`
// quotes that output — so the line the application redacts (`src/main/redact.ts`)
// was reaching the console in the clear. The rule is narrow on purpose (a wide
// one would eat the diagnostic), and narrow rules are exactly the ones that
// regress into "looks redacted" — so each shape is pinned here, and the "not a
// token" neighbours are pinned with it.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { redactToken } from '../scripts/lib/redact-token.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('the address a ready kernel prints keeps everything but the token', () => {
  const line = '[host] dsh web: http://127.0.0.1:19387/?token=Bq3x.7Yz-abc_123&lang=zh'
  assert.equal(
    redactToken(line),
    '[host] dsh web: http://127.0.0.1:19387/?token=[redacted]&lang=zh',
  )
})

test('every key the rule names is masked in both query positions, whatever the case', () => {
  for (const key of ['token', 'access_token', 'api_key', 'apikey', 'TOKEN', 'ApiKey']) {
    for (const lead of ['?', '&']) {
      const line = `${lead}${key}=s3cr3t-value`
      assert.equal(redactToken(line), `${lead}${key}=[redacted]`, `${lead}${key}`)
    }
  }
})

test('the token runs to the end of the value, not to its first punctuation', () => {
  // A short class here would leave a suffix of the secret visible — the failure
  // that looks like it worked.
  const line = 'http://127.0.0.1:1/?token=a.b-c_d~e+f/g=h'
  const out = redactToken(line)
  assert.equal(out, 'http://127.0.0.1:1/?token=[redacted]')
  assert.equal(out.includes('c_d'), false)
})

test('a Bearer credential is masked and the header name survives', () => {
  assert.equal(
    redactToken('Authorization: Bearer eyJhbGciOi.J9-abc_def'),
    'Authorization: Bearer [redacted]',
  )
})

test('neighbours that are not tokens are left exactly as they arrived', () => {
  for (const line of [
    'Progress: resolved 2, reused 2, downloaded 0, added 2, done',
    '?tokenized=1',
    '?no_token=1',
    'C:\\Users\\someone\\.dsh\\sessions\\session.v4.jsonl',
    'Error: cannot find module "@deepseek-ai/dsh"',
  ]) {
    assert.equal(redactToken(line), line)
  }
})

test('redacting is idempotent, so a double pass cannot corrupt the line', () => {
  const line = 'http://127.0.0.1:1/?token=abc&access_token=def Bearer ghi'
  const once = redactToken(line)
  assert.equal(redactToken(once), once)
})

test('the checker uses the shared rule instead of a second local copy', () => {
  const source = readFileSync(join(ROOT, 'scripts', 'check-plugin-compat.mjs'), 'utf8')
  assert.match(source, /from '\.\/lib\/redact-token\.mjs'/u, 'the script imports the shared helper')
  assert.equal(
    /function\s+redactToken/u.test(source),
    false,
    'a local redactToken would be a second rule to keep in sync — this one is imported',
  )
})
