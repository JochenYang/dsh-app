#!/usr/bin/env node
/**
 * Suite smoke probe: boots a REAL dsh web kernel with the full brand-suite
 * overlay and asserts every suite plugin's runtime surface. This is the
 * executable answer to the "compile-green ≠ runtime-green" kernel-bump
 * failure mode (AGENTS.md §6): the type gate cannot see across the
 * plugin/kernel boundary, this probe can.
 *
 * Modes (mutually exclusive):
 *   --runtime <dir>   extracted runtime dir containing node/ + app/
 *                     (what build-runtime.mjs lays out under a work dir,
 *                     or an installed <userData>/kernel/dsh-* dir)
 *   --tgz <file>      runtime tarball (extracted to a temp dir first)
 *   (default)         dev checkout: probes ../deepseek-harness and
 *                     ../../deepseek-harness, launches `pnpm dsh web`
 *
 * What is asserted:
 *   1. health: GET / answers 200 within 90 s;
 *   2. every suite plugin's settings routes answer 200 with ok:true;
 *   3. every dual-face plugin's client bundle is served non-empty;
 *   4. the plugin-mcp dynamic-mount chain works end to end: create a stdio
 *      server pointing at scripts/fixtures/minimal-mcp-server.mjs, poll until
 *      it reports mounted with >= 1 live mcp__<server>__* tool, then delete
 *      it (leaving the store empty).
 *
 * The probe always runs against a THROWAWAY DSH_HOME (temp dir) — the user's
 * real ~/.dsh is never touched. Exit code 0 = all green.
 *
 * @module scripts/smoke-suite
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, openSync, closeSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OVERLAY = path.join(root, 'plugins', 'dsh-app.patch.yml')
const SUITE_DIRS = ['plugin-brand', 'plugin-client-ui', 'plugin-sidebar', 'plugin-swarm', 'plugin-usage', 'plugin-archives', 'plugin-memory', 'plugin-fff', 'plugin-mcp', 'plugin-hooks']
const FIXTURE = path.join(root, 'scripts', 'fixtures', 'minimal-mcp-server.mjs')
const MCP_PREFIX = '/plugins/@dsh-app/plugin-mcp/api'

// --- args --------------------------------------------------------------------

function parseArgs(argv) {
  const args = { mode: 'dev' }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--runtime') { args.mode = 'runtime'; args.runtime = argv[++i] }
    else if (argv[i] === '--tgz') { args.mode = 'tgz'; args.tgz = argv[++i] }
    else if (argv[i] === '--dev-checkout') { args.mode = 'dev'; args.devCheckout = argv[++i] }
    else throw new Error(`unknown argument: ${argv[i]}`)
  }
  return args
}

// --- launch spec -------------------------------------------------------------

function findDevCheckout() {
  for (const candidate of [path.resolve(root, '..', 'deepseek-harness'), path.resolve(root, '..', '..', 'deepseek-harness')]) {
    if (existsSync(path.join(candidate, 'package.json'))) return candidate
  }
  throw new Error('dev checkout not found (../deepseek-harness or ../../deepseek-harness); pass --dev-checkout / --runtime / --tgz')
}

/** Extract a runtime tgz into a temp dir; returns <tmp>/runtime. */
async function extractTgz(tgzPath) {
  const work = await mkdtemp(path.join(tmpdir(), 'dsh-smoke-rt-'))
  await new Promise((resolve, reject) => {
    // Array form with shell:false on every platform: tar needs no shell, and
    // array+shell on Windows mangles quoting (DEP0190 class). Both paths are
    // script-built absolute paths passed as argv, never a command line.
    const child = spawn('tar', ['-xf', tgzPath, '-C', work], { stdio: 'inherit', shell: false })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))))
    child.on('error', reject)
  })
  const dir = path.join(work, 'runtime')
  if (!existsSync(path.join(dir, 'app'))) throw new Error(`unexpected tgz layout: ${dir} has no app/`)
  return { dir, cleanup: () => rmSync(work, { recursive: true, force: true }) }
}

/**
 * Launch spec for the kernel child: command/args/cwd + the suite plugin
 * source dir (where @dsh-app/* packages live: repo in dev, runtime in prod).
 */
function buildLaunch(args) {
  if (args.mode === 'runtime' || args.mode === 'tgz') {
    // Absolute, and the rest of the spec derives from it. spawn resolves a
    // RELATIVE executable against the child's cwd (the `cwd` option below),
    // not this process's, so a relative runtime dir became
    // `smoke-rt/runtime/app/smoke-rt/runtime/node/node` and died with ENOENT
    // on Linux — the probe's own path handling, not the kernel's.
    const dir = path.resolve(args.mode === 'tgz' ? args.extracted.dir : args.runtime)
    const nodeBin = path.join(dir, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
    const script = path.join(dir, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (!existsSync(nodeBin) || !existsSync(script)) throw new Error(`runtime dir incomplete: ${dir}`)
    return {
      command: nodeBin,
      args: [script, '--profile', 'web', '--patch', OVERLAY, '--host', '127.0.0.1', '--port', String(args.port), '--no-open'],
      cwd: path.join(dir, 'app'),
      suiteSource: path.join(dir, 'app', 'node_modules', '@dsh-app'),
      shell: false,
    }
  }
  const checkout = args.devCheckout ?? findDevCheckout()
  if (process.platform === 'win32') {
    // pnpm is a .cmd on Windows: one shell-resolved command line, like the
    // shell's own server.ts dev path.
    return {
      command: `pnpm dsh web --patch "${OVERLAY}" --host 127.0.0.1 --port ${String(args.port)} --no-open`,
      args: [],
      cwd: checkout,
      suiteSource: path.join(root, 'plugins'),
      shell: true,
    }
  }
  return {
    command: 'pnpm',
    args: ['dsh', 'web', '--patch', OVERLAY, '--host', '127.0.0.1', '--port', String(args.port), '--no-open'],
    cwd: checkout,
    suiteSource: path.join(root, 'plugins'),
    shell: false,
  }
}

// --- helpers -----------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

/** Session cookie captured by waitHealthy; sent on every probe request. */
let authCookie = ''

async function getJson(base, route) {
  const response = await fetch(`${base}${route}`, {
    signal: AbortSignal.timeout(15_000),
    headers: authCookie === '' ? {} : { cookie: authCookie },
  })
  const text = await response.text()
  let body = null
  try { body = JSON.parse(text) } catch { /* non-JSON: keep text in the error path */ }
  return { status: response.status, body, text }
}

/**
 * Wait for the settled server URL (`dsh web: http://…?token=…` line in the
 * child log — the same harvest the shell's server.ts does), then establish a
 * session the way the shell's probeHealth does: the token URL answers with a
 * 303 + session cookie, or already 200s. Returns { url, cookie } where
 * `url` is the same-origin base for every probe and `cookie` authenticates
 * the API routes (node fetch keeps no cookie jar).
 */
async function waitHealthy(logPath, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  let settled = ''
  while (Date.now() < deadline) {
    try {
      const log = readFileSync(logPath, 'utf8')
      const match = /(?:^|\s)dsh web:\s+(http:\/\/\S+)/m.exec(log)
      if (match !== null) {
        settled = match[1]
        break
      }
    } catch { /* log not written yet */ }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  if (settled === '') {
    let tail = ''
    try { tail = readFileSync(logPath, 'utf8').split('\n').slice(-30).join('\n') } catch { /* no log */ }
    throw new Error(`server never printed its settled URL. Last log lines:\n${tail}`)
  }
  while (Date.now() < deadline) {
    try {
      const exchange = await fetch(settled, { redirect: 'manual', signal: AbortSignal.timeout(3_000) })
      if (exchange.ok) return { url: settled, cookie: firstCookie(exchange.headers) }
      if (exchange.status === 303) {
        const cookie = firstCookie(exchange.headers)
        const next = new URL(exchange.headers.get('location') ?? '', settled)
        const follow = await fetch(next, { redirect: 'manual', signal: AbortSignal.timeout(3_000), headers: cookie === '' ? {} : { cookie } })
        if (follow.ok) return { url: settled, cookie }
        return { url: settled, cookie }
      }
    } catch { /* not accepting connections yet */ }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error(`server answered but never became healthy at ${settled}`)
}

function stopChild(child) {
  if (child === undefined || child.exitCode !== null) return
  child.stopping = true
  if (process.platform === 'win32') {
    // A shell-spawned pnpm tree needs the whole job killed.
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 5_000).unref()
  }
}

/** Resolve when the child exits, or after timeoutMs (the kill is already issued). */
function waitExit(child, timeoutMs = 15_000) {
  if (child === undefined || child.exitCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
}

/** First cookie of a response, tolerating multiple Set-Cookie headers. */
function firstCookie(headers) {
  const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []
  const candidates = list.length > 0 ? list : [headers.get('set-cookie')].filter(value => value !== null)
  return candidates.find(value => /^[^=]+=/.test(value)) ?? candidates[0] ?? ''
}

// --- probes ------------------------------------------------------------------

const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok  ${name}`)
  } else {
    failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`)
    console.error(`FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

async function probeRoute(base, route, name) {
  const { status, body, text } = await getJson(base, route)
  const okJson = status === 200 && body !== null && body.ok === true
  check(name, okJson, okJson ? '' : `HTTP ${status}: ${text.slice(0, 200)}`)
}

async function postJson(base, route, body) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authCookie === '' ? {} : { cookie: authCookie }) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

/**
 * End-to-end dynamic-mount verification: create → poll for mounted+tools →
 * delete → confirm gone. Uses a throwaway serverName so a re-run is clean.
 */
async function probeMcpChain(base) {
  const serverName = 'smokeecho'
  const created = await postJson(base, `${MCP_PREFIX}/server/create`, {
    serverName,
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
    enabled: true,
  })
  check('mcp: create smokeecho server', created.status === 200 && created.body?.ok === true,
    `HTTP ${created.status}: ${JSON.stringify(created.body).slice(0, 200)}`)
  if (created.status !== 200) return

  const id = created.body?.value?.servers?.find(entry => entry.serverName === serverName)?.id
  check('mcp: created entry has an id', typeof id === 'string' && id !== '')

  // Tools appear after the bridge's initial handshake; poll briefly.
  let status = null
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const { body } = await getJson(base, `${MCP_PREFIX}/servers`)
    const entry = body?.value?.servers?.find(candidate => candidate.serverName === serverName)
    status = entry?.status ?? null
    if (status?.state === 'mounted' && (status.toolCount ?? 0) >= 1) break
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  check('mcp: smokeecho mounted with >=1 tool',
    status?.state === 'mounted' && (status.toolCount ?? 0) >= 1,
    `final status: ${JSON.stringify(status)}`)

  // The edit path: update is a FULL-entry replace (the UI always submits the
  // complete form), so fetch the view and flip enabled on it.
  if (typeof id === 'string') {
    const before = await getJson(base, `${MCP_PREFIX}/servers`)
    const view = before.body?.value?.servers?.find(entry => entry.serverName === serverName)
    const disabled = await postJson(base, `${MCP_PREFIX}/server/update`, { ...view, enabled: false })
    check('mcp: update disables the server', disabled.status === 200 && disabled.body?.ok === true,
      `HTTP ${disabled.status}: ${JSON.stringify(disabled.body).slice(0, 200)}`)
    const afterUpdate = await getJson(base, `${MCP_PREFIX}/servers`)
    const updated = afterUpdate.body?.value?.servers?.find(entry => entry.serverName === serverName)
    check('mcp: disabled entry reports disabled status', updated?.enabled === false && updated?.status?.state === 'disabled',
      `view: ${JSON.stringify(updated)}`)
  }

  // The JSON import path: paste-style payload with the wrapper shape, server
  // defined by the fixture under a second name.
  const imported = await postJson(base, `${MCP_PREFIX}/server/import`, {
    json: JSON.stringify({
      mcpServers: {
        smokeecho2: { type: 'stdio', command: process.execPath, args: [FIXTURE] },
      },
    }),
  })
  check('mcp: import smokeecho2 via mcpServers JSON', imported.status === 200 && imported.body?.ok === true
    && (imported.body?.value?.imported ?? []).includes('smokeecho2'),
  `HTTP ${imported.status}: ${JSON.stringify(imported.body).slice(0, 200)}`)
  const importedView = (await getJson(base, `${MCP_PREFIX}/servers`)).body?.value?.servers
    ?.find(entry => entry.serverName === 'smokeecho2')
  check('mcp: imported server mounted', importedView?.status?.state === 'mounted', `view: ${JSON.stringify(importedView)}`)
  await postJson(base, `${MCP_PREFIX}/server/delete`, { id: importedView?.id })

  // Display-name keys auto-slug: "Smoke Echo Two" → "Smoke_Echo_Two".
  const renamed = await postJson(base, `${MCP_PREFIX}/server/import`, {
    json: JSON.stringify({ mcpServers: { 'Smoke Echo Two': { type: 'stdio', command: process.execPath, args: [FIXTURE] } } }),
  })
  const renamedTo = renamed.body?.value?.renamed ?? []
  check('mcp: display-name import auto-slugs with a report',
    renamed.status === 200 && (renamed.body?.value?.imported ?? []).includes('Smoke_Echo_Two')
    && renamedTo.some(entry => entry.from === 'Smoke Echo Two' && entry.to === 'Smoke_Echo_Two'),
  `HTTP ${renamed.status}: ${JSON.stringify(renamed.body).slice(0, 240)}`)
  const renamedView = (await getJson(base, `${MCP_PREFIX}/servers`)).body?.value?.servers
    ?.find(entry => entry.serverName === 'Smoke_Echo_Two')
  await postJson(base, `${MCP_PREFIX}/server/delete`, { id: renamedView?.id })

  const removed = await postJson(base, `${MCP_PREFIX}/server/delete`, { id })
  check('mcp: delete smokeecho server', removed.status === 200 && removed.body?.ok === true,
    `HTTP ${removed.status}: ${JSON.stringify(removed.body).slice(0, 200)}`)
  const after = await getJson(base, `${MCP_PREFIX}/servers`)
  check('mcp: store empty after delete',
    !(after.body?.value?.servers ?? []).some(entry => entry.serverName === serverName))
}

// --- main --------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(OVERLAY)) throw new Error(`overlay missing: ${OVERLAY}`)

  // Built plugins are a precondition in dev mode (runtime mode ships them).
  if (args.mode === 'dev') {
    for (const dir of SUITE_DIRS) {
      // No exceptions: a missing lib/ (including plugin-brand's tsc output)
      // fails fast here instead of a silent vanilla boot downstream.
      if (!existsSync(path.join(root, 'plugins', dir, 'lib', 'index.js'))) {
        throw new Error(`plugins not built (missing plugins/${dir}/lib) — run the plugin builds first`)
      }
    }
  }

  const port = await freePort()
  args.port = port
  if (args.mode === 'tgz') args.extracted = await extractTgz(args.tgz)
  const launch = buildLaunch(args)

  const home = mkdtempSync(path.join(tmpdir(), 'dsh-smoke-home-'))
  // Replicate the shell's brand-suite seam inside the throwaway home:
  // one link per suite plugin, so the composed loader resolves them.
  const scope = path.join(home, 'profiles', 'node_modules', '@dsh-app')
  mkdirSync(scope, { recursive: true })
  for (const dir of SUITE_DIRS) {
    const target = path.join(launch.suiteSource, dir)
    if (!existsSync(path.join(target, 'package.json'))) {
      throw new Error(`suite plugin missing at ${target} (built? runtime complete?)`)
    }
    mkdirSync(path.dirname(path.join(scope, dir)), { recursive: true })
    if (process.platform === 'win32') {
      // Junction via `cmd /c mklink /J` — node symlink('junction') also works.
      const { execFileSync } = await import('node:child_process')
      execFileSync('cmd', ['/c', 'mklink', '/J', `"${path.join(scope, dir)}"`, `"${target}"`], { stdio: 'ignore' })
    } else {
      const { symlinkSync } = await import('node:fs')
      symlinkSync(target, path.join(scope, dir), 'dir')
    }
  }

  const logPath = path.join(home, 'smoke-server.log')
  let child
  let logFd
  try {
    console.log(`smoke: launching kernel (mode=${args.mode}, port=${String(port)}, DSH_HOME=${home})`)
    logFd = openSync(logPath, 'a')
    child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      shell: launch.shell,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, DSH_HOME: home },
    })
    child.on('exit', (code) => {
      if (child.stopping !== true && code !== null && code !== 0) {
        console.error(`smoke: kernel exited early with code ${String(code)}`)
      }
    })

    const session = await waitHealthy(logPath)
    authCookie = session.cookie.split(';')[0] ?? ''
    const base = new URL(session.url).origin
    console.log(`smoke: server healthy at ${base}, probing suite surfaces`)

    for (const [route, name] of [
      ['/plugins/@dsh-app/plugin-usage/api/status', 'usage: status route'],
      ['/plugins/@dsh-app/plugin-memory/api/status', 'memory: status route'],
      ['/plugins/@dsh-app/plugin-archives/api/list', 'archives: list route'],
      ['/plugins/@dsh-app/plugin-archives/api/search?q=probe', 'archives: search route'],
      ['/plugins/@dsh-app/plugin-swarm/api/config', 'swarm: config route'],
      [`${MCP_PREFIX}/servers`, 'mcp: servers route'],
      ['/plugins/@dsh-app/plugin-hooks/api/hooks', 'hooks: hooks route'],
    ]) {
      await probeRoute(base, route, name)
    }

    // Sidebar probe: the git routes demand a live session cwd (scopedCwd),
    // which a throwaway smoke home cannot offer — so assert the MISSING-param
    // shape instead. A 400 { ok:false, code: bad-request } proves the sidebar
    // host half is mounted, fenced, and validating; any 404/500 would mean the
    // routes never registered.
    {
      const sidebar = await getJson(base, '/plugins/@dsh-app/plugin-sidebar/api/git/status')
      check('sidebar: git routes mounted (paramless status rejects 400)',
        sidebar.status === 400 && sidebar.body !== null && sidebar.body.ok === false,
        `HTTP ${sidebar.status}: ${sidebar.text.slice(0, 200)}`)
    }

    // Client bundles are served only as revisioned combo URLs composed from
    // the boot graph injected into the index page (a plain
    // /plugins/<id>/client.js path 404s by design). So verify the dual-face
    // scan the meaningful way: the boot graph must name every suite CLIENT
    // package (by package name — the graph's identity), the advertised combo
    // must include plugin-mcp's bundle, and one combo must actually serve.
    const index = await getJson(base, '/')
    const html = index.text
    // Every suite plugin with a dsh.client half (package.json dsh.client +
    // lib/client.js); host-only plugins (brand, fff) are absent by design.
    const suiteClientPackages = ['@dsh-app/plugin-client-ui', '@dsh-app/plugin-sidebar', '@dsh-app/plugin-swarm', '@dsh-app/plugin-usage', '@dsh-app/plugin-archives', '@dsh-app/plugin-memory', '@dsh-app/plugin-mcp', '@dsh-app/plugin-hooks']
    check('client: boot graph lists suite client packages',
      index.status === 200 && suiteClientPackages.every(id => html.includes(id)),
      `HTTP ${index.status}; ids found: ${suiteClientPackages.filter(id => html.includes(id)).join(',') || 'none'}`)
    const combo = /\/plugins\/\?\?[^"']+/.exec(html)?.[0]?.replace(/&amp;/g, '&')
    check('client: combo bundle URL advertised', typeof combo === 'string')
    if (typeof combo === 'string') {
      check('client: combo bundle includes plugin-mcp', combo.includes('@dsh-app/plugin-mcp/client.js'))
      const served = await getJson(base, combo)
      check('client: combo bundle serves 200', served.status === 200, `HTTP ${served.status} for ${combo.slice(0, 120)}`)
    }

    await probeMcpChain(base)

    // Hooks bridge dynamic-mount chain: create a claude-code bridge pointing
    // at the fixture hooks.json → mounted → disable → delete.
    const HOOKS_FIXTURE = path.join(root, 'scripts', 'fixtures', 'hooks-claude-code.json')
    const HOOKS_ROUTE = '/plugins/@dsh-app/plugin-hooks/api'
    const hookCreated = await postJson(base, `${HOOKS_ROUTE}/bridge/create`, {
      dialect: 'claude-code',
      enabled: true,
      configPath: HOOKS_FIXTURE,
    })
    check('hooks: create claude-code bridge', hookCreated.status === 200 && hookCreated.body?.ok === true,
      `HTTP ${hookCreated.status}: ${JSON.stringify(hookCreated.body).slice(0, 200)}`)
    if (hookCreated.status === 200) {
      const hookId = hookCreated.body?.value?.bridges?.find(b => b.configPath === HOOKS_FIXTURE)?.id
      check('hooks: bridge has an id', typeof hookId === 'string' && hookId !== '')
      // Hooks mount may take a moment (configPath read at load).
      let hookStatus = null
      const hookDeadline = Date.now() + 10_000
      while (Date.now() < hookDeadline) {
        const hookList = await getJson(base, `${HOOKS_ROUTE}/hooks`)
        const bridge = hookList.body?.value?.bridges?.find(b => b.id === hookId)
        hookStatus = bridge?.status ?? null
        if (hookStatus?.state === 'mounted' || hookStatus?.state === 'error') break
        await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
      check('hooks: bridge mounted', hookStatus?.state === 'mounted', `final status: ${JSON.stringify(hookStatus)}`)
      // Disable + re-enable to exercise the update path.
      const hookView = (await getJson(base, `${HOOKS_ROUTE}/hooks`)).body?.value?.bridges?.find(b => b.id === hookId)
      const disabled = await postJson(base, `${HOOKS_ROUTE}/bridge/update`, { ...hookView, enabled: false })
      check('hooks: update disables the bridge', disabled.status === 200 && disabled.body?.ok === true,
        `HTTP ${disabled.status}`)
      await postJson(base, `${HOOKS_ROUTE}/bridge/delete`, { id: hookId })
      const hookAfter = await getJson(base, `${HOOKS_ROUTE}/hooks`)
      check('hooks: bridge gone after delete',
        !(hookAfter.body?.value?.bridges ?? []).some(b => b.id === hookId))

      // Inline-mode bridge: content authored in the UI, saved as a managed
      // file. This is the path that had the configContent-stripped-on-load
      // bug — verify the entry survives a fresh GET after create.
      const inlineCreated = await postJson(base, `${HOOKS_ROUTE}/bridge/create`, {
        dialect: 'claude-code',
        enabled: true,
        configSource: 'inline',
        configContent: JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo inline-hook-smoke' }] }] } }),
      })
      check('hooks: create inline bridge', inlineCreated.status === 200 && inlineCreated.body?.ok === true,
        `HTTP ${inlineCreated.status}: ${JSON.stringify(inlineCreated.body).slice(0, 200)}`)
      if (inlineCreated.status === 200) {
        // The critical assertion: the entry must survive a fresh GET (not
        // dropped as "invalid" by validateBridge on re-read).
        const inlineList = await getJson(base, `${HOOKS_ROUTE}/hooks`)
        const inlineBridge = inlineList.body?.value?.bridges?.find(b => b.configSource === 'inline')
        check('hooks: inline bridge survives re-read', inlineBridge !== undefined && inlineBridge.id !== undefined,
          `bridges: ${JSON.stringify(inlineList.body?.value?.bridges?.map(b => ({ id: b.id, source: b.configSource }))) ?? '[]'}`)
        if (inlineBridge !== undefined) {
          check('hooks: inline bridge has configContent', typeof inlineBridge.configContent === 'string' && inlineBridge.configContent !== '',
            `configContent: ${String(inlineBridge.configContent).slice(0, 80)}`)
          await postJson(base, `${HOOKS_ROUTE}/bridge/delete`, { id: inlineBridge.id })
        }
      }

      // Native-format bridge: DSH APP's own hook format, no kernel bridge
      // mounted — the native runtime registers typed interception handlers.
      const nativeCreated = await postJson(base, `${HOOKS_ROUTE}/bridge/create`, {
        dialect: 'native',
        enabled: true,
        configSource: 'inline',
        configContent: JSON.stringify({ rules: [{ name: 'smoke-block', on: 'pre-tool-use', matcher: 'read|Read', action: 'block', message: 'smoke native block' }] }),
      })
      check('hooks: create native bridge', nativeCreated.status === 200 && nativeCreated.body?.ok === true,
        `HTTP ${nativeCreated.status}: ${JSON.stringify(nativeCreated.body).slice(0, 200)}`)
      if (nativeCreated.status === 200) {
        const nativeList = await getJson(base, `${HOOKS_ROUTE}/hooks`)
        const nativeBridge = nativeList.body?.value?.bridges?.find(b => b.dialect === 'native')
        check('hooks: native bridge survives re-read', nativeBridge !== undefined && nativeBridge.id !== undefined)
        if (nativeBridge !== undefined) {
          check('hooks: native bridge mounted', nativeBridge.status?.state === 'mounted',
            `status: ${JSON.stringify(nativeBridge.status)}`)
          // Event-name contract, end to end through the real kernel: an unknown
          // interception event and an unsupported action-for-event must both
          // surface as an error status naming the offense — never mount, and
          // never fail the create call itself (rule validation lives in
          // native.sync, so create stores the entry and the status reports it).
          for (const [label, rules, match, messageWant] of [
            ['unknown event', [{ name: 'smoke-bad-on', on: 'session-end', action: 'context', message: 'x' }], 'session-end', '的 on'],
            ['unsupported action', [{ name: 'smoke-bad-action', on: 'session-start', action: 'block', message: 'x' }], 'session-start', '不支持'],
          ]) {
            const badCreated = await postJson(base, `${HOOKS_ROUTE}/bridge/create`, {
              dialect: 'native',
              enabled: true,
              configSource: 'inline',
              configContent: JSON.stringify({ rules }),
            })
            check(`hooks: native accepts ${label} entry for validation`, badCreated.status === 200 && badCreated.body?.ok === true,
              `HTTP ${badCreated.status}: ${JSON.stringify(badCreated.body).slice(0, 200)}`)
            if (badCreated.status === 200) {
              const badList = await getJson(base, `${HOOKS_ROUTE}/hooks`)
              const badBridge = badList.body?.value?.bridges?.find(b => typeof b.configContent === 'string' && b.configContent.includes(match) && b.id !== nativeBridge.id)
              check(`hooks: native ${label} reports error status`, badBridge?.status?.state === 'error',
                `status: ${JSON.stringify(badBridge?.status)}`)
              // The error names the offense (event predicate / unsupported pair),
              // proving the rule was validated rather than silently dropped.
              check(`hooks: native ${label} error names the offense`,
                typeof badBridge?.status?.message === 'string' && badBridge.status.message.includes(messageWant),
                `message: ${JSON.stringify(badBridge?.status?.message)}`)
              if (badBridge?.id !== undefined) await postJson(base, `${HOOKS_ROUTE}/bridge/delete`, { id: badBridge.id })
            }
          }
          await postJson(base, `${HOOKS_ROUTE}/bridge/delete`, { id: nativeBridge.id })
        }
      }
    }

    if (failures.length > 0) {
      console.error(`\nsmoke: ${String(failures.length)} check(s) failed`)
      process.exitCode = 1
    } else {
      console.log('\nsmoke: all checks passed')
    }
  } finally {
    stopChild(child)
    if (logFd !== undefined) closeSync(logFd)
    // Wait for the kill to land BEFORE removing the tree: a detached timer
    // would leak the temp dir whenever the process exits first (and Windows
    // rmSync fails EBUSY while the child still holds the log files open).
    await waitExit(child)
    try { rmSync(home, { recursive: true, force: true }) } catch { /* best effort */ }
    if (args.mode === 'tgz' && args.extracted !== undefined) {
      rmSync(path.dirname(args.extracted.dir), { recursive: true, force: true })
    }
  }
}

main().catch((error) => {
  console.error(`smoke: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
