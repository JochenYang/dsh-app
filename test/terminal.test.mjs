/**
 * The managed terminal's plan: which console each platform starts, what the
 * shell inside it inherits, and the shim directory that makes `dsh` mean THIS
 * app's kernel.
 *
 * What is under test is the DECISION, not the window: `terminalPlan` is a pure
 * function of platform, environment, paths and an injected executable resolver,
 * so both platform branches are covered on one machine and no console is opened
 * by the suite. The file/spawn boundary is covered through `openManagedTerminal`
 * with the spawn seam stubbed and a throwaway user-data directory — plus the one
 * case marked REAL SPAWN below, which runs a real child to exercise the Windows
 * outcome judgement. THAT case is the only one here that puts a window on the
 * user's desktop, so it does not run by default: set
 * `DSH_APP_TERMINAL_REAL_SPAWN=1` to run it (the case itself says why
 * `windowsHide` cannot cover it).
 *
 * HOW THIS FILE STAYS OFF ITS HOST. Every plan input is injected — platform,
 * environment, paths, and a resolver that is the plan's ONLY door to the
 * filesystem — so the Windows and POSIX shapes are asserted on any machine, and
 * no expectation is spelled with the host's path module (`path.win32`, or a
 * literal, because `path.join` on a Linux host joins with `/`). Three things
 * cannot be injected away, and each is keyed on `process.platform` with its
 * reason at the case:
 *
 *   - a REAL child process (REAL SPAWN: only a Windows host has `cmd.exe`), and
 *     only when `DSH_APP_TERMINAL_REAL_SPAWN=1` — `start` opens a real console;
 *   - the console code page (the non-ASCII case: a cmd fact, pinned with `chcp`);
 *   - an open-level test of the WINDOWS plan, which needs a host that can be
 *     given the shim directory the plan spells in Windows form (`\tmp\…` is not
 *     a path on Linux). The plan itself is asserted everywhere; what those cases
 *     add is the spawn boundary. The same boundary is covered for the host's own
 *     branch by the cases that inject nothing platform-specific.
 *
 * WHAT THIS FILE CANNOT SEE, AND WHY. On Windows the console belongs to the
 * system from the moment `start` runs (`terminal.ts`, module header): no
 * assertion here — and none through the spawn seam — can observe a window. That
 * is how a tray item that appeared to do nothing shipped with a green suite
 * three times over. The visible half is measured BY HAND, from a real Electron
 * parent, with the probes in `scratch/window-probe/`:
 *
 *   node_modules/.bin/electron scratch/window-probe
 *
 * `main.js` calls the REAL `openManagedTerminal` and prints the Windows window
 * inventory either side of it (this is the experiment that caught the bug);
 * `shapes.js` compares spawn shapes side by side; `visible.js` judges one shape
 * by the window inventory alone; `powershell-shape.js` forces the PowerShell
 * handoff. Re-run one of them after ANY change to `planWindows`.
 *
 * Three cases exist to fail when a key behaviour is broken, and they are marked
 * REVERSE below: the shim directory must be the FIRST `PATH` entry (moving it to
 * the end fails them), `DSH_APP_PROFILE` must be set to the booted profile (not
 * setting it fails them), and the console preference chain must be honoured in
 * order (skipping a step fails them). A fourth is implicit in the argv
 * assertions: `start` must be in them, or the console is the process we spawned
 * — which inherits NUL for stdin and dies before it is painted.
 *
 * Run after the build: node --test test/   (or: npm test)
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const {
  TERMINAL_BIN_DIR_NAME,
  openManagedTerminal,
  resolveExecutable,
  terminalBinDir,
  terminalLogLine,
  terminalPlan,
  withTerminalPath,
} = require('../dist/main/terminal.js')

const NODE = 'C:\\rt\\node\\node.exe'
const CLI = 'C:\\rt\\app\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
const SHIM_DIR = 'C:\\Users\\u\\AppData\\Roaming\\DSH APP\\terminal-bin'
const PNPM_DIR = 'C:\\rt\\pnpm\\bin'
const CMD = 'C:\\Windows\\System32\\cmd.exe'
/**
 * The launcher the Windows plan writes, as a LITERAL. `path.join` here is the
 * HOST's separator: on a Linux machine it yields `…/open.cmd` while the plan
 * spells `…\open.cmd`, which is exactly how these cases turned red on CI while
 * passing on Windows. Nothing in a Windows expectation may come from the host's
 * path module.
 */
const LAUNCHER = `${SHIM_DIR}\\open.cmd`
/** The program a plan for THIS host resolves, injected: it never has to exist. */
const HOST_TERMINAL = process.platform === 'win32' ? 'C:\\host\\cmd.exe' : '/usr/bin/host-terminal'

/** A resolver backed by a table: every lookup a plan makes is spelled out. */
function resolverFor(table) {
  return (candidate) => table[candidate]
}

/** The Windows facts one plan needs; a test overrides only what it is about. */
function windowsInput(overrides = {}) {
  return {
    platform: 'win32',
    env: { Path: 'C:\\Windows\\System32', ComSpec: CMD, PATHEXT: '.EXE;.CMD' },
    shimDir: SHIM_DIR,
    pnpmBinDir: PNPM_DIR,
    nodeBinary: NODE,
    cliPath: CLI,
    dshHome: 'D:\\home',
    profile: 'dsh-app',
    cwd: 'C:\\Users\\u',
    resolve: resolverFor({ 'cmd.exe': CMD, [NODE]: NODE, [CLI]: CLI }),
    ...overrides,
  }
}

/** The POSIX facts one plan needs, spelled for the given platform. */
function posixInput(platform, overrides = {}) {
  const shimDir = platform === 'darwin'
    ? '/Users/u/Library/Application Support/DSH APP/terminal-bin'
    : '/home/u/.config/DSH APP/terminal-bin'
  return {
    platform,
    env: { PATH: '/usr/bin:/bin' },
    shimDir,
    nodeBinary: '/rt/node/bin/node',
    cliPath: '/rt/app/node_modules/@deepseek-ai/dsh/lib/bin.js',
    dshHome: platform === 'darwin' ? '/Users/u/.dsh' : '/home/u/.dsh',
    profile: 'dsh-app',
    cwd: platform === 'darwin' ? '/Users/u' : '/home/u',
    resolve: resolverFor({
      '/rt/node/bin/node': '/rt/node/bin/node',
      '/rt/app/node_modules/@deepseek-ai/dsh/lib/bin.js': '/rt/app/node_modules/@deepseek-ai/dsh/lib/bin.js',
      '/bin/sh': '/bin/sh',
    }),
    ...overrides,
  }
}

/** The file of one plan by name, so an assertion reads as the file it checks. */
function fileOf(plan, name) {
  const found = plan.files.find((file) => file.name === name)
  assert.ok(found !== undefined, `the shim directory must hold ${name}`)
  return found
}

/** The names of the files one plan writes. */
function fileNames(plan) {
  return plan.files.map((file) => file.name)
}

/**
 * A path in one comparable spelling. `os.tmpdir()` hands back the 8.3 short
 * form on this machine (`C:\Users\ADMINI~1\…`) while `cmd` prints the long one,
 * so a plain `startsWith` compares two spellings of the same directory and
 * fails for the wrong reason. A path that is not there keeps its own text: the
 * control case below deliberately resolves to something that does not exist.
 */
function canonical(target) {
  try {
    return realpathSync.native(target).toLowerCase()
  } catch {
    return target.toLowerCase()
  }
}

/** The file name part of a path, in either spelling — what an outcome reports. */
function baseNameOf(target) {
  return target.split(/[\\/]+/u).filter((part) => part !== '').pop() ?? target
}

// ------------------------------------------------------------------ Windows

/** The one argv every Windows plan must produce. */
function windowsArgs(cmd = CMD, launcher = LAUNCHER) {
  return ['/d', '/c', 'start', '', cmd, '/d', '/k', 'call', launcher]
}

/** The non-empty lines of a launcher, so a handoff assertion can name the last one. */
function launcherLines(plan) {
  return fileOf(plan, 'open.cmd').text.split('\r\n').filter((line) => line !== '')
}

test('no Windows expectation in this file is spelled with the HOST path module', () => {
  // THE CLASS THAT REDDENED CI. Every Windows case here passed on a Windows
  // machine and failed on the ubuntu runner, because an expectation built with
  // `path.join` joins with `\` here and `/` there (and `path.join('C:\\a', 'b')`
  // on Linux is not even the same string). A Windows path is a LITERAL or
  // `path.win32.join`; the host module may only spell paths this machine will
  // actually touch (a throwaway directory under `os.tmpdir()`).
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const offenders = source.split('\n')
    .map((text, index) => ({ text: text.trim(), number: index + 1 }))
    .filter(({ text }) => !text.startsWith('*') && !text.startsWith('//'))
    .filter(({ text }) => /path\.join\(/u.test(text) && /SHIM_DIR|C:\\\\/u.test(text))
  assert.deepEqual(offenders, [], 'a Windows path must not be built with the host path module')
})

test('Windows asks cmd.exe for a console through `start`, and the shim directory holds all five files', () => {
  const plan = terminalPlan(windowsInput())
  assert.equal(plan.command, CMD)
  // THE shape, and the only one: `start` creates the console (a console THIS
  // process spawns inherits NUL for stdin and dies before it is painted), the
  // empty argument is the window-title slot `start` requires, and the second cmd
  // is the absolute path the plan resolved rather than a second PATH lookup.
  assert.deepEqual(plan.args, windowsArgs())
  assert.ok(plan.args.includes('start'), 'without `start` the console never appears — the bug this shape fixes')
  assert.deepEqual(fileNames(plan), ['dsh', 'dsh.cmd', 'node', 'node.cmd', 'open.cmd'])
})

test('Windows Terminal is not invoked: the OS routes the `start`ed console to it', () => {
  // Measured on this machine: wt.exe is a handoff stub, and every command line it
  // was handed arrived as nothing (twelve shapes), while a bare program name did
  // start. A resolver that offers it must not change the plan. (It can still be
  // what the user SEES: `start` hands the new console to the default terminal
  // application — that is the OS routing it, not this module running wt.exe.)
  const wt = 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe'
  const plan = terminalPlan(windowsInput({
    resolve: resolverFor({ 'wt.exe': wt, 'cmd.exe': CMD, [NODE]: NODE, [CLI]: CLI }),
  }))
  assert.equal(plan.command, CMD)
  assert.deepEqual(plan.args, windowsArgs())
  assert.ok(!plan.args.some((arg) => arg.includes('wt')), `no wt.exe in ${plan.args.join(' ')}`)
})

test('REVERSE: the private shim directory is the FIRST PATH entry, under its own spelling', () => {
  const input = windowsInput({ env: { Path: 'C:\\Windows\\System32', ComSpec: CMD } })
  const plan = terminalPlan(input)
  // One spelling only: a second `PATH` beside an existing `Path` leaves the
  // platform picking whichever it prefers, which is the bug this rewrite avoids.
  assert.deepEqual(Object.keys(plan.env).filter((name) => name.toUpperCase() === 'PATH'), ['Path'])
  const entries = plan.env.Path.split(';')
  assert.equal(entries[0], SHIM_DIR, 'the shim directory must come first')
  assert.equal(entries[1], PNPM_DIR, 'the bundled pnpm comes next')
  assert.equal(entries.slice(2).join(';'), 'C:\\Windows\\System32', 'the inherited PATH keeps its tail')
  // The launcher repeats the same value, for a console that did not inherit it.
  assert.ok(fileOf(plan, 'open.cmd').text.includes(`set "Path=${plan.env.Path}"`))
  assert.deepEqual(withTerminalPath({ Path: 'a' }, ['s'], 'win32'), { Path: 's;a' })
  assert.deepEqual(withTerminalPath({ PATH: 'a' }, ['s', 'p'], 'linux'), { PATH: 's:p:a' })
})

test('REVERSE: DSH_HOME and DSH_APP_PROFILE are set, and an inherited value loses', () => {
  const input = windowsInput({
    env: { Path: 'C:\\Windows\\System32', ComSpec: CMD, DSH_HOME: 'D:\\other', DSH_APP_PROFILE: 'web' },
  })
  const plan = terminalPlan(input)
  assert.equal(plan.env.DSH_HOME, 'D:\\home')
  assert.equal(plan.env.DSH_APP_PROFILE, 'dsh-app', 'the profile this shell booted, not the one it inherited')
  const launcher = fileOf(plan, 'open.cmd').text
  assert.ok(launcher.includes('set "DSH_HOME=D:\\home"'))
  assert.ok(launcher.includes('set "DSH_APP_PROFILE=dsh-app"'))
})

test('the shims name the Node and the CLI absolutely, in both Windows spellings', () => {
  const plan = terminalPlan(windowsInput())
  const dsh = fileOf(plan, 'dsh')
  assert.equal(dsh.mode, 0o755)
  assert.ok(dsh.text.startsWith('#!/bin/sh\n'))
  // A bare `node` here would re-enter this very directory through the PATH
  // prefix and recurse until the stack dies.
  assert.ok(dsh.text.includes(`exec 'C:/rt/node/node.exe' 'C:/rt/app/node_modules/@deepseek-ai/dsh/lib/bin.js' "$@"`))
  assert.ok(fileOf(plan, 'node').text.includes(`exec 'C:/rt/node/node.exe' "$@"`))
  const cmd = fileOf(plan, 'dsh.cmd').text
  assert.ok(cmd.startsWith('@echo off\r\n'))
  assert.ok(cmd.includes(`"${NODE}" "${CLI}" %*`))
  assert.ok(fileOf(plan, 'node.cmd').text.includes(`"${NODE}" %*`))
  for (const file of plan.files) assert.equal(file.mode, 0o755)
})

test('a path with `%`, a space and a quote is written safely, per launcher syntax', () => {
  const odd = 'C:\\Program Files\\100%\\bin.js'
  const plan = terminalPlan(windowsInput({
    cliPath: odd,
    dshHome: "D:\\it's home",
    resolve: resolverFor({ 'cmd.exe': CMD, [NODE]: NODE, [odd]: odd }),
  }))
  // `%` opens a variable reference in a batch file, so a literal one doubles.
  assert.ok(fileOf(plan, 'dsh.cmd').text.includes('"C:\\Program Files\\100%%\\bin.js"'))
  // The POSIX spelling quotes and leaves `%` alone.
  assert.ok(fileOf(plan, 'dsh').text.includes("'C:/Program Files/100%/bin.js'"))
  // An apostrophe needs no escaping in a batch file, and the paths with spaces
  // are quoted where the launcher changes directory.
  assert.ok(fileOf(plan, 'open.cmd').text.includes('set "DSH_HOME=D:\\it\'s home"'))
  assert.ok(fileOf(plan, 'open.cmd').text.includes('cd /d "C:\\Users\\u"'))
})

test('a value cannot end its own batch line: quote, CR and LF all become data', () => {
  // Measured before the fix: `DSH_HOME=D:\a" & echo PWNED> <file> & rem "` closed
  // the `set "…"` early and the rest of the line ran as commands, creating the
  // file. A CR or LF breaks out even earlier, by ending the line itself.
  const payload = 'D:\\a" & echo PWNED> "x" & rem "\r\nD:\\b'
  const plan = terminalPlan(windowsInput({ dshHome: payload, cwd: payload }))
  const launcher = fileOf(plan, 'open.cmd').text
  const lines = launcher.split('\r\n')
  const home = lines.filter((line) => line.startsWith('set "DSH_HOME='))
  assert.deepEqual(home, ['set "DSH_HOME=D:\\a & echo PWNED> x & rem D:\\b"'],
    'the value stays one line, wrapped in exactly one pair of quotes')
  assert.equal(home[0].match(/"/gu).length, 2, 'a second quote would end the set early')
  assert.ok(!lines.includes('D:\\b'), 'the injected line break must not become a command line')
  assert.equal(lines.filter((line) => line.startsWith('cd /d "')).length, 1)
})

test('a quoted PATH entry is unwrapped, not left to terminate the set line', () => {
  // An installer that writes `…;"C:\Program Files\weird\bin"` into PATH is
  // common, and the quotes are what the pre-fix code wrote straight through:
  // the second `"` ended `set "Path=…"`, truncating PATH and running the rest of
  // the line as a command (measured: `where <tool>` then found nothing).
  const env = { Path: 'C:\\Windows\\System32;"C:\\Program Files\\weird bin"', ComSpec: CMD, PATHEXT: '.EXE;.CMD' }
  const plan = terminalPlan(windowsInput({ env }))
  const line = fileOf(plan, 'open.cmd').text.split('\r\n').find((entry) => entry.startsWith('set "Path='))
  assert.equal(line, `set "Path=${SHIM_DIR};${PNPM_DIR};C:\\Windows\\System32;C:\\Program Files\\weird bin"`)
  assert.equal(line.match(/"/gu).length, 2)
  // The entry itself survives, spaces and all: it just no longer needs quoting.
  assert.ok(line.includes('C:\\Program Files\\weird bin'))
})

// ------------------------------------------------------------ batch code page

test('every generated batch sets the console code page before its first value', () => {
  // `cmd` decodes a batch file with the CONSOLE's code page, and re-reads from
  // the current offset after each command — so this line governs every line
  // below it. Without it a code page 936 console (measured here with `chcp`)
  // reads the UTF-8 this module writes as mojibake and the PATH prefix points at
  // a directory that does not exist.
  const plan = terminalPlan(windowsInput())
  for (const name of ['open.cmd', 'dsh.cmd', 'node.cmd']) {
    const lines = fileOf(plan, name).text.split('\r\n')
    assert.equal(lines[0], '@echo off', `${name} must start with @echo off`)
    assert.equal(lines[1], 'chcp 65001>nul', `${name} must set the code page on its second line`)
  }
  // The POSIX spelling is read by a shell that has no code page to set.
  assert.ok(!fileOf(plan, 'dsh').text.includes('chcp'), 'the sh shim is not a batch file')
})

test('REVERSE: a non-ASCII shim directory still resolves node and dsh to the shim', { skip: process.platform === 'win32' ? false : 'the batch code page is a Windows concern' }, async (t) => {
  // The whole feature on one code page: the shim directory, `$DSH_HOME` and the
  // CLI all carry non-ASCII characters, as they do under a Chinese account name.
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-terminal-cp-'))
  t.after(() => { rmSync(root, { recursive: true, force: true }) })
  const userDataDir = path.join(root, '用户数据 DSH APP')
  const cliDir = path.join(root, '运行时 CLI')
  mkdirSync(cliDir, { recursive: true })
  const cliPath = path.join(cliDir, '入口.js')
  writeFileSync(cliPath, "console.log('dsh-cli-ok')\n")

  const shimDir = path.join(userDataDir, TERMINAL_BIN_DIR_NAME)
  const probe = path.join(root, 'probe.cmd')
  // `chcp 437` pins the console code page, so neither the pass below nor the
  // failure after it can come from whatever this machine happens to default to.
  // `call`: invoking a .cmd from inside a batch hands control over without it,
  // and the probe would stop at the first shim it ran.
  writeFileSync(probe, [
    '@echo off',
    'chcp 437>nul',
    'call "%~1\\open.cmd"',
    'where node',
    'where dsh',
    'call dsh --version',
    '',
  ].join('\r\n'))

  const outcome = await openManagedTerminal({
    userDataDir,
    nodeBinary: process.execPath,
    cliPath,
    dshHome: path.join(root, '主目录'),
    profile: 'dsh-app',
    cwd: root,
    env: process.env,
    resolve: (candidate) => resolveExecutable(candidate, process.env, 'win32'),
    // The Windows contract: the spawned process is the `start` wrapper, so the
    // outcome settles on its EXIT rather than on `spawn` (see startConsole).
    spawnImpl: () => {
      const child = new EventEmitter()
      setImmediate(() => { child.emit('spawn'); child.emit('exit', 0, null) })
      return child
    },
  })
  assert.equal(outcome.status, 'opened')

  const run = () => {
    const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', probe, shimDir], {
      cwd: root,
      env: process.env,
      windowsHide: true,
      encoding: 'utf8',
    })
    return (result.stdout ?? '').split(/\r?\n/).filter((line) => line.trim() !== '')
  }

  const resolved = run()
  assert.ok(resolved.length >= 3, `the probe must report at least where/two results: ${resolved.join(' | ')}`)
  assert.equal(resolved[resolved.length - 1], 'dsh-cli-ok',
    'dsh must run the CLI this plan named, not the machine\'s own')
  assert.ok(canonical(resolved[0]).startsWith(canonical(shimDir)),
    `node must resolve to the shim first, got ${resolved[0]}`)

  // The control: without the code page line the same probe must NOT find the
  // shim, which is what makes the assertions above non-vacuous.
  for (const name of ['open.cmd', 'dsh.cmd', 'node.cmd']) {
    const file = path.join(shimDir, name)
    writeFileSync(file, readFileSync(file, 'utf8').replace('chcp 65001>nul\r\n', ''))
  }
  const garbled = run()
  assert.ok(garbled.length > 0, 'the probe still answers something')
  assert.notEqual(garbled[garbled.length - 1], 'dsh-cli-ok',
    'with the console on 437 the CLI path must garble and the shim CLI must not run')
  assert.ok(!canonical(garbled[0]).startsWith(canonical(shimDir)),
    `node must fall through to the machine's own install, got ${garbled[0]}`)
})

test('a POSIX shell spelling inherited from Git Bash is refused: cmd is the console, and the handoff stays cmd', () => {
  const plan = terminalPlan(windowsInput({
    env: { Path: 'C:\\Windows', SHELL: '/bin/bash.exe', ComSpec: CMD },
    resolve: resolverFor({ 'cmd.exe': CMD, '/bin/bash.exe': '/bin/bash.exe', [NODE]: NODE, [CLI]: CLI }),
  }))
  assert.equal(plan.command, CMD)
  assert.deepEqual(plan.args, windowsArgs())
  assert.equal(launcherLines(plan).at(-1), 'cd /d "C:\\Users\\u"', 'nothing to hand off to: the batch ends at its own prompt')
})

test('REVERSE: a native bash on Windows is not handed the console — cmd keeps it', () => {
  const bash = 'C:\\Program Files\\Git\\bin\\bash.exe'
  const plan = terminalPlan(windowsInput({
    env: { Path: 'C:\\Windows', SHELL: bash, ComSpec: CMD },
    resolve: resolverFor({ 'cmd.exe': CMD, [bash]: bash, [NODE]: NODE, [CLI]: CLI }),
  }))
  // A POSIX shell on Windows reads PATH in MSYS form (`:` separators, `/c/...`
  // entries: `C:/Windows/System32` as a PATH entry resolves nothing there), which
  // a Windows environment cannot be converted into without guessing. So it is
  // neither the console (cmd always is) nor the handoff at the end of the batch.
  assert.equal(plan.command, CMD)
  assert.deepEqual(plan.args, windowsArgs())
  assert.ok(!fileNames(plan).includes('open.sh'))
  assert.equal(launcherLines(plan).at(-1), 'cd /d "C:\\Users\\u"')
})

test('with neither SHELL nor ComSpec, the console is the SystemRoot cmd.exe and the batch ends at its prompt', () => {
  const fallback = 'C:\\Windows\\System32\\cmd.exe'
  const plan = terminalPlan(windowsInput({
    env: { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows' },
    resolve: resolverFor({ 'cmd.exe': fallback, [NODE]: NODE, [CLI]: CLI }),
  }))
  assert.equal(plan.command, fallback)
  assert.deepEqual(plan.args, windowsArgs(fallback))
})

test('REVERSE: the handoff chain is the user\'s shell, then PowerShell, then cmd — the console is always cmd', () => {
  const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  const handoff = `"${powershell}" -NoLogo -NoExit`
  // A ComSpec that IS PowerShell: cmd still opens the console (it is what `start`
  // runs in, and the one interpreter the batch's `set` lines are written for),
  // and the batch's LAST line hands the console to PowerShell.
  const declared = terminalPlan(windowsInput({
    env: { Path: 'C:\\Windows', ComSpec: powershell },
    resolve: resolverFor({ 'powershell.exe': powershell, 'cmd.exe': CMD, [NODE]: NODE, [CLI]: CLI }),
  }))
  assert.equal(declared.command, CMD, 'the shell preference no longer picks the console')
  assert.deepEqual(declared.args, windowsArgs())
  assert.equal(launcherLines(declared).at(-1), handoff)

  // No SHELL and no ComSpec: PowerShell is the handoff before cmd.
  const fallback = terminalPlan(windowsInput({
    env: { Path: 'C:\\Windows' },
    resolve: resolverFor({ 'powershell.exe': powershell, 'cmd.exe': CMD, [NODE]: NODE, [CLI]: CLI }),
  }))
  assert.equal(fallback.command, CMD)
  // No inline `-Command` anywhere: it would have to survive cmd's parsing twice
  // (`cmd /c start`, then the batch), where `%` expands and quotes and `^` die.
  assert.ok(!fallback.args.some((arg) => arg.includes('-Command')), fallback.args.join(' '))
  assert.ok(!fallback.args.some((arg) => arg.includes('$env:')), fallback.args.join(' '))
  const lines = launcherLines(fallback)
  assert.equal(lines.at(-1), handoff)
  // The environment still travels as the batch's own `set`/`cd` lines.
  assert.ok(lines.some((line) => line === `set "Path=${SHIM_DIR};${PNPM_DIR};C:\\Windows"`))
  assert.ok(lines.some((line) => line === 'set "DSH_HOME=D:\\home"'))
  assert.ok(lines.some((line) => line === 'set "DSH_APP_PROFILE=dsh-app"'))
  assert.ok(lines.some((line) => line === 'cd /d "C:\\Users\\u"'))

  // A preference that does not resolve stays at cmd, rather than at a shell the
  // user did not ask for and this module cannot reproduce the environment for.
  const missing = terminalPlan(windowsInput({
    env: { Path: 'C:\\Windows', ComSpec: 'C:\\nope\\pwsh.exe' },
    resolve: resolverFor({ 'cmd.exe': CMD, [NODE]: NODE, [CLI]: CLI }),
  }))
  assert.equal(missing.command, CMD)
  assert.equal(launcherLines(missing).at(-1), 'cd /d "C:\\Users\\u"')
})

test('a cmd.exe that cannot be resolved is an actionable failure, not a silent plan', () => {
  assert.throws(
    () => terminalPlan(windowsInput({ resolve: resolverFor({ [NODE]: NODE, [CLI]: CLI }) })),
    /cmd\.exe could not be resolved/u,
  )
  // PowerShell being present is NOT a substitute: every Windows terminal is
  // started through cmd, so no cmd means no terminal — never a different program
  // opened quietly in its place.
  const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  assert.throws(
    () => terminalPlan(windowsInput({
      env: { Path: 'C:\\Windows', ComSpec: powershell },
      resolve: resolverFor({ [powershell]: powershell, [NODE]: NODE, [CLI]: CLI }),
    })),
    /cmd\.exe could not be resolved/u,
  )
})

test('an unresolvable Node fails the plan instead of writing a shim that cannot run', () => {
  assert.throws(
    () => terminalPlan(windowsInput({ nodeBinary: 'node', resolve: resolverFor({ 'cmd.exe': CMD, [CLI]: CLI }) })),
    /the Node that runs the kernel CLI could not be resolved: node/u,
  )
  assert.throws(
    () => terminalPlan(windowsInput({ resolve: resolverFor({ 'cmd.exe': CMD, [NODE]: NODE }) })),
    /the active kernel's CLI is not there/u,
  )
})

test('no kernel at all is a state, not a missing file: the message says what to do', async () => {
  // `kernelCliPath()` answers '' exactly when this machine has no active kernel,
  // and the message used to end at ": " — an empty path and nothing to act on.
  // Checked for BOTH branches: "no kernel" is not a platform fact.
  const windows = () => terminalPlan(windowsInput({ cliPath: '', resolve: resolverFor({ 'cmd.exe': CMD, [NODE]: NODE }) }))
  assert.throws(windows, /no usable kernel yet/u)
  assert.throws(windows, /finish a first start/u)
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-terminal-nokernel-'))
  try {
    assert.throws(() => terminalPlan(hostInput(userDataDir, { cliPath: '' })), /no usable kernel yet/u)
    const outcome = await openManagedTerminal(openOptions(hostInput(userDataDir, { cliPath: '' }), userDataDir, {
      spawnImpl: () => { throw new Error('must not be reached') },
    }))
    assert.equal(outcome.status, 'failed')
    // The code is what the caller picks the user-visible line by; the detail is
    // log-only English.
    assert.equal(outcome.code, 'no-kernel')
  } finally {
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

// --------------------------------------------------------------------- POSIX

test('macOS opens Terminal.app on the launcher, with a login shell', () => {
  const plan = terminalPlan(posixInput('darwin', {
    env: { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' },
    resolve: resolverFor({
      '/bin/zsh': '/bin/zsh',
      open: '/usr/bin/open',
      '/rt/node/bin/node': '/rt/node/bin/node',
      '/rt/app/node_modules/@deepseek-ai/dsh/lib/bin.js': '/rt/app/node_modules/@deepseek-ai/dsh/lib/bin.js',
    }),
  }))
  assert.equal(plan.command, '/usr/bin/open')
  assert.deepEqual(plan.args, ['-a', 'Terminal', path.posix.join(posixInput('darwin').shimDir, 'open.sh')])
  const launcher = fileOf(plan, 'open.sh').text
  assert.ok(launcher.includes(`export PATH='${posixInput('darwin').shimDir}:/usr/bin:/bin'`))
  assert.ok(launcher.includes("export DSH_HOME='/Users/u/.dsh'"))
  assert.ok(launcher.includes("export DSH_APP_PROFILE='dsh-app'"))
  assert.ok(launcher.endsWith("exec '/bin/zsh' -l\n"))
  assert.deepEqual(fileNames(plan), ['dsh', 'node', 'open.sh'])
})

test('macOS without SHELL falls back to the platform defaults', () => {
  const plan = terminalPlan(posixInput('darwin', {
    resolve: resolverFor({
      '/bin/zsh': '/bin/zsh',
      open: '/usr/bin/open',
      '/rt/node/bin/node': '/rt/node/bin/node',
      '/rt/app/node_modules/@deepseek-ai/dsh/lib/bin.js': '/rt/app/node_modules/@deepseek-ai/dsh/lib/bin.js',
    }),
  }))
  assert.ok(fileOf(plan, 'open.sh').text.endsWith("exec '/bin/zsh' -l\n"))
})

test('Linux tries the emulator families in order, and spells each one its own way', () => {
  const found = {
    'x-terminal-emulator': '/usr/bin/x-terminal-emulator',
    'gnome-terminal': '/usr/bin/gnome-terminal',
    konsole: '/usr/bin/konsole',
    xterm: '/usr/bin/xterm',
    '/bin/sh': '/bin/sh',
    '/rt/node/bin/node': '/rt/node/bin/node',
    '/rt/app/node_modules/@deepseek-ai/dsh/lib/bin.js': '/rt/app/node_modules/@deepseek-ai/dsh/lib/bin.js',
  }
  const shimDir = posixInput('linux').shimDir
  const launcher = path.posix.join(shimDir, 'open.sh')
  const first = terminalPlan(posixInput('linux', { resolve: resolverFor(found) }))
  assert.equal(first.command, '/usr/bin/x-terminal-emulator')
  assert.deepEqual(first.args, ['-e', launcher])
  assert.equal(first.env.PATH, `${shimDir}:/usr/bin:/bin`)
  assert.ok(fileOf(first, 'open.sh').text.endsWith("exec '/bin/sh'\n"))

  const gnome = terminalPlan(posixInput('linux', {
    resolve: resolverFor({ ...found, 'x-terminal-emulator': undefined }),
  }))
  assert.equal(gnome.command, '/usr/bin/gnome-terminal')
  assert.deepEqual(gnome.args, ['--', launcher], 'GNOME Terminal takes `--`, not the deprecated `-e`')

  const onlyXterm = terminalPlan(posixInput('linux', {
    resolve: resolverFor({ ...found, 'x-terminal-emulator': undefined, 'gnome-terminal': undefined, konsole: undefined }),
  }))
  assert.equal(onlyXterm.command, '/usr/bin/xterm')
  assert.deepEqual(onlyXterm.args, ['-e', launcher])
})

test('a Linux machine with no emulator of the four fails with the list it tried', () => {
  assert.throws(
    () => terminalPlan(posixInput('linux', {
      resolve: resolverFor({
        '/bin/sh': '/bin/sh',
        '/rt/node/bin/node': '/rt/node/bin/node',
        '/rt/app/node_modules/@deepseek-ai/dsh/lib/bin.js': '/rt/app/node_modules/@deepseek-ai/dsh/lib/bin.js',
      }),
    })),
    /x-terminal-emulator, gnome-terminal, konsole, xterm/u,
  )
})

// ------------------------------------------------------- resolver + outcomes

test('resolveExecutable honours PATH, PATHEXT and absolute candidates', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-terminal-resolve-'))
  try {
    writeFileSync(path.join(dir, 'thing'), 'x')
    writeFileSync(path.join(dir, 'thing.cmd'), 'x')
    const env = { PATH: `${dir}${path.delimiter}/nowhere`, PATHEXT: '.CMD;.EXE' }
    const resolved = resolveExecutable('thing', env)
    assert.ok(resolved !== undefined && resolved.toLowerCase().endsWith(process.platform === 'win32' ? 'thing.cmd' : 'thing'))
    assert.equal(resolveExecutable(path.join(dir, 'thing'), env), path.join(dir, 'thing'))
    assert.equal(resolveExecutable(path.join(dir, 'missing.exe'), env), undefined)
    assert.equal(resolveExecutable('', env), undefined)
    assert.equal(resolveExecutable('nowhere-at-all', env), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * The facts a plan for THIS host needs, every lookup injected — the same idea as
 * `windowsInput`/`posixInput`, for whichever branch this machine takes. The
 * injected resolver is the plan's only door to the filesystem, so nothing here
 * depends on what the machine has installed (`PATH` is emptied for the same
 * reason), and the shim directory is derived from the throwaway user-data
 * directory exactly as `openManagedTerminal` derives it, so the plan and the
 * write agree on ONE spelling.
 */
function hostInput(userDataDir, overrides = {}) {
  const table = { [NODE]: NODE, [CLI]: CLI, '/bin/sh': '/bin/sh' }
  if (process.platform === 'win32') table['cmd.exe'] = HOST_TERMINAL
  if (process.platform === 'darwin') { table['/bin/zsh'] = '/bin/zsh'; table.open = '/usr/bin/open' }
  if (process.platform === 'linux') table['x-terminal-emulator'] = HOST_TERMINAL
  return {
    platform: process.platform,
    env: process.platform === 'win32' ? { Path: '', PATHEXT: '.EXE;.CMD' } : { PATH: '' },
    shimDir: path.join(userDataDir, TERMINAL_BIN_DIR_NAME),
    nodeBinary: NODE,
    cliPath: CLI,
    dshHome: 'D:\\home',
    profile: 'dsh-app',
    cwd: userDataDir,
    resolve: resolverFor(table),
    ...overrides,
  }
}

/**
 * The `openManagedTerminal` options for a plan input. `shimDir` is DROPPED here:
 * `openManagedTerminal` derives it from the user-data directory instead, and
 * {@link hostInput} derives the same string, so the spelling the plan uses is the
 * one that gets written.
 */
function openOptions(input, userDataDir, extra = {}) {
  const { shimDir, ...options } = input
  return { ...options, userDataDir, ...extra }
}

test('openManagedTerminal writes the shim directory and starts the console this host plans', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-terminal-open-'))
  const input = hostInput(userDataDir)
  const calls = []
  const spawnStub = (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    setImmediate(() => { child.emit('spawn'); child.emit('exit', 0, null) })
    return child
  }
  try {
    const plan = terminalPlan(input)
    const outcome = await openManagedTerminal(openOptions(input, userDataDir, { spawnImpl: spawnStub }))
    assert.equal(outcome.status, 'opened')
    // Windows reports the wrapper's exit, POSIX the `spawn` event; the stub emits
    // both, so this one case covers either branch of startConsole.
    assert.equal(outcome.terminal, baseNameOf(HOST_TERMINAL))
    const shimDir = path.join(userDataDir, TERMINAL_BIN_DIR_NAME)
    const launcher = process.platform === 'win32' ? 'open.cmd' : 'open.sh'
    assert.deepEqual(readdirSync(shimDir).sort(), plan.files.map((file) => file.name).sort())
    assert.ok(readFileSync(path.join(shimDir, launcher), 'utf8').includes('dsh-app'))
    if (process.platform !== 'win32') {
      // Windows has no executable bit; `chmod` there only toggles read-only.
      assert.ok((statSync(path.join(shimDir, 'dsh')).mode & 0o111) !== 0, 'the shims must be executable')
    }
    // The boundary: what reaches `spawn` is the plan, command, argv and all.
    assert.equal(calls.length, 1)
    assert.equal(calls[0].command, plan.command)
    assert.deepEqual(calls[0].args, plan.args)
    assert.equal(calls[0].options.windowsHide, false, 'the console is a window the user asked for')
    assert.equal(calls[0].options.env.DSH_APP_PROFILE, 'dsh-app')

    // Idempotent: a second open rewrites nothing and opens exactly one more.
    const before = readFileSync(path.join(shimDir, launcher), 'utf8')
    const second = await openManagedTerminal(openOptions(input, userDataDir, { spawnImpl: spawnStub }))
    assert.equal(second.status, 'opened')
    assert.equal(readFileSync(path.join(shimDir, launcher), 'utf8'), before)
    assert.equal(calls.length, 2)
  } finally {
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('REAL-SHAPE: the Windows plan reaches spawn as the `start` shape, and the wrapper exit decides', {
  skip: process.platform === 'win32' ? false : 'the plan spells its shim directory in Windows form, which this host cannot be given as a path',
}, async (t) => {
  // Only the WINDOWS plan is asserted here, and it needs a Windows host for one
  // reason: `joinFor('win32', …)` spells the shim directory `\tmp\…`, which is not
  // a path a POSIX filesystem can be handed. Everything the plan DECIDES is
  // asserted on every host above; what this case adds is the plan as spawn sees it
  // (the shape the window depends on), plus the Windows half of startConsole.
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-terminal-win-'))
  t.after(() => { rmSync(userDataDir, { recursive: true, force: true }) })
  const shimDir = path.join(userDataDir, TERMINAL_BIN_DIR_NAME)
  const input = windowsInput({ shimDir, env: { Path: '', PATHEXT: '.EXE;.CMD' } })
  const calls = []
  // The Windows contract: the spawned process is the `start` wrapper, so the
  // outcome settles on its EXIT, not on `spawn` (see startConsole).
  const spawnStub = (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    setImmediate(() => { child.emit('spawn'); child.emit('exit', 0, null) })
    return child
  }
  const first = await openManagedTerminal(openOptions(input, userDataDir, { spawnImpl: spawnStub }))
  assert.deepEqual(first, { status: 'opened', terminal: 'cmd.exe' })
  assert.deepEqual(readdirSync(shimDir).sort(), ['dsh', 'dsh.cmd', 'node', 'node.cmd', 'open.cmd'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, CMD)
  assert.deepEqual(calls[0].args, windowsArgs(CMD, path.win32.join(shimDir, 'open.cmd')),
    'the `start` shape, at the boundary rather than only in the plan')
  assert.equal(calls[0].options.windowsHide, false, 'the console is a window the user asked for')

  // Idempotent: a second open rewrites nothing and opens exactly one more.
  const before = readFileSync(path.join(shimDir, 'dsh.cmd'), 'utf8')
  const second = await openManagedTerminal(openOptions(input, userDataDir, { spawnImpl: spawnStub }))
  assert.equal(second.status, 'opened')
  assert.equal(readFileSync(path.join(shimDir, 'dsh.cmd'), 'utf8'), before)
  assert.equal(calls.length, 2)

  // The judgement itself: a wrapper that exits non-zero, or is killed, must not be
  // reported as success — `start` failing is the one part of the request still
  // observable from here. (The real child that proves the exit code end to end is
  // the REAL SPAWN case at the end of this file.)
  const exited = await openManagedTerminal(openOptions(input, userDataDir, {
    spawnImpl: () => { const c = new EventEmitter(); setImmediate(() => { c.emit('spawn'); c.emit('exit', 3, null) }); return c },
  }))
  assert.equal(exited.status, 'failed', 'a wrapper that exits non-zero must not report success')
  assert.equal(exited.code, 'spawn')
  assert.match(exited.detail, /the console wrapper exited with code 3/u)
  const killed = await openManagedTerminal(openOptions(input, userDataDir, {
    spawnImpl: () => { const c = new EventEmitter(); setImmediate(() => { c.emit('spawn'); c.emit('exit', null, 'SIGKILL') }); return c },
  }))
  assert.equal(killed.status, 'failed')
  assert.equal(killed.code, 'spawn')
  assert.match(killed.detail, /the console wrapper was killed by SIGKILL/u)
})

test('a click while a console is still starting is ignored, and a hung one gives up', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-terminal-busy-'))
  try {
    const input = hostInput(userDataDir)
    const options = openOptions(input, userDataDir, {
      // A child that neither exits nor errors: the second click must not stack a
      // window, and the entry must not stay blocked forever.
      spawnImpl: () => new EventEmitter(),
      spawnTimeoutMs: 20,
    })
    const first = openManagedTerminal(options)
    const during = await openManagedTerminal(options)
    assert.deepEqual(during, { status: 'busy' })
    const settled = await first
    assert.equal(settled.status, 'failed')
    assert.equal(settled.code, 'timeout', 'the caller picks its line by this code')
    assert.match(settled.detail, /did not start within the timeout/u)
    // The flag is released, so the menu works again after a failure.
    const after = await openManagedTerminal({
      ...options,
      spawnImpl: () => { const c = new EventEmitter(); setImmediate(() => { c.emit('spawn'); c.emit('exit', 0, null) }); return c },
    })
    assert.equal(after.status, 'opened')
  } finally {
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('a refused or throwing spawn is reported, never thrown, and never opens', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-terminal-fail-'))
  try {
    const input = hostInput(userDataDir)
    const refused = await openManagedTerminal(openOptions(input, userDataDir, {
      spawnImpl: () => { const child = new EventEmitter(); setImmediate(() => child.emit('error', new Error('EPERM'))); return child },
    }))
    assert.equal(refused.status, 'failed')
    assert.equal(refused.code, 'spawn')
    assert.match(refused.detail, /the console refused to start: EPERM/u)
    const threw = await openManagedTerminal(openOptions(input, userDataDir, {
      spawnImpl: () => { throw new Error('no such console') },
    }))
    assert.deepEqual(threw, { status: 'failed', code: 'unknown', detail: 'no such console' })
    // A plan that cannot be built never reaches spawn, and the injected resolver is
    // its only door to this machine — so an unresolvable Node fails the same way
    // whatever this host happens to have installed.
    const noPlan = await openManagedTerminal(openOptions({ ...input, nodeBinary: 'node' }, userDataDir, {
      spawnImpl: () => { throw new Error('must not be reached') },
    }))
    assert.equal(noPlan.code, 'no-node')
    assert.match(noPlan.detail, /the Node that runs the kernel CLI could not be resolved/u)
  } finally {
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('terminalLogLine names what was requested, or the one thing that has to change', () => {
  // Not "opened": on Windows the console belongs to the system after `start`, and
  // nothing here can see whether a window exists. A log line claiming otherwise
  // is what made a terminal that never appeared read as a working feature.
  assert.equal(terminalLogLine({ status: 'opened', terminal: 'cmd.exe' }), '[terminal] asked for a terminal via cmd.exe')
  assert.match(terminalLogLine({ status: 'busy' }), /already starting/u)
  assert.equal(terminalLogLine({ status: 'failed', detail: 'boom' }), '[terminal] could not open a terminal: boom')
})

test('the shim directory lives in the shell data directory, spelled per platform', () => {
  assert.equal(terminalBinDir('C:\\Users\\u\\AppData\\Roaming\\DSH APP', 'win32'), SHIM_DIR)
  assert.equal(terminalBinDir('/home/u/.config/DSH APP', 'linux'), '/home/u/.config/DSH APP/terminal-bin')
  assert.equal(TERMINAL_BIN_DIR_NAME, 'terminal-bin')
})

test('a shim directory that cannot be created is a failure, not a silent no-op', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-terminal-file-'))
  try {
    // `hostInput` derives the shim directory from this same root, so the plan aims
    // at it whatever branch this host takes. A FILE where the directory must go
    // makes `mkdir` fail with ENOTDIR/EEXIST.
    const input = hostInput(userDataDir)
    writeFileSync(input.shimDir, 'not a directory')
    const outcome = await openManagedTerminal(openOptions(input, userDataDir, {
      spawnImpl: () => { throw new Error('must not be reached') },
    }))
    assert.equal(outcome.status, 'failed')
    assert.equal(outcome.code, 'shim-write', 'an unwritable shim directory is its own advice')
    assert.ok(outcome.detail !== '', 'the reason is reported for the log')
  } finally {
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('a real plan does not touch the user environment it was derived from', () => {
  const env = { Path: 'C:\\Windows', ComSpec: CMD }
  const plan = terminalPlan(windowsInput({ env }))
  assert.notEqual(plan.env, env)
  assert.deepEqual(env, { Path: 'C:\\Windows', ComSpec: CMD })
})

// --------------------------------------------------------------- REAL SPAWN
//
// THE ONE CASE THAT STARTS A REAL CHILD, AND THE ONLY ONE HERE THAT OPENS A
// WINDOW. Everything above proves the plan; this proves the Windows OUTCOME
// judgement against a real process, which no EventEmitter can do. It is still
// NOT a window test — `start` hands the console to the system, so nothing here
// can see one. The argv is therefore rewritten to a shape that opens a console
// for a moment and leaves nothing behind, and the visible half is measured by
// hand in `scratch/window-probe/` (see this file's header) after any change to
// `planWindows`.
//
// WHY IT IS OFF BY DEFAULT. That console IS a window on the user's desktop:
// `start` creates it with CREATE_NEW_CONSOLE, and the `windowsHide: false` the
// plan spawns with is not what puts it there — `windowsHide` covers only the
// DIRECT child, and the direct child is the wrapper asking for the console, not
// the console. (Measured, `scratch/window-watch/watch.ps1`: the `start` shape
// creates a console — a `PseudoConsoleWindow` and its console host — while the
// same command without `start` creates none.) So a suite that runs this case by
// default flashes a console at whoever is using the machine, on every run,
// while the suite itself cannot see it. `DSH_APP_TERMINAL_REAL_SPAWN=1` is the
// way in when this link really has to be verified.

/** Whether the case that opens a real console may run; see the block above. */
const REAL_SPAWN_ENABLED = process.env.DSH_APP_TERMINAL_REAL_SPAWN === '1'
/** What a skipped run says: the case is reachable, and this is how to reach it. */
const REAL_SPAWN_SKIP = 'needs a REAL console, which is a window on this desktop (Windows `start`): not run by default — set DSH_APP_TERMINAL_REAL_SPAWN=1 to run it'

test('REAL SPAWN: a real Windows wrapper is judged by its exit code', {
  skip: process.platform === 'win32'
    ? (REAL_SPAWN_ENABLED ? false : REAL_SPAWN_SKIP)
    : 'a real child here means cmd.exe, which only a Windows host has',
}, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-terminal-real-'))
  t.after(() => { rmSync(root, { recursive: true, force: true }) })
  const cliPath = path.join(root, 'bin.js')
  writeFileSync(cliPath, "console.log('dsh-cli-ok')\n")
  const options = {
    userDataDir: root,
    nodeBinary: process.execPath,
    cliPath,
    dshHome: path.join(root, 'home'),
    profile: 'dsh-app',
    cwd: os.homedir(),
    env: process.env,
    resolve: (candidate) => resolveExecutable(candidate, process.env, 'win32'),
  }

  // Through the real `start`: the outer cmd hands the console to the system and
  // exits 0 immediately, so the plan answers `opened` — from a real child, not a
  // stub. `exit 0` inside the new console makes it disappear at once, so nothing
  // outlives the test.
  const started = await openManagedTerminal({
    ...options,
    spawnImpl: (command, args, spawnOptions) => {
      assert.deepEqual(args.slice(0, 4), ['/d', '/c', 'start', ''], 'the shape under test must keep `start`')
      assert.equal(args[4], command, 'the console cmd is the absolute path the plan resolved')
      return spawn(command, ['/d', '/c', 'start', '', args[4], '/d', '/c', 'exit 0'], spawnOptions)
    },
  })
  assert.deepEqual(started, { status: 'opened', terminal: 'cmd.exe' })

  // The judgement itself, on a real child: a wrapper that exits non-zero must NOT
  // be reported as success. No `start` in this one — this half is about the exit
  // code, and the shape that says anything about a window is the one above.
  const refused = await openManagedTerminal({
    ...options,
    spawnImpl: (command, args, spawnOptions) => {
      assert.equal(args[2], 'start', 'the plan under test is still the start shape')
      return spawn(command, ['/d', '/c', 'exit 3'], spawnOptions)
    },
  })
  assert.equal(refused.status, 'failed')
  assert.equal(refused.code, 'spawn')
  assert.match(refused.detail, /the console wrapper exited with code 3/u)
})

// WHY THERE IS NO "DROPPING `start` TURNS THIS RED" CASE HERE. It cannot be
// written as an outcome assertion, and pretending otherwise would be worse than
// saying so: the old shape (`cmd /d /k call <launcher>`) starts, exits 0 the
// moment its NUL stdin reads EOF, and leaves no trace a child process can query —
// which is exactly how the bug survived three rounds of green tests. What DOES
// turn red is the shape assertion: `plan.args` must contain `start` (see the first
// Windows case, and the argv REAL-SHAPE checks at the spawn boundary above).
// Removing it from `planWindows` fails those cases on any host; that was verified
// by doing it. The window itself is only ever proven by hand —
// `node_modules/.bin/electron scratch/window-probe`.
