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
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { marketApi, MarketApiError, ROUTE_PREFIX } from '../src/client/api.ts'
import { installFromRow } from '../src/client/install-flow.ts'
import { hostMessage, sourceReasonOf } from '../src/client/messages.ts'
import { zh } from '../src/client/locales.ts'
import { validateSourceUrl } from '../src/catalog.ts'
import { privateResolutionReason, unresolvedReason } from '../src/source-address.ts'
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

    // The address policy's two refusals: a literal private host, and a name
    // that answers with one. Both sentences name the host the user typed.
    const privateHost = validateSourceUrl('https://192.168.1.1/list')
    assert.equal(privateHost.ok, false)
    assert.equal(
      privateHost.ok ? '' : hostMessage(privateHost.reason, t),
      '目录源不能指向内网、本机或链路本地地址：192.168.1.1',
    )
    assert.equal(
      hostMessage(privateResolutionReason('internal.example.com', '10.0.0.1', 'private'), t),
      '目录源域名 internal.example.com 解析到内网、本机或链路本地地址，已跳过该源',
    )
    assert.equal(
      hostMessage(unresolvedReason('cdn.example.com'), t),
      '目录源域名 cdn.example.com 无法解析，已跳过该源',
    )

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
    assert.equal(hostMessage({ code: 'registry.futureCode', text: 'registry said no' }, t), 'registry said no')
  })

  it('renders its own sentence for a code whose text can quote the responding server', () => {
    // The measured shape: the fetch library's message carries the leading bytes
    // of a body this host fetched. Rendering it would hand whatever address the
    // request reached a read channel of up to MAX_REASON_DETAIL characters, so
    // the detail stays in the host's diagnostic and the panel renders a
    // sentence of its own.
    const upstream = 'Unexpected token \'p\', "package/pl"... is not valid JSON'
    const rendered = hostMessage({ code: 'catalog.requestFailedDetail', params: { detail: upstream }, text: upstream }, t)
    assert.equal(rendered, '目录源请求失败')
    assert.equal(rendered.includes('package/pl'), false)
    assert.equal(rendered.includes('Unexpected token'), false)
  })

  it('never renders blank in the source-failure list', () => {
    assert.equal(sourceReasonOf({ code: 'catalog.timeout', params: { seconds: 30 } }, t), '请求超时（30 秒）')
    assert.equal(sourceReasonOf({ code: 'mkt.futureCode' }, t), '请求失败')
    assert.equal(sourceReasonOf({ code: 'catalog.requestFailed', text: 'the request failed' }, t), '请求失败')
  })

  it('renders the install-intent refusals, so a stale confirmation explains itself', () => {
    // These reach the panel through the install error strip, which renders the
    // host's coded reason — a code without copy would show English prose in a
    // zh panel, and a blank line for a code whose `text` is absent.
    assert.equal(
      hostMessage({ code: 'install.tokenUnknown' }, t),
      '这次安装确认已经失效（可能已经用过一次，或市场已重启），请重新打开确认后重试',
    )
    assert.equal(
      hostMessage({ code: 'install.tokenExpired', params: { minutes: 15 } }, t),
      '这次安装确认已过期（有效期 15 分钟），请重新打开确认后重试',
    )
    assert.equal(
      hostMessage({ code: 'install.tokenProfileMismatch', params: { issued: 'web', current: 'dev' } }, t),
      '这次安装确认是为 profile「web」签发的，当前应用运行在「dev」，请重新打开确认',
    )
    assert.equal(
      hostMessage({ code: 'install.entryUnknown', params: { id: 'row-gone' } }, t),
      '目录中已经没有这次确认对应的条目（「row-gone」），请刷新目录后重试',
    )
    assert.equal(
      hostMessage({ code: 'install.entryAmbiguous', params: { id: 'same', count: 2 } }, t),
      '目录中有 2 个条目共用标识「same」，无法确定要安装哪一个；请刷新目录，或改从来源里标识唯一的条目安装',
    )
    assert.equal(hostMessage({ code: 'install.tokenInvalid' }, t), '安装请求必须携带市场签发的令牌，请重新打开安装确认')
    assert.equal(hostMessage({ code: 'install.tokenHomeChanged' }, t), '应用的数据目录在这次安装确认之后发生了变化，请重新打开确认')
    assert.equal(
      hostMessage({ code: 'install.catalogUnavailable' }, t),
      '市场还没有可用的目录数据，无法签发安装确认；请先打开一次市场',
    )
    assert.equal(
      hostMessage({ code: 'install.notInstallable', params: { package: 'dsh-x' } }, t),
      '目录条目「dsh-x」没有可安装的目标',
    )
    assert.equal(
      hostMessage({ code: 'install.gitTargetInvalid' }, t),
      'Git 安装目标必须是 github:owner/repo（可带 #commit），且指向宿主能识别的仓库',
    )
  })

  it('renders the allow-build refusals of the host-attempt anchor', () => {
    assert.equal(
      hostMessage({ code: 'allowBuild.notBlockedInstall', params: { package: 'totally-arbitrary-pkg' } }, t),
      '宿主没有记录到这个包的构建脚本被拦截的安装尝试（totally-arbitrary-pkg）；请先在插件市场安装它，再使用构建脚本被拦截提示里的「放行并重试」',
    )
    assert.equal(
      hostMessage({ code: 'allowBuild.notReported', params: { packages: 'totally-arbitrary-pkg' } }, t),
      '放行列表里有这次安装尝试没有报告为被拦截的包：totally-arbitrary-pkg',
    )
  })
})

describe('marketApi install path (one-shot token)', () => {
  /** Capture one request without a network: the global fetch is the seam. */
  async function capture(run: () => Promise<unknown>): Promise<{ url: string, method: string, body: unknown }> {
    const original = globalThis.fetch
    let seen: { url: string, method: string, body: unknown } | undefined
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      seen = { url: String(url), method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) }
      return new Response(JSON.stringify({ ok: true, value: {} }), { headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      await run()
    } finally {
      globalThis.fetch = original
    }
    assert.ok(seen !== undefined, 'the call must reach fetch')
    return seen
  }

  it('mints with the row id and the confirmed force flag, never with a package name', async () => {
    const request = await capture(() => marketApi.installIntent('row-npm', true))
    assert.equal(request.url, `${ROUTE_PREFIX}/install-intent`)
    assert.equal(request.method, 'POST')
    assert.deepEqual(request.body, { entryId: 'row-npm', force: true })
  })

  it('omits force when the user confirmed nothing unusual', async () => {
    const request = await capture(() => marketApi.installIntent('row-npm'))
    assert.deepEqual(request.body, { entryId: 'row-npm' })
  })

  it('submits the token ALONE, which is the whole point of the change', async () => {
    const request = await capture(() => marketApi.install('tok-abc'))
    assert.equal(request.url, `${ROUTE_PREFIX}/install`)
    assert.deepEqual(request.body, { token: 'tok-abc' })
  })
})

// ── The confirm click: a token that died with the dialog open ───────────────

/** One scripted host answer for the fetch stub below. */
interface ScriptedAnswer {
  readonly ok: boolean
  readonly value?: unknown
  readonly host?: { code: string }
}

describe('installFromRow (one re-mint when the token died)', () => {
  /**
   * Play a queue of host answers, one per request, recording every request. The
   * global fetch is the seam (the same one the capture helper above uses), so
   * the real `marketApi` + the real flow run against it.
   */
  async function play(
    run: () => Promise<unknown>,
    answers: readonly ScriptedAnswer[],
  ): Promise<{ result?: unknown, error?: unknown, calls: Array<{ path: string, body: unknown }> }> {
    const original = globalThis.fetch
    const calls: Array<{ path: string, body: unknown }> = []
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const path = String(url)
      calls.push({ path, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
      const answer = answers[calls.length - 1]
      assert.ok(answer !== undefined, `unexpected request ${String(calls.length)}: ${path}`)
      const payload = answer.ok
        ? { ok: true, value: answer.value }
        : { ok: false, error: { code: 'bad-request', message: 'refused', host: answer.host } }
      return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      return { result: await run(), calls }
    } catch (error: unknown) {
      return { error, calls }
    } finally {
      globalThis.fetch = original
    }
  }

  it('re-mints ONE fresh token and installs, when the first expired while the dialog stood open', async () => {
    const played = await play(
      () => installFromRow(marketApi.installIntent('row-npm'), 'row-npm', undefined),
      [
        { ok: true, value: { token: 'stale', expiresAt: 1 } },
        { ok: false, host: { code: 'install.tokenExpired' } },
        { ok: true, value: { token: 'fresh', expiresAt: 2 } },
        { ok: true, value: { installed: true, version: '1.2.3', output: 'ok' } },
      ],
    )
    assert.equal(played.error, undefined)
    assert.deepEqual(played.result, { installed: true, version: '1.2.3', output: 'ok' })
    assert.deepEqual(played.calls, [
      { path: `${ROUTE_PREFIX}/install-intent`, body: { entryId: 'row-npm' } },
      { path: `${ROUTE_PREFIX}/install`, body: { token: 'stale' } },
      { path: `${ROUTE_PREFIX}/install-intent`, body: { entryId: 'row-npm' } },
      { path: `${ROUTE_PREFIX}/install`, body: { token: 'fresh' } },
    ])
  })

  it('re-mints for an evicted token too, and carries the confirmed force with it', async () => {
    const played = await play(
      () => installFromRow(marketApi.installIntent('row-npm', true), 'row-npm', true),
      [
        { ok: true, value: { token: 'stale', expiresAt: 1 } },
        { ok: false, host: { code: 'install.tokenUnknown' } },
        { ok: true, value: { token: 'fresh', expiresAt: 2 } },
        { ok: true, value: { installed: true, output: 'ok' } },
      ],
    )
    assert.equal(played.error, undefined)
    assert.deepEqual(played.calls[2], { path: `${ROUTE_PREFIX}/install-intent`, body: { entryId: 'row-npm', force: true } })
  })

  it('reports a token that is still stale after the re-mint instead of retrying again', async () => {
    const played = await play(
      () => installFromRow(marketApi.installIntent('row-npm'), 'row-npm', undefined),
      [
        { ok: true, value: { token: 'stale', expiresAt: 1 } },
        { ok: false, host: { code: 'install.tokenExpired' } },
        { ok: true, value: { token: 'fresh', expiresAt: 2 } },
        { ok: false, host: { code: 'install.tokenExpired' } },
      ],
    )
    assert.ok(played.error instanceof MarketApiError)
    assert.equal((played.error as MarketApiError).host?.code, 'install.tokenExpired')
    assert.equal(played.calls.length, 4, 'exactly one re-mint, never a loop')
  })

  it('does not re-mint for a refusal that is not about the token', async () => {
    const played = await play(
      () => installFromRow(marketApi.installIntent('row-npm'), 'row-npm', undefined),
      [
        { ok: true, value: { token: 'good', expiresAt: 1 } },
        { ok: false, host: { code: 'install.confirmLocal' } },
      ],
    )
    assert.equal((played.error as MarketApiError).host?.code, 'install.confirmLocal')
    assert.equal(played.calls.length, 2, 'the refusal is the answer, not a reason to mint again')
  })

  it('re-mints after a mint that failed at open, and surfaces THAT failure', async () => {
    const pending = Promise.reject(new Error('the dialog opened before the panel was ready'))
    pending.catch(() => undefined)
    const played = await play(
      () => installFromRow(pending, 'row-npm', undefined),
      [
        { ok: true, value: { token: 'fresh', expiresAt: 1 } },
        { ok: true, value: { installed: true, output: 'ok' } },
      ],
    )
    assert.equal(played.error, undefined)
    assert.deepEqual(played.calls.map(call => call.path), [`${ROUTE_PREFIX}/install-intent`, `${ROUTE_PREFIX}/install`])
  })
})

describe('the panel rides the install flow (source contract)', () => {
  it('confirms through installFromRow, and never calls marketApi.install directly', () => {
    // The recovery lives in one place; a panel that awaited the dialog's promise
    // itself would fail every confirmation made past the token's TTL (and the
    // render tests cannot press a button), so the wiring is pinned here.
    const source = readFileSync(new URL('../src/client/panel.tsx', import.meta.url), 'utf8')
    assert.ok(source.includes("from './install-flow.ts'"), 'panel must import the flow')
    assert.ok(source.includes('installFromRow(intent, entry.id'), 'the confirm must go through the flow')
    assert.equal(source.includes('marketApi.install('), false, 'no direct install call beside the flow')
  })
})
