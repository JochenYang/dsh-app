// Launch-folder seam, shell half:
//   - pickWorkspaceArg(): which argv entries may open a folder. It decides on
//     every launch (`electron .` in development passes a directory that is NOT
//     a user request) and on every second launch of a running instance.
//   - workspaceLaunchScript() + deliverWorkspaceLaunch(): the injection into a
//     preload-less renderer. The retry budget is what makes a kernel without
//     the brand suite a quiet give-up instead of a stuck launch, so the loop's
//     boundary behavior is tested here, on a fake window.
// The page-side handler is a different build (plugin-client-ui); the one thing
// the two halves must agree on is the global's spelling, and a drift is silent
// (the shell would retry a handler that exists under another name), so it is
// asserted against both sources below.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const {
  deliverWorkspaceLaunch,
  pickWorkspaceArg,
  queueWorkspaceArg,
  takeQueuedWorkspace,
  workspaceLaunchScript,
  WORKSPACE_LAUNCH_GLOBAL,
} = require('../dist/main/workspace-launch.js')

const ROOT = path.resolve(import.meta.dirname, '..')

/**
 * Argument-parsing context over a fixed set of directories.
 * @param dirs - the directories that "exist" (resolved like the real probe).
 * @param overrides - context fields to override.
 * @returns a WorkspaceArgContext.
 */
function argContext(dirs, overrides = {}) {
  const cwd = path.resolve('/work/cwd')
  const known = dirs.map((dir) => path.resolve(dir))
  return {
    cwd,
    appPath: path.resolve('/app/checkout'),
    isDirectory: (candidate) => known.includes(path.resolve(candidate)),
    ...overrides,
  }
}

/** A window double whose injections answer from a script. */
function fakeWindow(answers) {
  const calls = []
  // Closures, not `this`: the flags are set on the window, and the shell asks
  // the webContents half about its own destruction.
  const win = {
    gone: false,
    webGone: false,
    calls,
    isDestroyed() { return win.gone },
    webContents: {
      isDestroyed() { return win.webGone },
      async executeJavaScript(code) {
        calls.push(code)
        const next = answers.length > 0 ? answers.shift() : 'pending'
        if (next instanceof Error) throw next
        return next
      },
    },
  }
  return win
}

/** Options that keep the retry loop instant. */
function fastOptions(extra = {}) {
  const sleeps = []
  return {
    options: { attempts: 3, intervalMs: 7, sleep: async (ms) => { sleeps.push(ms) }, ...extra },
    sleeps,
  }
}

test('pickWorkspaceArg takes a directory argument and skips switches', () => {
  const dir = path.resolve('/projects/app')
  const ctx = argContext([dir])
  assert.equal(pickWorkspaceArg(['/bin/dsh-app', dir], ctx), dir)
  // Electron, Chromium and macOS each add their own switches; none is a path.
  assert.equal(pickWorkspaceArg(['/bin/dsh-app', '--inspect', '-psn_0_1', dir], ctx), dir)
  // The executable itself is never a candidate, even when it is a directory.
  assert.equal(pickWorkspaceArg([dir], ctx), null)
})

test('pickWorkspaceArg resolves relative arguments against that launch cwd', () => {
  const ctx = argContext(['/work/cwd/sub'])
  assert.equal(pickWorkspaceArg(['/bin/dsh-app', 'sub'], ctx), path.resolve('/work/cwd/sub'))
  // The second-instance event reports the cwd of the process that lost the
  // lock, which is not this one.
  const other = argContext(['/elsewhere/sub'], { cwd: '/elsewhere' })
  assert.equal(pickWorkspaceArg(['/bin/dsh-app', 'sub'], other), path.resolve('/elsewhere/sub'))
})

test('pickWorkspaceArg ignores the app own directory and anything not a directory', () => {
  const ctx = argContext(['/projects/app'])
  // `electron .` — every development launch — resolves to the checkout.
  assert.equal(pickWorkspaceArg(['/bin/dsh-app', '.'], ctx), null)
  assert.equal(pickWorkspaceArg(['/bin/dsh-app', '/app/checkout'], ctx), null)
  // A missing path or a file is not this seam's business: opening a dialog at
  // startup over an argv we merely guessed at would be worse than nothing.
  assert.equal(pickWorkspaceArg(['/bin/dsh-app', '/projects/missing'], ctx), null)
  assert.equal(pickWorkspaceArg(['/bin/dsh-app', ''], ctx), null)
  assert.equal(pickWorkspaceArg(['/bin/dsh-app'], ctx), null)
  // The first usable candidate wins; a later one does not displace it.
  assert.equal(
    pickWorkspaceArg(['/bin/dsh-app', '/projects/missing', '/projects/app', '/projects/app'], ctx),
    path.resolve('/projects/app'),
  )
})

test('queueWorkspaceArg keeps a queued folder when a later launch names none', () => {
  // Nothing queued, nothing to reopen.
  assert.equal(takeQueuedWorkspace(), null)
  assert.equal(
    queueWorkspaceArg(['/bin/dsh-app', '/projects/app'], argContext(['/projects/app'])),
    path.resolve('/projects/app'),
  )
  // An argv without a folder is not a request to cancel one: the first launch
  // may still be installing its kernel when the second process appears.
  assert.equal(queueWorkspaceArg(['/bin/dsh-app'], argContext([])), null)
  assert.equal(takeQueuedWorkspace(), path.resolve('/projects/app'))
  // Consumed once: a later reload must not reopen anything on its own.
  assert.equal(takeQueuedWorkspace(), null)
})

test('the injected script answers pending until the page owns the global', async () => {
  const dir = path.resolve('/projects/app')
  const script = workspaceLaunchScript(dir)
  assert.match(script, new RegExp(WORKSPACE_LAUNCH_GLOBAL, 'u'))
  // The guard has to come first: a page whose client plugin has not applied
  // yet must be distinguishable from a refusal.
  const run = (win) => new Function('window', `return ${script}`)(win)
  assert.equal(run({}), 'pending')
  // The script always hands back a promise (it awaits the handler's work), so
  // a verdict is only a verdict once it settles — which is exactly what
  // executeJavaScript does before the shell reads it.
  assert.equal(await run({ [WORKSPACE_LAUNCH_GLOBAL]: () => 'ok' }), 'ok')
  const pending = run({ [WORKSPACE_LAUNCH_GLOBAL]: () => Promise.resolve('ok') })
  assert.equal(typeof pending.then, 'function')
  assert.equal(await pending, 'ok')
})

test('the injected script passes the path through as data', () => {
  // A Windows path is the common case, and its backslashes must survive the
  // trip: JSON.stringify is the only quoting applied.
  const dir = 'D:\\projects\\it\'s here\\app'
  const script = workspaceLaunchScript(dir)
  const seen = []
  new Function('window', `return ${script}`)({ [WORKSPACE_LAUNCH_GLOBAL]: (p) => { seen.push(p); return 'ok' } })
  assert.deepEqual(seen, [dir])
})

test('the injected script turns a throwing or rejecting handler into a token', async () => {
  const script = workspaceLaunchScript('/projects/app')
  const run = (win) => new Function('window', `return ${script}`)(win)
  assert.equal(run({ [WORKSPACE_LAUNCH_GLOBAL]: () => { throw new Error('boom') } }), 'error:threw')
  assert.equal(await run({ [WORKSPACE_LAUNCH_GLOBAL]: async () => { throw new Error('boom') } }), 'error:rejected')
})

test('deliverWorkspaceLaunch settles on the first verdict that is not pending', async () => {
  const dir = path.resolve('/projects/app')
  const { options, sleeps } = fastOptions()
  const win = fakeWindow(['ok'])
  assert.equal(await deliverWorkspaceLaunch(win, dir, options), 'ok')
  assert.equal(win.calls.length, 1)
  assert.match(win.calls[0], /projects/u)
  assert.deepEqual(sleeps, [])
})

test('deliverWorkspaceLaunch retries while the page is not ready', async () => {
  const { options, sleeps } = fastOptions()
  const win = fakeWindow(['pending', 'pending', 'ok'])
  assert.equal(await deliverWorkspaceLaunch(win, '/projects/app', options), 'ok')
  assert.equal(win.calls.length, 3)
  assert.deepEqual(sleeps, [7, 7])
})

test('deliverWorkspaceLaunch gives up after the attempt budget', async () => {
  const { options, sleeps } = fastOptions()
  const win = fakeWindow([])
  // A kernel without the brand suite never installs the handler: the app must
  // open its normal window, not sit in a retry loop.
  assert.equal(await deliverWorkspaceLaunch(win, '/projects/app', options), 'timeout')
  assert.equal(win.calls.length, 3)
  // The last attempt must not be followed by a pointless sleep.
  assert.deepEqual(sleeps, [7, 7])
})

test('deliverWorkspaceLaunch survives an injection lost to a navigation', async () => {
  const { options } = fastOptions()
  const failures = []
  const win = fakeWindow([new Error('Script failed to execute'), 'ok'])
  const status = await deliverWorkspaceLaunch(win, '/projects/app', { ...options, onError: (e) => failures.push(e) })
  assert.equal(status, 'ok')
  assert.equal(failures.length, 1)
})

test('deliverWorkspaceLaunch reports the window it cannot reach', async () => {
  const { options } = fastOptions()
  const window = fakeWindow(['ok'])
  window.gone = true
  assert.equal(await deliverWorkspaceLaunch(window, '/projects/app', options), 'gone')
  assert.equal(window.calls.length, 0)
  const web = fakeWindow(['ok'])
  web.webGone = true
  assert.equal(await deliverWorkspaceLaunch(web, '/projects/app', options), 'gone')
})

test('deliverWorkspaceLaunch carries the host failure code through, and flags a stranger', async () => {
  const { options } = fastOptions()
  const refused = fakeWindow(['error:workspace/invalid-path'])
  assert.equal(
    await deliverWorkspaceLaunch(refused, '/projects/missing', options),
    'error:workspace/invalid-path',
  )
  // A page answering a contract this shell does not know (a newer or older
  // plugin) is reported instead of polling the budget away.
  const stranger = fakeWindow([undefined])
  assert.equal(await deliverWorkspaceLaunch(stranger, '/projects/app', options), 'error:unexpected')
  assert.equal(stranger.calls.length, 1)
})

test('both builds spell the launch global the same way', () => {
  const shell = readFileSync(path.join(ROOT, 'src/main/workspace-launch.ts'), 'utf8')
  const plugin = readFileSync(path.join(ROOT, 'plugins/plugin-client-ui/src/client/workspace-launch.ts'), 'utf8')
  const declared = (source) => source.match(/WORKSPACE_LAUNCH_GLOBAL = '([^']+)'/u)?.[1]
  assert.equal(declared(shell), WORKSPACE_LAUNCH_GLOBAL)
  assert.equal(declared(plugin), WORKSPACE_LAUNCH_GLOBAL)
  // Installed, not merely defined: an unused module would leave the shell
  // retrying a handler nobody ever put on the page.
  const entry = readFileSync(path.join(ROOT, 'plugins/plugin-client-ui/src/client.ts'), 'utf8')
  assert.match(entry, /installWorkspaceLaunch/u)
})
