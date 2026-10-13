/**
 * The managed terminal: the tray's "open terminal" entry, and the private shim
 * directory that entry hands the user's own shell.
 *
 * WHY THIS EXISTS. The plugin market installs, removes and upgrades plugins
 * entirely through the GUI, and when one of those operations fails the only
 * advice the panel can give is to edit `cordis.patch.yml` under the profile by
 * hand — while the user has no way at all to run the CLI every one of those
 * operations is built on. That command is `dsh plugin --profile dsh-app add
 * <pkg>`: `--profile` is a REQUIRED option of the kernel's `plugin` subcommand
 * (`plugin.requiredOption('--profile <name>')`), and `DSH_APP_PROFILE` is read
 * only by this repository's own plugins (the market and the presets), never by
 * the CLI. The market keeps its GUI path; this is the escape hatch beside it:
 * the user's own terminal, with `dsh`, `pnpm` and `node` resolving to THIS app's
 * active kernel, so the command the panel's advice implies is one they can
 * actually type.
 *
 * WHAT IT IS NOT. Nothing about the user's machine changes: no system `PATH`
 * edit, no `~/.bashrc` / PowerShell profile write, no kernel source touched and
 * no fork of it. The prefix lives in ONE subprocess environment — plus the
 * launcher script this module generates — and it disappears with the window.
 * No preload and no IPC channel are involved either: the tray callback is
 * main-process work.
 *
 * FAILURE IS TOLD, NOT ONLY LOGGED. A click that reports nothing is
 * indistinguishable from a broken menu item, and the reasons are the user's to
 * act on (no kernel installed yet, the shim directory unwritable, no console
 * this launcher can be handed to). `AGENTS.md` §4 forbids NATIVE client dialogs
 * — `window.alert` / `confirm` / `prompt` — not telling the user what happened,
 * so every failure carries a {@link TerminalFailureCode} the caller maps to one
 * localized line in the shell's own themed notice.
 *
 * WHY A SHIM DIRECTORY INSTEAD OF AN ALIAS. A shell alias only exists inside a
 * shell the shell itself started, and it cannot be handed to a console we spawn.
 * A directory of five-line scripts is the one mechanism every shell on every
 * platform resolves the same way, it survives a user's own rc files rewriting
 * `PATH` (their edit applies to the tail, ours is the prefix), and it is
 * inspectable: a user who wonders what `dsh` resolves to can `type dsh` and read
 * the file. The directory is `<userData>/terminal-bin` — the shell's own data
 * directory, never the runtime tree (which is replaced wholesale on a
 * kernel-line move) and never the profile (which the mirror and the market both
 * own, and whose `node_modules` a stray `node` script would shadow).
 *
 * THE NODE THAT RUNS THE CLI. A shim naming a BARE `node` would re-enter this
 * same directory through the `PATH` prefix and recurse until the stack dies, and
 * Electron's own binary is never usable here at all (an `ELECTRON_RUN_AS_NODE`
 * child dies with `unsupported Electron runtime fingerprint`). So the Node the
 * runtime ships is resolved to an ABSOLUTE path before anything is written, and
 * a plan that cannot resolve it fails instead of writing a shim that cannot run.
 *
 * HOW THE ENVIRONMENT REACHES THE SHELL. `spawn`'s `env` is inherited, but that
 * is not enough to rely on: macOS's Terminal.app runs in a session whose
 * environment comes from launchd, and a console that was already running keeps
 * the environment it was started with. Both would drop the prefix silently. So
 * every console is asked to run a launcher — a generated `open.cmd` (a `cmd /k`
 * runs a batch file in its own process, so the `set` lines survive into the
 * prompt) or `open.sh` (`exec` keeps the exported environment). Windows runs the
 * batch on EVERY open, whatever shell the user prefers: that preference is the
 * batch file's LAST line now (see {@link cmdLauncher}), not the console's own
 * command line. A generated `.ps1` was never an option — a stock Windows client
 * installs the `Restricted` execution policy and refuses a script file — and an
 * inline PowerShell `-Command` no longer is one either: it would have to survive
 * `cmd`'s parsing TWICE (`cmd /c start`, then the batch), where `%` expands and
 * quotes and `^` are eaten even inside quotes. The spawned environment carries
 * the same prefix as a second line of defence.
 *
 * HOW WINDOWS GETS A WINDOW, AND WHY `opened` IS A REQUEST THERE. On Windows the
 * console is created by `start`, never by the process this module spawns:
 * `cmd /d /c start "" cmd /d /k call <launcher>`. That IS the fix for a terminal
 * that reported success and showed nothing. A console we spawn ourselves gets
 * its stdio from us, and `stdio: 'ignore'` hands it NUL: an interactive shell
 * reads EOF on that stdin and exits before a window is ever painted (measured:
 * the child was gone 1.5s later and no window existed at any point, while the
 * outcome said `opened`). `start` gives the new console its OWN stdio, and the
 * system routes it to the user's default terminal application. The price is that
 * this process has no handle on that console and cannot ask whether a window
 * exists — so `opened` means "the request was issued and the wrapper issuing it
 * exited cleanly", never "a window is on screen". That is also why the wrapper's
 * exit is waited for and its exit code judged: whether `start` itself worked is
 * the one half still observable from here. The visible half is verified by hand,
 * never by this module — see the pointer in `test/terminal.test.mjs`.
 *
 * WHICH CONSOLE, AND WHY NOT `wt.exe`. On Windows the console process is always
 * cmd.exe: it is the one interpreter the launcher's `set` and `cd` lines are
 * written for, and `start` is a cmd builtin, so the request travels through cmd
 * whatever the user's shell is — that shell decides only what the batch hands
 * the console to last. (The other platforms keep leading with the user's own
 * shell: Linux's emulator families, macOS's Terminal.app.) Windows Terminal is
 * deliberately NOT in that list: it is a handoff stub that passes the tab to an
 * already-running instance, and on this machine every command line it was handed
 * arrived as nothing — twelve shapes, `/c` and `/k` and `-NoExit -Command`, with
 * and without `new-tab`, with and without `--`, the whole line as one argument, a
 * `;` terminator — while a bare program name with no arguments did start. It can
 * still be what the user SEES, because that is where the OS sends a new console
 * on a machine that has it installed: `start`, not this module, is what asks.
 * The measured detail is in {@link windowsShells}.
 *
 * IDEMPOTENT. The shim directory is content-compared before each write (a second
 * open rewrites nothing), and one open is in flight at a time: a click that
 * lands while a console is still starting is ignored rather than stacked.
 *
 * The plan itself is a PURE function of its inputs — platform, environment,
 * paths and an executable resolver — so both platform branches are testable off
 * their platform and off a real console (see `test/terminal.test.mjs`).
 *
 * @module dsh-app/main/terminal
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, lstatSync, promises as fs } from 'node:fs'
import path from 'node:path'

/** Directory name of the private shim directory, inside the shell's user-data dir. */
export const TERMINAL_BIN_DIR_NAME = 'terminal-bin'

/** Mode the POSIX shims and the launcher are written with (ignored on Windows). */
const SHIM_MODE = 0o755

/** Windows extensions tried for a bare executable name when `PATHEXT` says nothing. */
const DEFAULT_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD']

/** How long a console gets to either spawn or fail before the entry gives up. */
const DEFAULT_SPAWN_TIMEOUT_MS = 5000

/** One file the shim directory needs: its name, its full text, and its POSIX mode. */
export interface ShimFile {
  readonly name: string
  readonly text: string
  readonly mode: number
}

/** Resolves an executable name (or an absolute path) to what should be started. */
export type ExecutableResolver = (candidate: string) => string | undefined

/** Everything one terminal plan is built from. */
export interface TerminalPlanInput {
  /** The platform the plan is for; injected so both branches are testable. */
  readonly platform: NodeJS.Platform
  /** The environment the console is spawned with (read, never mutated). */
  readonly env: NodeJS.ProcessEnv
  /** Absolute private shim directory. */
  readonly shimDir: string
  /** The bundled pnpm shim directory, when the active runtime carries one. */
  readonly pnpmBinDir?: string
  /** The Node that must run the kernel CLI (a real Node, never Electron's). */
  readonly nodeBinary: string
  /** Absolute path of the active kernel's CLI entry. */
  readonly cliPath: string
  /** `$DSH_HOME` the terminal's shell must see. */
  readonly dshHome: string
  /** The profile the app booted, as `DSH_APP_PROFILE`. */
  readonly profile: string
  /** Working directory the shell starts in. */
  readonly cwd: string
  /** Injected so a plan can be built without touching the platform's filesystem. */
  readonly resolve: ExecutableResolver
}

/** A console to start, and the argv that makes it run the shell we want. */
export interface TerminalPlan {
  /** The console process to spawn. */
  readonly command: string
  /** Its arguments, launcher included. */
  readonly args: readonly string[]
  /** The environment the console is spawned with. */
  readonly env: NodeJS.ProcessEnv
  /** Working directory for the console process. */
  readonly cwd: string
  /** Files to write into the shim directory before spawning. */
  readonly files: readonly ShimFile[]
  /**
   * Whether the spawned process is a hand-off WRAPPER rather than the console
   * itself: true on Windows, where `start` creates the console and this process
   * only asks for it, so the wrapper's exit is the last thing observable here.
   * False on the other platforms, where the spawned process IS the console and
   * lives as long as the session does — waiting for it to exit would never
   * answer anything.
   */
  readonly wrapper: boolean
}

/**
 * Why an open failed, as a stable code — the caller maps it to one localized
 * line, so no English diagnostic reaches the user. `unknown` is the floor: a
 * code this module never heard of must still produce a message.
 */
export type TerminalFailureCode =
  /** No active kernel: the CLI path is empty, so a first start has not finished. */
  | 'no-kernel'
  /** The Node the CLI must run under could not be resolved. */
  | 'no-node'
  /** This platform has no console the launcher can reproduce the environment for. */
  | 'no-console'
  /** The private shim directory could not be written (permissions, a file in its place). */
  | 'shim-write'
  /** The console refused to start. */
  | 'spawn'
  /** The console neither started nor failed in time. */
  | 'timeout'
  /** Anything else — an unexpected throw. */
  | 'unknown'

/** What one open did, for the caller's log line and its user-visible notice. */
export interface TerminalOutcome {
  /**
   * `opened` — the console was REQUESTED and the wrapper asking for it exited
   * cleanly. On Windows this is not a claim about a window: `start` creates the
   * console and hands it to the system, so there is nothing here to check one
   * against — see the module header. `busy` — one was already starting;
   * `failed` — see detail.
   */
  readonly status: 'opened' | 'busy' | 'failed'
  /** The console that was requested (its file name), for the log. */
  readonly terminal?: string
  /** Which failure this was, for the caller's message. Set whenever `status` is `failed`. */
  readonly code?: TerminalFailureCode
  /** English diagnostic: log-only, never rendered. */
  readonly detail?: string
}

/**
 * A plan that cannot be built. Carries the code rather than only prose, so the
 * user-facing line comes from the locale table instead of this file.
 */
class TerminalPlanError extends Error {
  constructor(readonly code: TerminalFailureCode, message: string) {
    super(message)
    this.name = 'TerminalPlanError'
  }
}

/** Everything {@link openManagedTerminal} needs, all of it known to the shell. */
export interface ManagedTerminalOptions {
  /** Electron's user-data directory; the shim directory lives inside it. */
  readonly userDataDir: string
  /** The Node that runs the kernel CLI (see `hostNodeBinary` in index.ts). */
  readonly nodeBinary: string
  /** The active kernel's CLI entry (see `kernelCliPath` in index.ts). */
  readonly cliPath: string
  /** `$DSH_HOME` for the terminal. */
  readonly dshHome: string
  /** The profile the app booted. */
  readonly profile: string
  /** The active runtime's bundled pnpm shim directory, when it has one. */
  readonly pnpmBinDir?: string
  /** Working directory the shell starts in; defaults to the process's own. */
  readonly cwd?: string
  /** Defaults to `process.platform`; injected for tests. */
  readonly platform?: NodeJS.Platform
  /** Defaults to `process.env`; injected for tests. */
  readonly env?: NodeJS.ProcessEnv
  /** Defaults to {@link resolveExecutable}; injected for tests. */
  readonly resolve?: ExecutableResolver
  /** Defaults to `child_process.spawn`; injected for tests. */
  readonly spawnImpl?: typeof spawn
  /** Defaults to {@link DEFAULT_SPAWN_TIMEOUT_MS}; injected for tests. */
  readonly spawnTimeoutMs?: number
}

/**
 * The private shim directory for one user-data directory.
 *
 * @param userDataDir - Electron's user-data directory.
 * @param platform - the platform the path is spelled for.
 * @returns the absolute shim directory path (not created here).
 */
export function terminalBinDir(userDataDir: string, platform: NodeJS.Platform = process.platform): string {
  return joinFor(platform, userDataDir, TERMINAL_BIN_DIR_NAME)
}

/** `path.join` for the platform a plan is being built for, not the running one. */
function joinFor(platform: NodeJS.Platform, ...parts: readonly string[]): string {
  return (platform === 'win32' ? path.win32 : path.posix).join(...parts)
}

/** The file name part of a path, in either spelling (a plan may not run here). */
function baseName(target: string): string {
  return target.split(/[\\/]+/u).filter((part) => part !== '').pop() ?? target
}

/**
 * Whether a candidate names a path this platform can start directly.
 *
 * On Windows this is deliberately STRICT: Node calls `/bin/bash.exe` absolute on
 * Windows (a leading separator is a root there), and a `SHELL` inherited from a
 * Git Bash parent is spelled exactly that way — while `CreateProcess` cannot
 * start it and `cmd` would read it as a path on the current drive. Only a
 * drive-letter or UNC spelling counts.
 */
function isNativeAbsolute(candidate: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return candidate.startsWith('/')
  return /^[A-Za-z]:[\\/]/u.test(candidate) || candidate.startsWith('\\\\')
}

/** The `PATH` entries of an environment, in the spelling of the given platform. */
function pathEntries(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH')
  const raw = key === undefined ? '' : env[key] ?? ''
  return raw
    .split(platform === 'win32' ? ';' : ':')
    .map((entry) => entry.trim().replace(/^"|"$/gu, ''))
    .filter((entry) => entry !== '')
}

/** The names to try for one candidate on Windows: the extension rule, in order. */
function windowsNames(candidate: string, env: NodeJS.ProcessEnv): string[] {
  if (path.win32.extname(candidate) !== '') return [candidate]
  const extensions = (env.PATHEXT ?? '').trim()
  const list = extensions === ''
    ? DEFAULT_PATHEXT
    : extensions.split(';').map((entry) => entry.trim()).filter((entry) => entry !== '')
  return list.map((extension) => `${candidate}${extension}`)
}

/**
 * Whether a path holds a program this platform can start.
 *
 * `existsSync` is deliberately not the whole answer on Windows. An app-execution
 * alias — how Windows Terminal, and several shells, are installed from the Store
 * — is a reparse point whose target lives in the ACL-protected
 * `Program Files\WindowsApps`, so following it is denied and `statSync` reports
 * EACCES: measured on this machine, `existsSync` returns false for a `wt.exe`
 * that `where` finds and `CreateProcess` starts. (That measurement is also why
 * `wt.exe` is not in this module's list of things to look for — see
 * {@link windowsShells}.) A link this cannot follow therefore counts as present,
 * and a link pointing at nothing is only found out when the program refuses to
 * start, which the caller reports (a log line, instead of a missing menu item).
 */
function isPresent(target: string, platform: NodeJS.Platform): boolean {
  if (existsSync(target)) return true
  if (platform !== 'win32') return false
  try {
    return lstatSync(target).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Resolve an executable name or absolute path to a startable path.
 *
 * Absolute candidates are checked as they are; a bare name is looked up in the
 * environment's `PATH` (with `PATHEXT` on Windows). Used to turn the runtime's
 * own `node` — a bare name on a source checkout — into something a shim can name
 * absolutely, and to find the console this platform actually has.
 *
 * @param candidate - a name (`wt.exe`, `xterm`) or an absolute path.
 * @param env - the environment whose `PATH` is searched.
 * @param platform - the platform the lookup is for; defaults to this process's.
 * @returns the path to start, or undefined when nothing matches.
 */
export function resolveExecutable(
  candidate: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const trimmed = candidate.trim()
  if (trimmed === '') return undefined
  if (isNativeAbsolute(trimmed, platform)) return isPresent(trimmed, platform) ? trimmed : undefined
  const names = platform === 'win32' ? windowsNames(trimmed, env) : [trimmed]
  for (const dir of pathEntries(env, platform)) {
    for (const name of names) {
      const full = joinFor(platform, dir, name)
      if (isPresent(full, platform)) return full
    }
  }
  return undefined
}

/**
 * `PATH` with the private directories in front.
 *
 * `PATH`'s spelling varies on Windows (`Path` in a stock environment, `PATH` in
 * Git Bash), so the existing entry is found case-insensitively and rewritten
 * under its OWN name: setting a second spelling would leave the child with two
 * variables and the platform picking whichever it prefers — the same rule
 * `withHostPnpmPath` follows for the host child.
 *
 * @param env - the environment to derive from (not mutated).
 * @param prefixes - directories to prepend, first one wins.
 * @param platform - the delimiter's platform; defaults to this process's.
 * @returns a copy of `env` whose `PATH` starts with the prefixes.
 */
export function withTerminalPath(
  env: NodeJS.ProcessEnv,
  prefixes: readonly string[],
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
  const existing = env[key] ?? ''
  const prefix = prefixes.join(platform === 'win32' ? ';' : ':')
  return { ...env, [key]: existing === '' ? prefix : `${prefix}${platform === 'win32' ? ';' : ':'}${existing}` }
}

// ---------------------------------------------------------------- launchers

/** One variable a launcher has to set, in the order it must be set. */
interface LauncherVariable {
  readonly name: string
  readonly value: string
}

/**
 * A batch-file value: `%` opens a variable reference, so it is doubled, and the
 * two things that could END the line it sits on are removed.
 *
 * A `"` closes the quoted `set "NAME=value"` or `"<path>"` this value is written
 * inside, and what follows becomes another command — measured on this machine:
 * `DSH_HOME=D:\a" & echo PWNED> <file> & rem "` really did create the file, and
 * a CR or LF ends the line even earlier with the same effect. REMOVAL rather
 * than refusal, because neither character can occur in a Win32 path: `"` and the
 * control characters are refused by the filesystem, so nothing a real Windows
 * environment carries (a `PATH` entry an installer wrote as `"C:\Program Files\
 * weird\bin"`, say) is lost — while refusing would take the whole entry away
 * over one odd row. What survives the removal cannot break out either: every
 * remaining metacharacter (`&`, `^`, `|`, `(`, `)`) stays inside the pair of
 * quotes that is still around the value. The quotes are dropped rather than
 * escaped because a `"` written back into a quoted `set` line ends the line
 * either way: the only question is whether the REST of the value survives, and
 * for a quoted `PATH` entry that is the difference between an entry that still
 * resolves and a PATH truncated at that point (measured: `where <tool>` found
 * nothing before this change, and finds it after).
 */
function batchLiteral(value: string): string {
  return value.replace(/[\r\n"]/gu, '').replace(/%/gu, '%%')
}

/**
 * The line every generated batch file carries directly after `@echo off`.
 *
 * `cmd` decodes a batch file with the CONSOLE's code page, and it re-reads from
 * the current byte offset after each command — so a `chcp` on the second line
 * applies to every line below it. Without it a stock Simplified-Chinese Windows
 * (code page 936, measured with `chcp` on this machine) reads the UTF-8 this
 * module writes as mojibake, and the failure is SILENT: `set "Path=<mojibake>"`
 * leaves the prefix pointing at a directory that does not exist, so `node` and
 * `dsh` fall through to the machine's own installs — the `never a system dsh`
 * rule of `AGENTS.md` §1 broken by an encoding, with `openManagedTerminal` still
 * answering `opened` — while a `dsh.cmd` whose CLI path garbles dies with
 * `MODULE_NOT_FOUND`.
 *
 * `>nul`: the line is not the user's to read. The console keeps the code page,
 * which is the same thing that makes the CLI's own UTF-8 output render there.
 */
function batchUtf8Line(): string {
  return 'chcp 65001>nul'
}

/** A POSIX single-quoted string: `'` is closed, escaped and reopened. */
function posixLiteral(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`
}

/**
 * The `cmd` launcher: a batch file run by `cmd /k`, so its `set` lines stay in
 * the prompt's own environment — and, on Windows, the ONLY thing the console is
 * ever asked to run (see the module header).
 *
 * Every variable is set to its WHOLE value rather than appended to the inherited
 * one. The value was computed a moment ago from this very environment, so
 * appending would count the prefix twice in the normal case, and naming it whole
 * is what makes the line do its job in the case the environment was not
 * inherited at all (a console the system opened rather than this process).
 *
 * `chcp 65001` comes before the first line that can carry a non-ASCII byte, and
 * it is load-bearing — see {@link batchUtf8Line}.
 *
 * THE HANDOFF, when there is one, is the last line. The user's shell preference
 * lives HERE rather than on the console's own command line, because an inline
 * `-Command` would have to survive `cmd`'s parsing twice over (`cmd /c start`,
 * then this batch), where `%` expands and quotes and `^` are eaten even inside
 * quotes — while a handoff is one fixed command line every parser agrees on.
 * `-NoExit` is belt-and-braces in a console that already exists — PowerShell
 * stays at its prompt when it has no command to run either way — and it is what
 * keeps the interpreter there if a command is ever added. When PowerShell exits,
 * this batch ends and the `cmd /k` prompt it was called from returns.
 */
function cmdLauncher(variables: readonly LauncherVariable[], cwd: string, handoff?: string): string {
  const lines = ['@echo off', batchUtf8Line(), 'rem DSH APP managed terminal — regenerated on every open; do not edit.']
  for (const variable of variables) lines.push(`set "${variable.name}=${batchLiteral(variable.value)}"`)
  lines.push(`cd /d "${batchLiteral(cwd)}"`)
  if (handoff !== undefined) lines.push(`"${batchLiteral(handoff)}" -NoLogo -NoExit`)
  return `${lines.join('\r\n')}\r\n`
}

/**
 * The POSIX launcher: a script the console runs, ending in the user's shell.
 *
 * `exec` replaces this script with the shell, so the exported environment is the
 * one the user types into. `-l` is passed only on macOS, where the platform's own
 * Terminal opens a login shell and `.zprofile`/`.profile` are therefore part of
 * what a user expects to have run.
 */
function shLauncher(
  variables: readonly LauncherVariable[],
  cwd: string,
  shell: string,
  login: boolean,
): string {
  const lines = [
    '#!/bin/sh',
    '# DSH APP managed terminal — regenerated on every open; do not edit.',
  ]
  for (const variable of variables) lines.push(`export ${variable.name}=${posixLiteral(variable.value)}`)
  lines.push(`[ -d ${posixLiteral(cwd)} ] && cd ${posixLiteral(cwd)}`)
  lines.push(`exec ${posixLiteral(shell)}${login ? ' -l' : ''}`)
  return `${lines.join('\n')}\n`
}

// ------------------------------------------------------------------- shims

/** The `dsh` shim's text for one platform, in both spellings Windows needs. */
function commandShims(name: string, argv: readonly string[], platform: NodeJS.Platform): ShimFile[] {
  const quoted = argv.map((part) => `"${batchLiteral(part)}"`).join(' ')
  // The POSIX spelling names the same files in the forward-slash form every
  // POSIX shell here reads.
  const posixParts = argv.map((part) => (platform === 'win32' ? part.replace(/\\/gu, '/') : part))
  const posix = `#!/bin/sh\n# DSH APP managed terminal shim — regenerated on every open; do not edit.\nexec ${posixParts.map(posixLiteral).join(' ')} "$@"\n`
  const files: ShimFile[] = [{ name, text: posix, mode: SHIM_MODE }]
  // Windows gets the batch spelling too, and both are worth having: `cmd`
  // resolves only `dsh.cmd`, while a POSIX shell (Git Bash) resolves `dsh` and
  // never the batch file — and a user who puts this directory on their own PATH
  // is exactly the user it is there for.
  if (platform === 'win32') {
    // `chcp 65001` first, for the same reason the launcher carries it: this line
    // names the CLI by absolute path, and a path under a non-ASCII account or
    // `$DSH_HOME` decodes as mojibake under the console's own code page.
    const cmd = [
      '@echo off',
      batchUtf8Line(),
      'rem DSH APP managed terminal shim — regenerated on every open; do not edit.',
      `${quoted} %*`,
      '',
    ].join('\r\n')
    files.push({ name: `${name}.cmd`, text: cmd, mode: SHIM_MODE })
  }
  return files
}

/** The files the shim directory must hold, for one plan. */
function shimFiles(input: TerminalPlanInput, node: string, cli: string): ShimFile[] {
  return [
    ...commandShims('dsh', [node, cli], input.platform),
    ...commandShims('node', [node], input.platform),
  ]
}

// -------------------------------------------------------------------- plans

/** The shell one environment variable names, when it is one this platform can start. */
function shellCandidate(raw: string | undefined, platform: NodeJS.Platform, resolve: ExecutableResolver): string | undefined {
  const candidate = (raw ?? '').trim()
  if (candidate === '') return undefined
  if (!isNativeAbsolute(candidate, platform)) return undefined
  return resolve(candidate)
}

/** The shell `$SHELL` names (the POSIX convention). */
function userShell(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, resolve: ExecutableResolver): string | undefined {
  return shellCandidate(env.SHELL, platform, resolve)
}

/**
 * Which handoff a Windows shell can take, or undefined for a shell whose
 * environment this cannot reproduce.
 *
 * The answer decides only the LAST line of `open.cmd` now — the console is
 * cmd.exe on this platform whatever this says (see {@link planWindows}) — and
 * `cmd` needs no handoff at all: the batch already runs in a cmd prompt.
 *
 * Only the two Windows shells are served, and the reason is measured: a POSIX
 * shell on this platform reads `PATH` in MSYS form — `:` separators and
 * `/c/...` entries, with `C:/Windows/System32` as a PATH entry resolving
 * nothing at all (verified in Git Bash on this machine). Reproducing that from a
 * Windows environment is a path-conversion job the launcher cannot do without
 * asking `cygpath`, and getting it half right yields a terminal whose PATH is
 * silently broken — which is worse than the cmd prompt the user is left in.
 */
function windowsLauncher(shell: string): 'cmd' | 'powershell' | undefined {
  const base = baseName(shell).toLowerCase()
  if (base === 'cmd.exe' || base === 'cmd') return 'cmd'
  if (base === 'powershell.exe' || base === 'pwsh.exe' || base === 'pwsh') return 'powershell'
  return undefined
}

/**
 * The shells a Windows console's batch may hand off to, in order: the shells
 * this environment names, then PowerShell, then cmd.
 *
 * NOT Windows Terminal, and that is measured rather than assumed. `wt.exe` is a
 * handoff stub: it passes the tab to an already-running Windows Terminal, and
 * every command-line shape it was given here arrived as nothing at all — twelve
 * shapes (with and without `new-tab`, with and without `--`, `/c` and `/k` and
 * `-NoExit -Command`, the whole line as one argument, a `;` terminator, quoted
 * flags) started no process, while a bare program name with no arguments did
 * start one. Nothing is handed to a third-party parser here: the Launcher is
 * what carries the environment, and the OS's own routing of a `start`ed console
 * is the only thing between this plan and the user's window.
 *
 * A shell that does not resolve is DROPPED rather than substituted, so an
 * environment naming nothing usable ends at cmd — the prompt the console already
 * is — instead of at some other shell the user did not ask for.
 */
function windowsShells(env: NodeJS.ProcessEnv, resolve: ExecutableResolver, cmd: string): string[] {
  const declared = [
    shellCandidate(env.SHELL, 'win32', resolve),
    shellCandidate(env.ComSpec, 'win32', resolve),
  ]
  const powershell = resolve('powershell.exe')
    ?? resolve(joinFor('win32', env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  const candidates = [...declared, powershell, cmd]
  const seen = new Set<string>()
  const usable: string[] = []
  for (const candidate of candidates) {
    if (candidate === undefined || seen.has(candidate) || windowsLauncher(candidate) === undefined) continue
    seen.add(candidate)
    usable.push(candidate)
  }
  return usable
}

/**
 * The shell `open.cmd` hands the console to, or undefined to leave it at the cmd
 * prompt it already is.
 *
 * The preference order is the one this module always had — `$SHELL`, then
 * `ComSpec`, then PowerShell, then cmd — but its meaning is narrower now: it no
 * longer picks the console, only who ends up in front of the user inside it.
 */
function windowsHandoff(env: NodeJS.ProcessEnv, resolve: ExecutableResolver, cmd: string): string | undefined {
  const [preferred] = windowsShells(env, resolve, cmd)
  if (preferred === undefined || windowsLauncher(preferred) !== 'powershell') return undefined
  return preferred
}

/**
 * The plan for Windows: ONE shape, `cmd.exe` through `start`, whatever shell the
 * user prefers.
 *
 * `start` is what makes a window exist at all. The console it creates gets its
 * own stdio, whereas a console this module spawns inherits OURS — and `stdio:
 * 'ignore'` means NUL, on which an interactive shell reads EOF and exits before
 * anything is painted. Measured: `cmd /d /k call <launcher>` was dead 1.5s later
 * with no window at any point, while the outcome still said `opened`.
 *
 * The empty argument after `start` is the WINDOW TITLE slot and has to be there:
 * `start` reads a first quoted argument as the title, so without it a quoted
 * path becomes the title and the command never runs. Both cmd words are the
 * absolute path this plan resolved, so no second PATH lookup can pick a
 * different one — and a cmd.exe that does not resolve is a failure the caller
 * reports, never a silent fall back to some other program.
 *
 * The inner cmd is `/d /k` (no AutoRun, stay at the prompt) and `call`s the
 * batch: the outer quotes a command line needs around a path with spaces
 * ("DSH APP" is one) are what `cmd`'s argument parsing mangles, and `call` keeps
 * the batch's `set` lines in the interpreter the user is looking at.
 */
function planWindows(input: TerminalPlanInput, node: string, cli: string): TerminalPlan {
  const { resolve, shimDir } = input
  const env = planEnv(input)
  const variables = launcherVariables(env, pathVariableName(env))
  const files = shimFiles(input, node, cli)
  const cmd = resolve('cmd.exe')
    ?? resolve(joinFor('win32', env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'))
  if (cmd === undefined) {
    throw new TerminalPlanError('no-console', 'cmd.exe could not be resolved, and every Windows terminal is started through it (tried PATH and %SystemRoot%\\System32)')
  }
  const launcher = joinFor('win32', shimDir, 'open.cmd')
  files.push({
    name: 'open.cmd',
    text: cmdLauncher(variables, input.cwd, windowsHandoff(input.env, resolve, cmd)),
    mode: SHIM_MODE,
  })
  return planFor(input, env, cmd, ['/d', '/c', 'start', '', cmd, '/d', '/k', 'call', launcher], files, true)
}

/** The plan for macOS: the platform's own Terminal, running the launcher. */
function planDarwin(input: TerminalPlanInput, node: string, cli: string): TerminalPlan {
  const { env, resolve, shimDir } = input
  const shell = userShell(env, 'darwin', resolve) ?? resolve('/bin/zsh') ?? resolve('/bin/sh')
  if (shell === undefined) throw new TerminalPlanError('no-console', 'no shell could be resolved for the terminal')
  const terminal = resolve('open') ?? resolve('/usr/bin/open')
  if (terminal === undefined) throw new TerminalPlanError('no-console', 'no console could be resolved for the terminal (tried /usr/bin/open)')
  const launcher = joinFor('darwin', shimDir, 'open.sh')
  const planned = planEnv(input)
  const files = [
    ...shimFiles(input, node, cli),
    { name: 'open.sh', text: shLauncher(launcherVariables(planned, 'PATH'), input.cwd, shell, true), mode: SHIM_MODE },
  ]
  return planFor(input, planned, terminal, ['-a', 'Terminal', launcher], files)
}

/** The plan for Linux: the emulator families in the order they are tried. */
function planLinux(input: TerminalPlanInput, node: string, cli: string): TerminalPlan {
  const { resolve, shimDir } = input
  const shell = userShell(input.env, 'linux', resolve) ?? resolve('/bin/sh')
  if (shell === undefined) throw new TerminalPlanError('no-console', 'no shell could be resolved for the terminal (tried $SHELL and /bin/sh)')
  const candidates = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']
  const terminal = candidates.map((candidate) => resolve(candidate)).find((found) => found !== undefined)
  if (terminal === undefined) {
    throw new TerminalPlanError('no-console', `no console could be resolved for the terminal (tried ${candidates.join(', ')})`)
  }
  const launcher = joinFor('linux', shimDir, 'open.sh')
  const planned = planEnv(input)
  const files = [
    ...shimFiles(input, node, cli),
    { name: 'open.sh', text: shLauncher(launcherVariables(planned, 'PATH'), input.cwd, shell, false), mode: SHIM_MODE },
  ]
  // `-e <command>` is the contract Debian's `x-terminal-emulator` alternative
  // exists to guarantee (a hook for the terminal setting the policy demands),
  // and it is what xterm and konsole take too. GNOME Terminal's own spelling is
  // `-- <command>`; its `-e` is deprecated and removed in some versions, which
  // is why the two are not spelled the same way here.
  const base = baseName(terminal)
  const argv = base === 'gnome-terminal' ? ['--', launcher] : ['-e', launcher]
  return planFor(input, planned, terminal, argv, files)
}

/**
 * The environment the console is spawned with.
 *
 * `DSH_HOME` and `DSH_APP_PROFILE` are SET rather than inherited: this shell may
 * itself have been started by an outer `dsh` environment pointing at another
 * home, and the terminal's whole point is the profile this app booted.
 */
function planEnv(input: TerminalPlanInput): NodeJS.ProcessEnv {
  const prefixes = [input.shimDir, ...(input.pnpmBinDir === undefined ? [] : [input.pnpmBinDir])]
  return {
    ...withTerminalPath(input.env, prefixes, input.platform),
    DSH_HOME: input.dshHome,
    DSH_APP_PROFILE: input.profile,
  }
}

/** The name `PATH` is spelled with in one environment (`Path` in a stock Windows one). */
function pathVariableName(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
}

/**
 * The variables a launcher must reproduce, read back out of the environment it
 * is derived from: the whole `PATH`, then the two names. The VALUE is always the
 * environment's own `PATH`, found case-insensitively; only the NAME is the
 * caller's to choose (a POSIX launcher must spell it `PATH`, since POSIX names
 * are case-sensitive). One source, so the launcher and the spawned environment
 * cannot drift apart.
 */
function launcherVariables(env: NodeJS.ProcessEnv, pathName: string): LauncherVariable[] {
  const key = pathVariableName(env)
  return [
    { name: pathName, value: env[key] ?? '' },
    { name: 'DSH_HOME', value: env.DSH_HOME ?? '' },
    { name: 'DSH_APP_PROFILE', value: env.DSH_APP_PROFILE ?? '' },
  ]
}

/**
 * One platform's console plus the environment it is spawned with.
 *
 * `wrapper` defaults to false, which is what the two POSIX platforms are: the
 * process spawned there IS the console, and it is alive for as long as the user
 * keeps the window. Windows passes true — the process spawned is a hand-off
 * request whose exit is part of the outcome. See {@link TerminalPlan.wrapper}.
 */
function planFor(
  input: TerminalPlanInput,
  env: NodeJS.ProcessEnv,
  command: string,
  args: readonly string[],
  files: readonly ShimFile[],
  wrapper = false,
): TerminalPlan {
  return {
    command,
    args,
    cwd: input.cwd,
    files,
    env,
    wrapper,
  }
}

/**
 * Whether the kernel CLI the shell resolved can be run at all (see
 * `kernelCliPath` in index.ts).
 *
 * ONE question, answered in one place, because two very different callers have
 * to agree on it. {@link terminalPlan} refuses with `no-kernel` exactly when
 * this answers false: the shell always hands that plan an ABSOLUTE path, and
 * `resolveExecutable` answers an absolute candidate with `isPresent`, which
 * starts at `existsSync` (the candidate is a file inside the runtime tree, never
 * a store-installed program, so the reparse-point case `isPresent` adds does not
 * arise). And the tray row that opens the terminal is greyed by this same
 * answer — so a greyed row and a click that could only report "no kernel" are
 * one fact, not two rules that happen to agree. The shell's other callers that
 * only need to know whether the CLI is there (the profile repair steps and the
 * diagnostics config check, index.ts) ask it here too.
 *
 * An empty path is not a missing file, it is a state: `kernelCliPath()` answers
 * '' exactly when this machine has no active kernel at all.
 *
 * Necessary, not sufficient for a TERMINAL: a missing Node, an unwritable shim
 * directory or a platform with no console all fail later, inside the plan or the
 * open, and those keep their notice (a disabled row would hide a reason the user
 * can act on).
 *
 * @param cliPath - the active kernel's CLI entry, or '' when there is none.
 * @returns whether that file is there to be started.
 */
export function kernelCliUsable(cliPath: string): boolean {
  const candidate = cliPath.trim()
  return candidate !== '' && existsSync(candidate)
}

/**
 * Build the plan for one managed terminal.
 *
 * Pure: it reads the injected environment, resolves executables through the
 * injected resolver, and returns the console, its argv, its environment and the
 * files to write. Nothing is created, spawned or mutated here.
 *
 * @param input - platform, environment, paths and resolver.
 * @returns the plan to hand to {@link openManagedTerminal}.
 * @throws {Error} with an actionable English message when the plan cannot be
 *   built (no console on this platform, or no Node for the kernel CLI).
 */
export function terminalPlan(input: TerminalPlanInput): TerminalPlan {
  const node = input.resolve(input.nodeBinary)
  if (node === undefined) {
    throw new TerminalPlanError('no-node', `the Node that runs the kernel CLI could not be resolved: ${input.nodeBinary}`)
  }
  const cli = input.resolve(input.cliPath)
  if (cli === undefined) {
    // The same question the tray row asks before it lets the user click (see
    // kernelCliUsable): "the CLI is not there: " tells nobody anything they can
    // act on, so the empty path gets the sentence about the state.
    throw new TerminalPlanError('no-kernel', input.cliPath.trim() === ''
      ? 'this machine has no usable kernel yet: let the app finish a first start, then try again'
      : `the active kernel's CLI is not there: ${input.cliPath}`)
  }
  if (input.platform === 'win32') return planWindows(input, node, cli)
  if (input.platform === 'darwin') return planDarwin(input, node, cli)
  return planLinux(input, node, cli)
}

// -------------------------------------------------------------------- open

/** Set while a console is starting: a click during that window is ignored. */
let opening = false

/**
 * Write the shim directory.
 *
 * Content-compared, so a second open rewrites nothing (a shim being replaced
 * while another terminal reads it is the one failure that would be invisible).
 * The mode is set on POSIX only: Windows has no executable bit, and `chmod`
 * there only toggles the read-only attribute.
 */
async function writeShims(dir: string, files: readonly ShimFile[], platform: NodeJS.Platform): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  for (const file of files) {
    const target = joinFor(platform, dir, file.name)
    const current = await fs.readFile(target, 'utf8').catch(() => undefined)
    if (current !== file.text) await fs.writeFile(target, file.text, 'utf8')
    if (platform !== 'win32') await fs.chmod(target, file.mode)
  }
}

/**
 * Start the console and decide whether the request got anywhere.
 *
 * TWO DIFFERENT QUESTIONS, one per platform.
 *
 * Where the spawned process IS the console (macOS, Linux) success is the
 * `spawn` event: `spawn` reports a failed start asynchronously (an `error`
 * event), so "the terminal opened" is only true after `spawn` fires — and the
 * process then stays alive for the whole session, so its exit is not a signal to
 * wait for.
 *
 * Where the spawned process is a hand-off WRAPPER (Windows, see
 * {@link planWindows}) `spawn` says almost nothing: the wrapper exists for a few
 * milliseconds and hands the real console to the system. So the exit code is
 * judged instead — `start` failing is what a non-zero exit means, and that is
 * the only part of the request still observable from here ({@link TerminalPlan.wrapper}).
 * A wrapper that has not exited within {@link DEFAULT_SPAWN_TIMEOUT_MS} is
 * reported as a failure too: on this machine it exits in tens of milliseconds,
 * so "still running" is not a terminal being opened, it is a request that did
 * not complete.
 *
 * Neither event ever arriving would otherwise leave the entry permanently
 * blocked, which is what the timeout covers on both paths.
 */
function startConsole(child: ChildProcess, timeoutMs: number, wrapper: boolean): Promise<TerminalFailure | undefined> {
  return new Promise<TerminalFailure | undefined>((resolvePromise) => {
    let settled = false
    const finish = (failure?: TerminalFailure): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(failure)
    }
    const timer = setTimeout(() => {
      finish({ code: 'timeout', detail: 'the console did not start within the timeout' })
    }, timeoutMs)
    child.once('error', (error: Error) => {
      finish({ code: 'spawn', detail: `the console refused to start: ${error.message}` })
    })
    if (!wrapper) {
      child.once('spawn', () => { finish() })
      return
    }
    child.once('exit', (code, signal) => {
      if (code === 0) {
        finish()
        return
      }
      finish({
        code: 'spawn',
        detail: code === null
          ? `the console wrapper was killed by ${signal ?? 'a signal'} before it could start a console`
          : `the console wrapper exited with code ${code} without the console being requested`,
      })
    })
  })
}

/** A failure with the code the caller needs, split off so the code cannot be lost. */
interface TerminalFailure {
  readonly code: TerminalFailureCode
  readonly detail: string
}

/** The one message a thrown value has, whether or not it is an Error. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Open the user's own terminal, with this shell's private shim in front of its
 * `PATH` (see the module header for what that is for and what it does not do).
 *
 * Never throws: the outcome is data the caller turns into one log line and, when
 * it failed, one localized notice. A click that lands while another console is
 * still starting is reported as `busy` instead of stacking a second window.
 *
 * @param options - the shell's own paths, and the injection seams.
 * @returns what happened, with the code the caller's message is chosen by.
 */
export async function openManagedTerminal(options: ManagedTerminalOptions): Promise<TerminalOutcome> {
  if (opening) return { status: 'busy' }
  opening = true
  try {
    const platform = options.platform ?? process.platform
    const env = options.env ?? process.env
    const shimDir = terminalBinDir(options.userDataDir, platform)
    const plan = terminalPlan({
      platform,
      env,
      shimDir,
      nodeBinary: options.nodeBinary,
      cliPath: options.cliPath,
      dshHome: options.dshHome,
      profile: options.profile,
      cwd: options.cwd ?? process.cwd(),
      resolve: options.resolve ?? ((candidate) => resolveExecutable(candidate, env, platform)),
      ...(options.pnpmBinDir === undefined ? {} : { pnpmBinDir: options.pnpmBinDir }),
    })
    // Named apart from the plan failures: a read-only user-data directory and a
    // machine with no kernel are different things to tell the user to fix.
    try {
      await writeShims(shimDir, plan.files, platform)
    } catch (error) {
      return { status: 'failed', code: 'shim-write', detail: describe(error) }
    }
    const spawnImpl = options.spawnImpl ?? spawn
    // `windowsHide` stays FALSE here, unlike every other child this shell starts:
    // this one is a window the user asked for. Nothing is piped either — on
    // Windows `start` gives the console its own stdio, and on the other platforms
    // the console owns the ones it was spawned with.
    const child = spawnImpl(plan.command, [...plan.args], {
      cwd: plan.cwd,
      env: plan.env,
      windowsHide: false,
      stdio: 'ignore',
    })
    const failure = await startConsole(child, options.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS, plan.wrapper)
    if (failure !== undefined) return { status: 'failed', code: failure.code, detail: failure.detail }
    return { status: 'opened', terminal: baseName(plan.command) }
  } catch (error) {
    return {
      status: 'failed',
      code: error instanceof TerminalPlanError ? error.code : 'unknown',
      detail: describe(error),
    }
  } finally {
    opening = false
  }
}

/**
 * One log line for a managed-terminal attempt. Log-only (never rendered), so it
 * stays out of the locale tables and is written in English: what was asked for,
 * or the one thing that has to change before it can be.
 *
 * The success line says REQUESTED, not "opened": on Windows the console belongs
 * to the system from the moment `start` runs and nothing here can see whether a
 * window exists — a line claiming otherwise is exactly what let a terminal that
 * never appeared look like a working feature (see the module header).
 */
export function terminalLogLine(outcome: TerminalOutcome): string {
  if (outcome.status === 'opened') return `[terminal] asked for a terminal via ${outcome.terminal ?? 'a console'}`
  if (outcome.status === 'busy') return '[terminal] a terminal is already starting; the click was ignored'
  return `[terminal] could not open a terminal: ${outcome.detail ?? 'unknown error'}`
}
