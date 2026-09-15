#!/usr/bin/env node
/**
 * End-to-end probe for the launch-folder seam: the shell passes a directory to
 * a page global installed by the brand client plugin.
 *
 * This is the check a compile-green build cannot give, because the two halves
 * are two different builds joined by nothing but a string:
 *
 *   1. The plugin module (source) is bundled by esbuild exactly as the plugin
 *      build does it, then driven in a real JS engine with fake workspace
 *      services — status tokens, call order, failure codes, disposal.
 *   2. The shell's own injection (dist/main/workspace-launch.js) is evaluated
 *      against the page global that step 1 installed, so the composition of
 *      the two halves is proven, not assumed.
 *   3. The service names the handler resolves ('workspaces', 'uiWorkspace')
 *      and the methods it calls are read off the SHIPPED kernel artifact when
 *      one is installed — an upstream rename is what this seam cannot survive,
 *      and it would otherwise surface only on a user's machine.
 *
 * Usage:
 *   node scripts/probe-launch-folder.mjs
 *   node scripts/probe-launch-folder.mjs --kernel "<userData>/kernel/dsh-<v>"
 *
 * Exits non-zero on any failed assertion.
 */
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)
const { installWorkspaceLaunch, WORKSPACE_LAUNCH_GLOBAL } = loadPluginModule()
const { deliverWorkspaceLaunch, workspaceLaunchScript } = require(path.join(root, 'dist', 'main', 'workspace-launch.js'))

let passed = 0
const failures = []

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1
    return
  }
  failures.push(`${label}${detail === '' ? '' : `: ${detail}`}`)
}

/**
 * Bundle the plugin's launch module with the plugin's own esbuild and load it,
 * so the probe exercises the real source rather than a copy of its logic.
 * @returns the module exports.
 */
function loadPluginModule() {
  const pluginDir = path.join(root, 'plugins', 'plugin-client-ui')
  const pluginRequire = createRequire(path.join(pluginDir, 'package.json'))
  const esbuild = pluginRequire('esbuild')
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-launch-probe-'))
  const outfile = path.join(outDir, 'workspace-launch.cjs')
  try {
    esbuild.buildSync({
      entryPoints: [path.join(pluginDir, 'src', 'client', 'workspace-launch.ts')],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: 'node22',
      outfile,
      logLevel: 'silent',
    })
    return require(outfile)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
}

/** A page double: the module reads the global `window` at call time. */
async function withPage(fn) {
  const page = {}
  globalThis.window = page
  try {
    // Awaited, so an async body finishes before the page goes away.
    return await fn(page)
  } finally {
    delete globalThis.window
  }
}

/** A context double answering `ctx.get(name)` like cordis does. */
function ctxWith(services) {
  return { get: (name) => services[name] }
}

/** Workspace service doubles that record what the handler called. */
function workspaceDoubles({ create, openWorkspace }) {
  const calls = []
  return {
    calls,
    services: {
      workspaces: {
        create: async (input) => {
          calls.push(`create:${input.path}`)
          return create === undefined ? { workspaceId: 'w-1' } : await create(input)
        },
      },
      uiWorkspace: {
        openWorkspace: async (workspaceId) => {
          calls.push(`open:${workspaceId}`)
          if (openWorkspace !== undefined) await openWorkspace(workspaceId)
        },
      },
    },
  }
}

const DIR = process.platform === 'win32' ? 'D:\\projects\\app' : '/projects/app'

// --------------------------------------------------------- plugin half

await (async () => {
  // Every answer is a promise: the handler is async, and the shell awaits it.
  // A probe that read the return value directly would be checking nothing.
  {
    const { calls, services } = workspaceDoubles({})
    const status = await withPage(async (page) => {
      const dispose = installWorkspaceLaunch(ctxWith(services))
      check('apply installs the global', typeof page[WORKSPACE_LAUNCH_GLOBAL] === 'function')
      const status = await page[WORKSPACE_LAUNCH_GLOBAL](DIR)
      check('create then open, in that order', calls.join(',') === `create:${DIR},open:w-1`, calls.join(','))
      dispose()
      check('disposal removes the global', page[WORKSPACE_LAUNCH_GLOBAL] === undefined)
      return status
    })
    check('a wired page answers ok', status === 'ok', String(status))
  }

  {
    // A kernel without the workspace services (or without the suite plugin)
    // must not throw into the shell's injection: it answers 'pending' and the
    // shell's bounded retry gives up quietly.
    const missing = await withPage(async (page) => {
      installWorkspaceLaunch(ctxWith({}))
      return await page[WORKSPACE_LAUNCH_GLOBAL](DIR)
    })
    check('a missing seam answers pending', missing === 'pending', String(missing))
    // A half-provided seam (the service exists, the method does not) is the
    // same case: nothing to call.
    const empty = await withPage(async (page) => {
      installWorkspaceLaunch(ctxWith({ workspaces: {}, uiWorkspace: {} }))
      return await page[WORKSPACE_LAUNCH_GLOBAL](DIR)
    })
    check('an empty seam answers pending', empty === 'pending', String(empty))
  }
})()

await (async () => {
  const cases = [
    ['RemoteError shape', { code: 'workspace/invalid-path' }, 'error:workspace/invalid-path'],
    // The client service wraps a Remote failure in WorkspaceCreateError, whose
    // code lives one level down.
    ['WorkspaceCreateError shape', { rpcError: { code: 'workspace/not-found' } }, 'error:workspace/not-found'],
    ['plain rejection', new Error('network down'), 'error:unexpected'],
  ]
  for (const [label, rejection, expected] of cases) {
    const { services } = workspaceDoubles({ create: async () => { throw rejection } })
    const answer = await withPage((page) => {
      installWorkspaceLaunch(ctxWith(services))
      return page[WORKSPACE_LAUNCH_GLOBAL](DIR)
    })
    check(`create rejection (${label}) → ${expected}`, answer === expected, String(answer))
  }

  const { services } = workspaceDoubles({ openWorkspace: async () => { throw new Error('gone') } })
  const answer = await withPage((page) => {
    installWorkspaceLaunch(ctxWith(services))
    return page[WORKSPACE_LAUNCH_GLOBAL](DIR)
  })
  check('open failure → error:unexpected', answer === 'error:unexpected', String(answer))

  const bad = await withPage((page) => {
    installWorkspaceLaunch(ctxWith(workspaceDoubles({}).services))
    return Promise.all([page[WORKSPACE_LAUNCH_GLOBAL](''), page[WORKSPACE_LAUNCH_GLOBAL](42)])
  })
  check('a non-string path is refused', bad.every((status) => status === 'error:invalid-argument'), bad.join(','))

  // ------------------------------------------------- shell ↔ page composition
  const composition = workspaceDoubles({})
  const page = {}
  globalThis.window = page
  installWorkspaceLaunch(ctxWith(composition.services))
  const target = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      // The shell's script, evaluated against the page the plugin just wired —
      // the same string executeJavaScript would run.
      executeJavaScript: (code) => new Function('window', `return ${code}`)(page),
    },
  }
  const status = await deliverWorkspaceLaunch(target, DIR, { attempts: 3, intervalMs: 1 })
  delete globalThis.window
  check('shell injection opens the workspace', status === 'ok', String(status))
  check('and it reached the services', composition.calls.join(',') === `create:${DIR},open:w-1`, composition.calls.join(','))

  // A page that never installs the global (a vanilla kernel) must be a quiet
  // give-up, not a thrown injection.
  const blank = { isDestroyed: () => false, webContents: { isDestroyed: () => false, executeJavaScript: (code) => new Function('window', `return ${code}`)({}) } }
  check(
    'a page without the plugin times out quietly',
    await deliverWorkspaceLaunch(blank, DIR, { attempts: 2, intervalMs: 1 }) === 'timeout',
  )
  check('and the script is the one the probe ran', workspaceLaunchScript(DIR).includes(WORKSPACE_LAUNCH_GLOBAL))
})()

// ------------------------------------------- shipped-kernel service names

{
  const argv = process.argv.slice(2)
  const explicit = argv.includes('--kernel') ? argv[argv.indexOf('--kernel') + 1] : undefined
  const kernelDir = explicit ?? findInstalledKernel()
  if (kernelDir === undefined) {
    console.log('skip: no installed kernel found (pass --kernel <dir> to check one)')
  } else {
    const modules = path.join(kernelDir, 'app', 'node_modules', '@deepseek-ai')
    const workspaceUi = readSeam(modules, 'dsh-client-ui-workspace')
    const controller = readSeam(modules, 'dsh-api-workspace-controller')
    check('the kernel ships the workspace UI plugin', workspaceUi !== undefined, modules)
    check('the kernel ships the workspace controller', controller !== undefined, modules)
    if (workspaceUi !== undefined && controller !== undefined) {
      // These three strings are the entire contract between the handler and
      // the kernel: a rename upstream breaks the seam silently.
      check('ui-workspace still provides ctx.uiWorkspace', workspaceUi.includes('super(ctx, "uiWorkspace"'))
      check('it still exposes openWorkspace', workspaceUi.includes('openWorkspace('))
      check('the controller still provides ctx.workspaces', controller.includes('super(ctx, "workspaces"'))
      check('its create() is still there', controller.includes('create(input)'))
      check('and the created view still carries workspaceId', controller.includes('workspaceId'))
    }
    console.log(`kernel checked: ${path.basename(kernelDir)}`)
  }
}

/**
 * Read a package's client-half bundle out of a kernel tree.
 * @param modules - `<kernel>/app/node_modules/@deepseek-ai`.
 * @param name - the package directory name.
 * @returns the file text, or undefined when the package is absent.
 */
function readSeam(modules, name) {
  for (const entry of ['lib/client.js', 'lib/index.js']) {
    const file = path.join(modules, name, entry)
    if (existsSync(file)) return readFileSync(file, 'utf8')
  }
  return undefined
}

/**
 * Newest installed kernel under the app's userData, when there is one.
 * @returns the kernel directory, or undefined.
 */
function findInstalledKernel() {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'Library', 'Application Support')
  const kernelRoot = path.join(appData, 'DSH APP', 'kernel')
  if (!existsSync(kernelRoot)) return undefined
  const versions = readdirSync(kernelRoot).filter((name) => name.startsWith('dsh-'))
  return versions.length === 0 ? undefined : path.join(kernelRoot, versions[versions.length - 1])
}

console.log(failures.length === 0 ? `\nRESULT: PASS (${passed} checks)` : `\nRESULT: FAIL (${passed} passed)\n- ${failures.join('\n- ')}`)
process.exitCode = failures.length === 0 ? 0 : 1
