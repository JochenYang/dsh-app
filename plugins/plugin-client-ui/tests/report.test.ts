// The exported diagnostics package is written by the PAGE, not the host.
//
// Two things are worth pinning here, and both are cheap to get wrong:
//   1. the file reads in the language the UI is running in (the whole point of
//      moving assembly out of the kernel child process), and
//   2. every sentence is COMPLETE — a copy entry whose params never arrive
//      renders a literal `{value}` into a support file, where nobody notices
//      until a maintainer opens it.
// The `t` seat below is the locale runtime's own interpolation, reproduced.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { en, zh } from '../src/client/diagnostics/locales.ts'
import { buildReportText, reportFileName } from '../src/client/diagnostics/report.ts'
import type { ReportFacts } from '../src/client/diagnostics/report.ts'

/** The locale runtime's interpolation, reproduced (see dsh-client-locale). */
const makeT = (dict: Record<string, string>) => (key: string, params?: Record<string, unknown>) => {
  const template = dict[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
}

const TAIL = ['2026-09-16 00:30:01 INFO boot', '2026-09-16 00:30:02 WARN retry']

/** A complete, happy-path fact set. */
const FACTS: ReportFacts = {
  name: 'dsh-app-diagnostics-20260916-0030.txt',
  generatedAt: new Date(2026, 8, 16, 0, 30, 12).toISOString(),
  shellVersion: '0.11.10',
  kernelVersion: '0.1.5-rc.2',
  kernelChannel: 'beta',
  logDir: 'C:\\Users\\x\\AppData\\Roaming\\DSH APP\\logs',
  log: { kind: 'ok', file: 'C:\\logs\\dsh-server-2030-01-01T00-00-00-000Z.log', lines: TAIL },
}

const PLACEHOLDER = /\{[a-z]+\}/u
const HAN = /[\u4e00-\u9fff]/u

describe('diagnostics report text', () => {
  it('writes a complete Chinese package (the file this export always produced)', () => {
    const text = buildReportText(FACTS, makeT(zh))
    assert.match(text, /^DSH APP 诊断包/u)
    assert.match(text, /生成时间：2026-09-16 00:30:12（本机时间）/u)
    assert.match(text, /\[应用版本\]/u)
    assert.match(text, /shell 版本：0\.11\.10/u)
    assert.match(text, /内核版本：0\.1\.5-rc\.2/u)
    assert.match(text, /内核渠道：beta/u)
    assert.match(text, /\[日志\]/u)
    assert.match(text, /日志文件：C:\\logs\\dsh-server-/u)
    assert.match(text, /日志尾部：取最近 500 行，实际 2 行/u)
    for (const line of TAIL) assert.equal(text.includes(line), true, 'the tail travels verbatim')
    assert.match(text, /----- 文件结束 -----\n$/u)
    // The no-secrets promise is the file's own claim; it has to be in there.
    assert.match(text, /本文件不含密钥，也不含会话内容/u)
    assert.equal(PLACEHOLDER.test(text), false, 'no unfilled placeholder reaches the file')
  })

  it('writes the same package in English, with no Chinese left in it', () => {
    const text = buildReportText(FACTS, makeT(en))
    assert.match(text, /^DSH APP diagnostics/u)
    assert.match(text, /shell version: 0\.11\.10/u)
    assert.match(text, /----- end of file -----\n$/u)
    // The regression this whole change is about: an English UI used to export a
    // Chinese document. Log lines may be any language (they are the host's own
    // output); the report's own copy may not be.
    const withoutTail = text.split('\n').filter((line) => !TAIL.includes(line)).join('\n')
    assert.equal(HAN.test(withoutTail), false, 'the English package carries our copy in English only')
    assert.equal(PLACEHOLDER.test(text), false)
  })

  it('names absent values with the page word, never with a blank or a raw key', () => {
    const empty: ReportFacts = { ...FACTS, shellVersion: '', kernelVersion: '   ', kernelChannel: undefined, logDir: '' }
    const zhText = buildReportText(empty, makeT(zh))
    assert.match(zhText, /shell 版本：未知/u)
    assert.match(zhText, /内核版本：未知/u)
    assert.match(zhText, /内核渠道：未知/u)
    assert.match(zhText, /日志目录：未知/u)
    const enText = buildReportText(empty, makeT(en))
    assert.match(enText, /kernel channel: unknown/u)
  })

  it('states why a log is absent, in each language', () => {
    for (const reason of ['unsupported', 'missing', 'unreadable', 'something-new']) {
      const facts: ReportFacts = { ...FACTS, log: { kind: 'unavailable', reason } }
      const zhText = buildReportText(facts, makeT(zh))
      const enText = buildReportText(facts, makeT(en))
      assert.match(zhText, /^日志内容：/mu)
      assert.match(enText, /^log content: /mu)
      assert.equal(PLACEHOLDER.test(zhText + enText), false, `placeholders must be filled (${reason})`)
      if (reason === 'unsupported') {
        // The one reason that names a variable: it comes from the host's facts,
        // and it has to be IN the sentence rather than a literal `{env}`.
        assert.match(zhText, /DSH_APP_LOG_DIR/u)
        assert.match(enText, /DSH_APP_LOG_DIR/u)
      }
      // An unknown reason still produces a sentence rather than an empty line.
        assert.doesNotMatch(zhText, /日志内容：\s*$/mu)
    }
    assert.notEqual(
      buildReportText({ ...FACTS, log: { kind: 'unavailable', reason: 'missing' } }, makeT(zh)),
      buildReportText({ ...FACTS, log: { kind: 'unavailable', reason: 'unreadable' } }, makeT(zh)),
      'distinct causes read differently',
    )
  })

  it('marks an empty tail instead of printing nothing', () => {
    const text = buildReportText({ ...FACTS, log: { kind: 'ok', file: 'x.log', lines: [] } }, makeT(zh))
    assert.match(text, /（日志文件为空）/u)
    assert.match(text, /实际 0 行/u)
  })

  it('falls back to a stamped name for a host that sent none', () => {
    assert.equal(reportFileName(FACTS), FACTS.name)
    const fallback = reportFileName({}, new Date(2026, 0, 2, 3, 4, 5))
    assert.equal(fallback, 'dsh-app-diagnostics-20260102-0304.txt')
  })

  it('the config-check copy exists in both languages and fills every param', () => {
    // The card renders four of these with counts, and a count that never
    // arrives prints a literal `{ours}` on the page — which reads as a broken
    // check rather than a broken dictionary.
    const keys = [
      'diag.check.title', 'diag.check.action', 'diag.check.running', 'diag.check.idle',
      'diag.check.noReport', 'diag.check.ok', 'diag.check.okOthers', 'diag.check.ours',
      'diag.check.summary', 'diag.check.hintIdle', 'diag.check.hintClean', 'diag.check.hintOthers',
      'diag.check.levelError', 'diag.check.levelWarning', 'diag.check.whoOurs', 'diag.check.whoOther',
    ] as const
    for (const key of keys) {
      assert.equal(typeof zh[key], 'string', `zh is missing ${key}`)
      assert.equal(typeof en[key], 'string', `en is missing ${key}`)
      assert.notEqual(zh[key].trim(), '', `${key} is empty in zh`)
      assert.notEqual(en[key].trim(), '', `${key} is empty in en`)
    }
    // Every placeholder a key declares has to be one the card supplies.
    const supplied = { others: 3, ours: 1, entries: 211, errors: 5 }
    for (const key of keys) {
      const zhText = makeT(zh)(key, supplied)
      const enText = makeT(en)(key, supplied)
      assert.equal(PLACEHOLDER.test(zhText), false, `${key} (zh) left a placeholder unfilled: ${zhText}`)
      assert.equal(PLACEHOLDER.test(enText), false, `${key} (en) left a placeholder unfilled: ${enText}`)
    }
    // The two languages must not be the same string: a copy-paste that never got
    // translated is invisible in a screenshot.
    for (const key of keys) {
      if (!zh[key].includes('{')) assert.notEqual(zh[key], en[key], `${key} was not translated`)
    }
  })
})
