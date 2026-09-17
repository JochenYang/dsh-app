#!/usr/bin/env node
/**
 * End-to-end probe for plugin-websearch: launches a REAL dsh kernel with the
 * suite overlay, then drives the plugin's actual HTTP routes — config read,
 * a live engine probe against the public search endpoints, and a real search
 * through `ctx.web`.
 *
 * This is the check that a compile-green build cannot give: it proves the
 * plugin loads inside the composed tree, its routes answer, and the engine
 * chain actually returns sources from the network.
 *
 * Usage (dev checkout):
 *   node scripts/probe-websearch.mjs
 *   node scripts/probe-websearch.mjs --dev-checkout D:/codes/deepseek-harness
 *
 * Exits non-zero on any failed assertion, printing the kernel log tail.
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, symlinkSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OVERLAY = path.join(root, 'dist', 'main', 'dsh-app.patch.yml')
const ROUTE = '/api/plugins/dsh-app/plugin-websearch'

/** Suite plugin dirs (mirror of SUITE_PLUGIN_DIRS / SUITE_DIRS). */
const SUITE_DIRS = ['plugin-brand', 'plugin-client-ui', 'plugin-sidebar', 'plugin-swarm', 'plugin-usage', 'plugin-archives', 'plugin-memory', 'plugin-fff', 'plugin-mcp', 'plugin-hooks', 'plugin-ppt', 'plugin-market', 'plugin-presets', 'plugin-doc', 'plugin-sheet', 'plugin-pdf', 'plugin-websearch']

const args = process.argv.slice(2)
const devCheckoutArg = args.includes('--dev-checkout') ? args[args.indexOf('--dev-checkout') + 1] : undefined
/**
 * Run against the user's REAL `~/.dsh` instead of a throwaway home.
 *
 * The throwaway home exercises the stock composition (every upstream row as
 * the base bundle ships it). The real home is where the user's own patch
 * layers apply — which is the only place the "upstream row is disabled"
 * state exists, and therefore the only way to verify the settings page
 * reports it honestly instead of offering a switch that cannot work.
 */
const useRealHome = args.includes('--real-home')

/**
 * Refuse to operate on a home this probe did not create, unless the caller
 * explicitly asked for the real one AND that path is really the user's home.
 *
 * This is a hard gate, not a warning: the failure it prevents is deleting the
 * user's entire dsh home (settings, credentials, sessions, skills, storages).
 * A typo'd `--dev-checkout`-style argument must not be able to point the
 * cleanup at an arbitrary directory.
 */
function assertHomeIsSafe(home, real) {
  const resolved = path.resolve(home)
  const expectedReal = path.resolve(os.homedir(), '.dsh')
  if (real) {
    if (resolved !== expectedReal) {
      throw new Error(`refusing --real-home: ${resolved} is not ${expectedReal}`)
    }
    return
  }
  // A throwaway home must live under the OS temp dir; anything else means the
  // caller passed a path we do not own and must not delete.
  const temp = path.resolve(os.tmpdir())
  if (!resolved.startsWith(temp + path.sep)) {
    throw new Error(`refusing to treat ${resolved} as a throwaway home (not under ${temp})`)
  }
}

function findDevCheckout() {
  for (const candidate of [devCheckoutArg, path.resolve(root, '..', 'deepseek-harness'), path.resolve(root, '..', '..', 'deepseek-harness')]) {
    if (candidate !== undefined && existsSync(path.join(candidate, 'package.json'))) return candidate
  }
  throw new Error('dev checkout not found; pass --dev-checkout <dir>')
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
      server.on('error', reject)
    })
    server.on('error', reject)
  })
}

function firstCookie(headers) {
  const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []
  const candidates = list.length > 0 ? list : [headers.get('set-cookie')].filter(v => v !== null)
  return candidates.find(v => /^[^=]+=/.test(v)) ?? ''
}

let cookie = ''

async function getJson(base, route, init) {
  const response = await fetch(`${base}${route}`, {
    signal: AbortSignal.timeout(60_000),
    headers: {
      ...cookie === '' ? {} : { cookie },
      ...init?.body !== undefined ? { 'content-type': 'application/json' } : {},
    },
    ...init,
  })
  const text = await response.text()
  let body = null
  try { body = JSON.parse(text) } catch { /* keep text for the error path */ }
  return { status: response.status, body, text }
}

async function waitHealthy(logPath, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  let settled = ''
  while (Date.now() < deadline) {
    try {
      const match = /(?:^|\s)dsh web:\s+(http:\/\/\S+)/m.exec(readFileSync(logPath, 'utf8'))
      if (match !== null) { settled = match[1]; break }
    } catch { /* not written yet */ }
    await new Promise(r => setTimeout(r, 1_000))
  }
  if (settled === '') throw new Error('server never printed its settled URL')
  while (Date.now() < deadline) {
    try {
      // The token URL answers 303 → a redirect that sets the session cookie
      // (the shell's probeHealth does the same exchange). Requesting the
      // origin without the token would just 401.
      const exchange = await fetch(settled, { redirect: 'manual', signal: AbortSignal.timeout(3_000) })
      if (exchange.ok) {
        cookie = firstCookie(exchange.headers)
        return settled
      }
      if (exchange.status === 303) {
        cookie = firstCookie(exchange.headers)
        const next = new URL(exchange.headers.get('location') ?? '', settled)
        const follow = await fetch(next, {
          redirect: 'manual',
          signal: AbortSignal.timeout(3_000),
          headers: cookie === '' ? {} : { cookie },
        })
        if (follow.ok || follow.status === 200) return settled
      }
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 1_000))
  }
  throw new Error(`server never became healthy at ${settled}`)
}

function stopChild(child) {
  if (child === undefined || child.exitCode !== null) return
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else child.kill('SIGTERM')
}

const failures = []
function check(label, condition, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL'
  console.log(`  [${mark}] ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!condition) failures.push(label)
}

async function main() {
  const checkout = findDevCheckout()
  const port = await freePort()
  const logDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-websearch-probe-'))
  const logPath = path.join(logDir, 'kernel.log')
  const dshHome = useRealHome
    ? path.join(os.homedir(), '.dsh')
    : await mkdtemp(path.join(os.tmpdir(), 'dsh-websearch-home-'))
  assertHomeIsSafe(dshHome, useRealHome)
  /**
   * Whether this probe created the home and may therefore delete it. Set from
   * the branch above rather than re-derived at cleanup time: a single owner
   * flag cannot drift the way two independent `useRealHome` checks can.
   */
  const ownsHome = !useRealHome

  // Replicate the shell's brand-suite seam inside the throwaway home: one
  // link per suite plugin, so the composed loader can resolve @dsh-app/*.
  // Without this the overlay's rows all fail to import and the kernel never
  // prints its settled URL — the probe would blame the plugin for a missing
  // harness seam. The real home already has these links (the shell creates
  // them at boot), so it is left untouched.
  if (!useRealHome) {
    const scope = path.join(dshHome, 'profiles', 'node_modules', '@dsh-app')
    mkdirSync(scope, { recursive: true })
    for (const dir of SUITE_DIRS) {
      const target = path.join(root, 'plugins', dir)
      if (!existsSync(path.join(target, 'package.json'))) {
        throw new Error(`suite plugin missing at ${target} (built?)`)
      }
      symlinkSync(target, path.join(scope, dir), 'junction')
    }
  }

  console.log(`kernel   : ${checkout}`)
  console.log(`overlay  : ${OVERLAY}`)
  console.log(`port     : ${port}`)
  console.log(`DSH_HOME : ${dshHome}${useRealHome ? '  (REAL — user patch layers apply)' : ''}\n`)

  const out = []
  // Redirect stdio into the log file: waitHealthy parses the settled URL out
  // of it (the same harvest the shell's server.ts does), so an in-memory
  // buffer would leave the probe waiting on a file that never fills.
  const logFd = openSync(logPath, 'a')
  const child = spawn(
    `pnpm dsh web --patch "${OVERLAY}" --host 127.0.0.1 --port ${port} --no-open`,
    [],
    {
      cwd: checkout,
      shell: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, DSH_HOME: dshHome, DSH_APP_LOG_DIR: logDir },
    },
  )

  let base = ''
  try {
    const settled = await waitHealthy(logPath)
    base = new URL(settled).origin
    console.log(`settled  : ${base}\n`)

    console.log('1. 路由存活')
    const config = await getJson(base, `${ROUTE}/config`)
    check('GET /config 返回 200', config.status === 200, `status=${config.status}`)
    check('ok:true 信封', config.body?.ok === true, config.body?.error?.message ?? '')
    const view = config.body?.value
    check('seamAvailable=true（ctx.web 存在）', view?.seamAvailable === true)
    check('引擎清单 5 个', Array.isArray(view?.engines) && view.engines.length === 5, `got ${view?.engines?.length}`)
    check('provider 默认为 dsh-app', view?.file?.provider === 'dsh-app', `got ${view?.file?.provider}`)
    console.log(`     引擎: ${(view?.engines ?? []).map(e => e.id).join(', ')}`)
    if (view === undefined) throw new Error(`config route unusable: ${config.text.slice(0, 300)}`)

    console.log('\n1b. 搜索来源状态（两边的真实可用性）')
    const providers = view.providers ?? []
    check('两个来源都带状态', providers.length === 2, `got ${providers.length}`)
    for (const p of providers) {
      console.log(`     ${p.id}: state=${p.state} selected=${String(p.selected)}${p.reason === undefined ? '' : ` — ${p.reason}`}`)
    }
    check('品牌链报告为可用', providers.find(p => p.id === 'dsh-app')?.state === 'ready')
    const upstream = providers.find(p => p.id === 'deepseek-official')
    check('官方来源带明确状态（不静默缺失）',
      ['ready', 'unavailable', 'unknown'].includes(upstream?.state ?? ''),
      `state=${upstream?.state}`)
    if (useRealHome) {
      // The real home disables the web-search-deepseek row, so the provider is
      // NOT registered and the settings page must say so. Reporting "ready"
      // here would be the exact defect this check exists for: the user picks
      // 官方, and every search fails with WEB_PROVIDER_CONFIGURED_MISSING.
      check('官方来源被正确报告为不可用（该行已禁用）', upstream?.state === 'unavailable', `state=${upstream?.state}`)
      check('不可用原因可读且指出未注册', typeof upstream?.reason === 'string' && upstream.reason.includes('未注册'), upstream?.reason ?? '（无 reason）')
    }

    console.log('\n2. 跨站请求被拒（同源 + 环回双重围栏）')
    const evil = await fetch(`${base}${ROUTE}/config`, {
      headers: { origin: 'https://evil.example', host: 'evil.example' },
      signal: AbortSignal.timeout(10_000),
    })
    check('伪造 Origin 得到 403', evil.status === 403, `status=${evil.status}`)

    console.log('\n3. 真实引擎探测（真网络）')
    const probe = await getJson(base, `${ROUTE}/engine/test`, {
      method: 'POST',
      body: JSON.stringify({ query: 'DeepSeek Harness', id: 'bing' }),
    })
    check('POST /engine/test 返回 200', probe.status === 200, `status=${probe.status}`)
    const bing = probe.body?.value?.results?.find(r => r.id === 'bing')
    check('Bing 探测成功', bing?.ok === true, bing?.ok ? `${bing.resultCount} 条 / ${bing.latencyMs}ms` : bing?.error)

    const any = await getJson(base, `${ROUTE}/engine/test`, {
      method: 'POST',
      body: JSON.stringify({ query: 'DeepSeek Harness', id: 'anysearch' }),
    })
    const anyRow = any.body?.value?.results?.find(r => r.id === 'anysearch')
    check('AnySearch 探测成功（匿名 JSON API）', anyRow?.ok === true,
      anyRow?.ok === true ? `${anyRow.resultCount} 条 / ${anyRow.latencyMs}ms` : (anyRow?.error ?? 'no row'))

    console.log('\n4. 真实搜索（经 ctx.web 的 web_search 同一条路径）')
    const selftest = await getJson(base, `${ROUTE}/selftest`, {
      method: 'POST',
      body: JSON.stringify({ query: 'DeepSeek Harness' }),
    })
    check('POST /selftest 返回 200', selftest.status === 200, `status=${selftest.status}`)
    const st = selftest.body?.value
    check('seam 解析到 dsh-app', st?.provider === 'dsh-app', `provider=${st?.provider}`)
    check('经 seam 搜索真的拿到结果', (st?.resultCount ?? 0) > 0, `${st?.resultCount ?? 0} 条 / ${st?.latencyMs ?? 0}ms${st?.error === undefined ? '' : ` err=${st.error}`}`)

    console.log('\n5. 配置写入往返（含密钥脱敏）')
    if (useRealHome) {
      // Never write to the user's real config from a probe: a test that
      // mutates the state it is inspecting can leave the machine changed.
      console.log('     (--real-home：跳过写入类测试，避免改动真实配置)')
    } else {
    const save = await getJson(base, `${ROUTE}/config/save`, {
      method: 'POST',
      body: JSON.stringify({ ...view.file, maxResults: 7 }),
    })
    check('POST /config/save 返回 200', save.status === 200, `status=${save.status}`)
    check('maxResults 已持久化', save.body?.value?.file?.maxResults === 7, `got ${save.body?.value?.file?.maxResults}`)
    const configFile = path.join(dshHome, 'storages', 'dsh-app-plugin-websearch', 'config.json')
    check('配置文件已落盘', existsSync(configFile), configFile)

    console.log('\n6. 非法输入被拒')
    const bad = await getJson(base, `${ROUTE}/config/save`, {
      method: 'POST',
      body: JSON.stringify({ ...view.file, timeoutMs: 1, searxngInstances: ['not-a-url'] }),
    })
    check('非法 SearXNG 实例得到 400', bad.status === 400, `status=${bad.status} msg=${bad.body?.error?.message ?? ''}`)

    console.log('\n7. 原生/品牌切换')
    const flip = await getJson(base, `${ROUTE}/config/save`, {
      method: 'POST',
      body: JSON.stringify({ ...view.file, provider: 'deepseek-official' }),
    })
    check('切换到 deepseek-official', flip.body?.value?.file?.provider === 'deepseek-official')
    // A switch that only writes the field proves nothing: the seam must
    // actually RESOLVE the upstream provider. If the kernel's
    // web-search-deepseek row is disabled, nothing registered
    // `deepseek-official` and this search fails with
    // WEB_PROVIDER_CONFIGURED_MISSING — which is exactly the state a user
    // reaches by disabling the upstream row and then trying the switch.
    const onUpstream = await getJson(base, `${ROUTE}/selftest`, {
      method: 'POST',
      body: JSON.stringify({ query: 'DeepSeek Harness' }),
    })
    const up = onUpstream.body?.value
    console.log(`     切到官方后自检: ${up?.error === undefined ? `${String(up?.resultCount ?? 0)} 条` : `error=${up.error}`}`)
    const back = await getJson(base, `${ROUTE}/config/save`, {
      method: 'POST',
      body: JSON.stringify({ ...view.file, provider: 'dsh-app' }),
    })
    check('切回 dsh-app', back.body?.value?.file?.provider === 'dsh-app')

    console.log('\n8. 真实回退（把不可达引擎排在最前）')
    // Point the chain at a dead host first, so the fall-through is driven by a
    // genuine network failure rather than a fake. SearXNG with an unreachable
    // instance is exactly the "user misconfigured an engine" case.
    const deadFirst = {
      ...view.file,
      searxngInstances: ['http://127.0.0.1:9/nope'],
      engines: [
        { id: 'searxng', enabled: true, priority: 0 },
        { id: 'bing', enabled: true, priority: 1 },
      ],
    }
    const dead = await getJson(base, `${ROUTE}/config/save`, {
      method: 'POST',
      body: JSON.stringify(deadFirst),
    })
    check('写入"死引擎优先"配置', dead.status === 200, `status=${dead.status}`)
    const fallback = await getJson(base, `${ROUTE}/selftest`, {
      method: 'POST',
      body: JSON.stringify({ query: 'DeepSeek Harness' }),
    })
    const fb = fallback.body?.value
    check('回退后仍返回结果', (fb?.resultCount ?? 0) > 0, `${fb?.resultCount ?? 0} 条${fb?.error === undefined ? '' : ` err=${fb.error}`}`)
    check('实际生效引擎是 bing（searxng 已失败）', fb?.engine === 'bing', `engine=${fb?.engine ?? 'none'}`)
    // The note is the user-visible evidence of the fall-through: without it a
    // silently-degraded search is indistinguishable from a healthy one.
    check('结果带回了回退说明（注明实际生效引擎）', typeof fb?.note === 'string' && /searxng/i.test(fb.note), fb?.note ?? '（无 note）')

    console.log('\n9. 结果缓存（TTL 生效）')
    const repeat = await getJson(base, `${ROUTE}/selftest`, {
      method: 'POST',
      body: JSON.stringify({ query: 'DeepSeek Harness' }),
    })
    const rp = repeat.body?.value
    check('重复查询命中缓存', rp?.cached === true, `cached=${String(rp?.cached)} engine=${rp?.engine ?? 'none'}`)
    }

    // Read-only check, run in BOTH modes: the brand chain must actually answer
    // in this home. In --real-home this is the whole point of the run.
    if (useRealHome) {
      const st = await getJson(base, `${ROUTE}/selftest`, {
        method: 'POST',
        body: JSON.stringify({ query: 'DeepSeek Harness' }),
      })
      const real = st.body?.value
      check('真实环境下品牌链可用', (real?.resultCount ?? 0) > 0,
        `${real?.resultCount ?? 0} 条 engine=${real?.engine ?? 'none'}${real?.error === undefined ? '' : ` err=${real.error}`}`)
    }
  } finally {
    stopChild(child)
    await new Promise(r => setTimeout(r, 1_500))
    closeSync(logFd)
    let log = ''
    try { log = readFileSync(logPath, 'utf8') } catch { /* no log written */ }
    if (failures.length > 0) {
      console.log('\n--- kernel log tail ---')
      console.log(log.split('\n').slice(-40).join('\n'))
    } else {
      // Even on success, surface plugin warnings — a silent degradation is
      // exactly the failure this probe exists to catch.
      const warn = log.split('\n').filter(line => /websearch/i.test(line))
      if (warn.length > 0) {
        console.log('\n--- websearch log lines ---')
        console.log(warn.slice(-15).join('\n'))
      }
    }
    await rm(logDir, { recursive: true, force: true }).catch(() => undefined)
    // NEVER delete a home this probe did not create. `--real-home` points
    // dshHome at the user's actual ~/.dsh, and an unconditional rm here
    // deleted it once (2026-09-15) — unrecoverable, since rm bypasses the
    // recycle bin. The guard is on the DELETE, not just on the writes: the
    // writes were already fenced, which is exactly why the omission here was
    // easy to miss.
    if (ownsHome) {
      await rm(dshHome, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  console.log(`\n${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILED: ${failures.join(', ')}`}`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(`probe crashed: ${error.message}`)
  process.exit(1)
})
