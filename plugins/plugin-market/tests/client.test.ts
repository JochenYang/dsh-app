/**
 * Client render tests for the coded host messages: a known code renders this
 * panel's zh copy (pinned byte-for-byte), an unknown one falls back to the
 * host's English diagnostic, a nested code inside a param slot resolves to its
 * own copy, and none of them ever renders blank.
 *
 * Two of these go through the REAL host functions (`validateSourceUrl`,
 * `checkUpdateTarget`), so the host→panel contract is checked end to end
 * rather than only through hand-written literals.
 *
 * @module plugin-market/tests/client
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { hostMessage, sourceReasonOf } from '../src/client/messages.ts'
import { zh } from '../src/client/locales.ts'
import { validateSourceUrl } from '../src/catalog.ts'
import { checkUpdateTarget } from '../src/routes.ts'

/**
 * The panel's `t` seat, reduced to the zh dictionary with `{name}`
 * interpolation — the same contract the locale runtime implements.
 * @param dict - the dictionary to read.
 * @returns the stand-in translate function.
 */
function seat(dict: Readonly<Record<string, string>>): Parameters<typeof hostMessage>[1] {
  return ((key: string, params?: Record<string, unknown>) =>
    String(dict[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`))
  ) as unknown as Parameters<typeof hostMessage>[1]
}

const t = seat(zh)

describe('hostMessage (market)', () => {
  it('renders a known code from the zh dictionary, byte-identical to the pre-i18n sentence', () => {
    assert.equal(hostMessage({ code: 'pkg.empty' }, t), '包名不能为空')
    assert.equal(
      hostMessage({ code: 'pkg.invalid', params: { name: 'not a package name' } }, t),
      '包名格式不合法：「not a package name」',
    )
    assert.equal(
      hostMessage({ code: 'install.confirmLocal', params: { installed: 'github.com/o/pkg-a', incoming: 'github.com/x/pkg-a' } }, t),
      '该插件是本地或 Git 安装的版本（本地：github.com/o/pkg-a），本次安装来自 npm（仓库：github.com/x/pkg-a），直接安装会覆盖现有版本；如确认要替换，请在请求中携带 force: true',
    )
    assert.equal(
      hostMessage({ code: 'source.tooMany', params: { max: 20 } }, t),
      '目录源最多 20 个',
    )
  })

  it('interpolates every value the sentence names, so no raw {param} can reach the screen', () => {
    assert.equal(
      hostMessage({ code: 'registry.versionNotFound', params: { name: '@dsh-app/plugin-x', version: '9.9.9' } }, t),
      '版本不存在：「@dsh-app/plugin-x@9.9.9」',
    )
    assert.equal(
      hostMessage({ code: 'registry.httpFailed', params: { status: 503 } }, t),
      'registry 查询失败（HTTP 503）',
    )
    assert.equal(
      hostMessage({ code: 'install.timeout', params: { seconds: 120 } }, t),
      '安装/卸载超时（120 秒），已终止命令，请稍后重试',
    )
    assert.equal(
      hostMessage({ code: 'route.internalError', params: { detail: 'ENOSPC' } }, t),
      '操作失败：ENOSPC',
    )
    // The CLI tail is data and keeps its own line break.
    assert.equal(
      hostMessage({ code: 'install.commandFailedLog', params: { log: 'ERR_PNPM_NO_MATCHING_VERSION' } }, t),
      '命令失败：\nERR_PNPM_NO_MATCHING_VERSION',
    )
  })

  it('resolves a nested code in a param slot into that code\'s own copy', () => {
    // An unprovable repo side and a missing OS error code travel as codes, so
    // neither language ever receives the other's words.
    assert.equal(
      hostMessage({ code: 'install.confirmLocal', params: { installed: 'github.com/o/pkg-a', incoming: 'repo.unknown' } }, t),
      '该插件是本地或 Git 安装的版本（本地：github.com/o/pkg-a），本次安装来自 npm（仓库：未知来源），直接安装会覆盖现有版本；如确认要替换，请在请求中携带 force: true',
    )
    assert.equal(
      hostMessage({ code: 'registry.lookupFailed', params: { detail: 'error.network' } }, t),
      'registry 查询失败：网络错误',
    )
    assert.equal(
      hostMessage({ code: 'registry.lookupFailed', params: { detail: 'fetch failed' } }, t),
      'registry 查询失败：fetch failed',
      'a diagnostic that is not a dictionary code rides through verbatim',
    )
  })

  it('renders the reasons the host functions actually produce', () => {
    const rejected = validateSourceUrl('http://example.com/list')
    assert.equal(rejected.ok, false)
    assert.equal(rejected.ok ? '' : hostMessage(rejected.reason, t), '目录源必须是 https:// 地址')

    const refusal = checkUpdateTarget(undefined, undefined)
    assert.equal(refusal.ok, false)
    assert.equal(refusal.ok ? '' : hostMessage(refusal.reason, t), '该插件尚未安装，无法更新')
  })

  it('falls back to the host English diagnostic for a code this build does not know', () => {
    assert.equal(
      hostMessage({ code: 'catalog.httpStatus', params: { status: 503 }, text: 'HTTP 503' }, t),
      'HTTP 503',
      'an HTTP status reads the same in every locale, so it carries no dictionary copy',
    )
    assert.equal(
      hostMessage({ code: 'catalog.requestFailedDetail', params: { detail: 'fetch failed' }, text: 'fetch failed' }, t),
      'fetch failed',
    )
    assert.equal(hostMessage({ code: 'registry.futureCode', text: 'registry said no' }, t), 'registry said no')
  })

  it('never renders blank in the source-failure list', () => {
    assert.equal(sourceReasonOf({ code: 'catalog.timeout', params: { seconds: 30 } }, t), '请求超时（30 秒）')
    assert.equal(sourceReasonOf({ code: 'mkt.futureCode' }, t), '请求失败')
    assert.equal(sourceReasonOf({ code: 'catalog.requestFailed', text: 'the request failed' }, t), '请求失败')
  })
})
