/**
 * Restore a profile whose declared dependencies went missing, before the host
 * is started on it.
 *
 * The host refuses to boot a profile whose manifest names a bundle that does
 * not resolve (`cannot resolve profile bundle "@deepseek-ai/dsh-toolkit"`), and
 * the user has no path out of that from inside the app: the failure card offers
 * rollback and retry, both of which boot the same profile. Measured: a manual
 * `pnpm install` in the profile answered "Already up to date" while the packages
 * were missing — pnpm's own state files still agreed with the lockfile — so even
 * the documented hand-repair did not work without deleting `node_modules` first.
 *
 * What this step does instead is drive the profile's OWN package manager
 * through the kernel CLI, which is the same path the in-app market installs
 * through: `node <dsh bin.js> plugin --profile <p> install` runs `pnpm install`
 * with cwd = the profile and then reconciles `dsh.profile.bundles` against what
 * is really on disk. Two consequences of reusing it rather than calling pnpm
 * directly: the reconciliation runs, so a bundle entry the market's own install
 * had added is re-derived; and the supply-chain policy handling is pnpm's, not
 * this module's. The one argument on top of the market's is
 * `--config.minimumReleaseAge=0` — the same per-run release-age lift the market
 * applies when pnpm's cooldown blocks a command (see `release-age.ts` there):
 * without it a profile pinning a version published inside 24 hours cannot be
 * repaired at all, and the cooldown is left intact for every other run because
 * the override is per-invocation.
 *
 * The check itself reads `dependencies` only, never `dsh.profile.bundles`. The
 * bundles list also carries the in-box rows (`@deepseek-ai/dsh-base`,
 * `@deepseek-ai/dsh-web-app`) which resolve from the dsh INSTALLATION and are
 * deliberately absent from the profile — treating them as missing would run a
 * package manager on every single boot.
 *
 * Resolution is checked as "the package directory holds a manifest", not by
 * `createRequire(profileDir/package.json).resolve(name)`. Measured on this
 * machine: the require walk leaves the profile and keeps climbing the real
 * filesystem (`…\profiles\dsh-app\node_modules` → `…\dsh-app\node_modules` →
 * …), so a checkout or any other ancestor `node_modules` answers for a package
 * the profile does not have; and a package that exports only subpaths (measured:
 * `@deepseek-ai/dsh-web-frontend`, whose `exports` holds `./dist/*` and
 * `./package.json`) fails to resolve even when it is installed. The existence
 * test is what the host's own resolver uses (`packageDirFromAnchor` in
 * `@deepseek-ai/dsh-app-boot` accepts a candidate only when
 * `node_modules/<name>/package.json` exists), and it is the shape pnpm's hoisted
 * linker produces — one real directory per dependency at the top of
 * `<profile>/node_modules`.
 *
 * Bounded and non-fatal by design: a timeout kills the whole child tree, every
 * failure is logged and swallowed, and the host start then reports its own error
 * exactly as it did before this step existed. A boot that cannot be repaired is
 * still a boot this shell attempts.
 *
 * @module src/main/profile-heal
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { redact } from './redact'
import { specifierResolves } from './brand-suite'

/**
 * Deadline for the repair run. A cold pnpm cache over a profile with plugins
 * can take a while, but this step sits in front of the host start: past this
 * the user is better served by the host's own error than by more waiting.
 */
export const HEAL_TIMEOUT_MS = 180_000

/** Output captured per run before truncation, for the log line's tail. */
const STREAM_CAPTURE_BYTES = 64 * 1024

/** Output lines kept for the log line. */
const TAIL_LINES = 20

/**
 * npm's package-name grammar, the shape a `dependencies` key has to have to be
 * something a package manager can manage. A key that does not match — a
 * hand-written comment key, a stray path — is skipped rather than passed to
 * pnpm as a dependency name.
 */
const DEPENDENCY_NAME_PATTERN = /^(@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-*~][a-z0-9-._~]*$/

/** What the step found and did, for the caller's log line. */
export interface ProfileHealOutcome {
  /**
   * `ok` — every declared dependency is installed, nothing was run and nothing
   * should be logged; `healed` — a repair run succeeded; `unrepairable` — the
   * repair run failed or could not be started, and the host start is left to
   * report the consequence.
   */
  status: 'ok' | 'healed' | 'unrepairable'
  /** Declared names that were not installed. */
  missing: readonly string[]
  /** Redacted tail of the run's output, when there was one. */
  detail?: string
}

/** Everything one repair run needs; the spawn and the clock are injectable. */
export interface HealOptions {
  /** The profile directory the run works in. */
  readonly profileDir: string
  /** The profile NAME, as `dsh plugin --profile <name>` takes it. */
  readonly profileName: string
  /**
   * The harness home the profile belongs to (`<dshHome>/profiles/<name>` is the
   * profile). Load-bearing, not informational: the CLI resolves `--profile` as
   * `$DSH_HOME/profiles/<name>` and NOT from its own cwd, so inheriting whatever
   * `DSH_HOME` the Electron process happens to carry could point the repair at a
   * DIFFERENT profile than the one being repaired — and the run would answer
   * "Already up to date" about that other profile and report success here.
   */
  readonly dshHome: string
  /** Absolute path of the kernel CLI entry (`@deepseek-ai/dsh/lib/bin.js`). */
  readonly bin: string
  /** Node executable that must run the CLI (never Electron's own). */
  readonly node: string
  /**
   * Directory holding the runtime's bundled `pnpm` shim, put in front of the
   * child's `PATH`.
   *
   * The repair drives `dsh plugin ... add`, which spawns pnpm by NAME: an
   * installer cannot assume the user has one, and this run happens in the SHELL
   * process, whose own `PATH` never saw the host child's (see
   * `hostPnpmBinDir`). Absent on a runtime built before the tree carried pnpm,
   * where the run falls back to whatever `PATH` offers — the behaviour it had.
   */
  readonly pnpmBinDir?: string
  /** Test seam; defaults to `node:child_process.spawn`. */
  readonly spawnImpl?: typeof spawn
  /** Test seam; defaults to {@link HEAL_TIMEOUT_MS}. */
  readonly timeoutMs?: number
}

/**
 * The release-age policy's failure codes, and the one-run override that lifts it.
 *
 * Kept in sync with `plugins/plugin-market/src/release-age.ts`, which owns the
 * measured wording (the shell cannot import a plugin's module). It matters that
 * this repair honours the same policy the market does: lifting the cooldown up
 * front would make "install the missing packages" a way around a supply-chain
 * check the rest of the app applies.
 */
const RELEASE_AGE_CODES = [
  'ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED',
  'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION',
  'ERR_PNPM_NO_MATURE_MATCHING_VERSION',
] as const

/** The argument that lifts the release-age policy for ONE run. */
const RELEASE_AGE_OVERRIDE = '--config.minimumReleaseAge=0'

/** Whether a failed run failed on the release-age policy. */
function isReleaseAgeFailure(output: string): boolean {
  return RELEASE_AGE_CODES.some((code) => output.includes(code))
}

/**
 * The directory name a specifier installs into: its `name@version` tag dropped.
 *
 * The read-back has to look at the package, not at the specifier that asked for
 * it — `pkg@^0.2.1` never matches a directory of that name, and a repair that
 * judged it un-healed would install again on every click.
 *
 * @param specifier - a package name, optionally with a version (`@scope/n@1.2.3`).
 */
export function installedNameOf(specifier: string): string {
  const at = specifier.indexOf('@', specifier.startsWith('@') ? 1 : 0)
  return at <= 0 ? specifier : specifier.slice(0, at)
}

/**
 * Whether a name is one this repair may hand to the CLI.
 *
 * Deliberately strict, and it is a security boundary rather than a style rule:
 * the value comes from a config file the user (or anything that can write one)
 * controls, and it is handed to a spawned command line as an argument. Anything
 * that could read as an OPTION — a leading dash above all — is refused before it
 * can become one, and the version tag stays inside the characters a version uses
 * (no `:` protocol or alias tag, no quote, no backslash, no space).
 *
 * @param name - the specifier a patch row named.
 */
export function isInstallablePackageName(name: string): boolean {
  return /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w^~<>][\w.^~<>-]*)?$/iu.test(name)
}

/**
 * Install specific packages into a profile — the repair for a home-layer row the
 * profile cannot load.
 *
 * The row is the user's own; this SATISFIES it rather than editing their
 * configuration, which matters because the home layer applies to every profile
 * of the install (a row that does not resolve here may be perfectly good in the
 * user's own `dsh web`). Runs the same CLI the market installs through, under
 * the same release-age policy: the policy runs first, and only a run the policy
 * actually blocked is retried once with it lifted.
 *
 * A zero exit is not proof, here as there: the packages are read back through
 * the same predicate that flagged the rows.
 *
 * @param options - the profile, the kernel CLI, the Node that runs it.
 * @param packages - package names to install (a path cannot be installed).
 * @returns what happened, for the caller's log line. Never throws.
 */
export async function installIntoProfile(options: HealOptions, packages: readonly string[]): Promise<ProfileHealOutcome> {
  // The filter lives here as well as at the card: this is where the value would
  // become an argument of a spawned command line.
  const names = packages.filter((name) => isInstallablePackageName(name))
  if (names.length === 0) return { status: 'ok', missing: [] }
  const missing = [...names]
  try {
    const head = [options.bin, 'plugin', '--profile', options.profileName]
    let run = await runHeal(options, [...head, 'add', ...names])
    if (run.timedOut || run.spawnError !== undefined) return runFailure(options, run, missing)
    if (run.code !== 0 && isReleaseAgeFailure(run.output)) {
      // The policy rejected the run before it did anything: run the same command
      // once with the policy lifted for that run only. No version is recorded,
      // so the next command starts under the cooldown again.
      run = await runHeal(options, [...head, RELEASE_AGE_OVERRIDE, 'add', ...names])
    }
    const detail = tailOf(run.output)
    if (run.spawnError !== undefined) {
      return { status: 'unrepairable', missing, detail: redact(run.spawnError.message) }
    }
    if (run.timedOut) {
      const seconds = Math.round((options.timeoutMs ?? HEAL_TIMEOUT_MS) / 1000)
      return {
        status: 'unrepairable',
        missing,
        detail: `the install did not finish within ${String(seconds)} seconds and was terminated${detail === '' ? '' : `:\n${detail}`}`,
      }
    }
    const still = names.filter((name) => !specifierResolves(installedNameOf(name), options.profileDir))
    if (run.code !== 0 && still.length === 0) {
      // The CLI answered non-zero but the tree carries everything: the tree wins.
      return { status: 'healed', missing, ...(detail === '' ? {} : { detail }) }
    }
    if (run.code !== 0) {
      return {
        status: 'unrepairable',
        missing: [...still],
        detail: `the install failed (exit code ${String(run.code)})${detail === '' ? '' : `:\n${detail}`}`,
      }
    }
    if (still.length > 0) {
      return {
        status: 'unrepairable',
        missing: [...still],
        detail: `the install reported success but ${still.join(', ')} still does not resolve${detail === '' ? '' : `:\n${detail}`}`,
      }
    }
    return { status: 'healed', missing, ...(detail === '' ? {} : { detail }) }
  } catch (error) {
    return { status: 'unrepairable', missing, detail: redact((error as Error).message) }
  }
}

/** The outcome of a run that never produced a code: reported, never thrown. */
function runFailure(options: HealOptions, run: HealRun, missing: readonly string[]): ProfileHealOutcome {
  if (run.spawnError !== undefined) {
    return { status: 'unrepairable', missing: [...missing], detail: redact(run.spawnError.message) }
  }
  const seconds = Math.round((options.timeoutMs ?? HEAL_TIMEOUT_MS) / 1000)
  return { status: 'unrepairable', missing: [...missing], detail: `the install did not finish within ${String(seconds)} seconds and was terminated` }
}

/** The last `TAIL_LINES` non-empty lines of a captured output, redacted. */
function tailOf(output: string): string {
  const lines = output.split(/\r?\n/u).filter((line) => line.trim() !== '')
  return redact(lines.slice(-TAIL_LINES).join('\n'))
}

/**
 * The declared dependency names the profile does not have installed.
 *
 * @param profileDir - the profile directory.
 * @returns the missing names, in manifest order; empty when the manifest is
 *   absent or unreadable, which is the case that must run nothing.
 */
export async function missingDependencies(profileDir: string): Promise<string[]> {
  let manifest: unknown
  try {
    manifest = JSON.parse(await fs.readFile(path.join(profileDir, 'package.json'), 'utf8'))
  } catch {
    return []
  }
  const dependencies = (manifest as { dependencies?: Record<string, unknown> } | null)?.dependencies
  if (dependencies === null || typeof dependencies !== 'object') return []
  const nodeModules = path.join(profileDir, 'node_modules')
  return Object.keys(dependencies).filter((name) => {
    if (!DEPENDENCY_NAME_PATTERN.test(name)) return false
    // Follows links, so a `link:` dependency whose target is gone counts as
    // missing, which is what resolving it would do.
    return !existsSync(path.join(nodeModules, ...name.split('/'), 'package.json'))
  })
}

/** Kill one child and its descendants (the CLI spawns pnpm as a child). */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return
  if (process.platform === 'win32') {
    // The only reliable whole-tree kill for Windows children; without it the
    // pnpm grandchild survives and keeps the profile's lock.
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}

/** One CLI run: its exit code, its combined output, and whether it timed out. */
interface HealRun {
  readonly code: number
  readonly output: string
  readonly timedOut: boolean
  readonly spawnError?: Error
}

/**
 * The environment one repair run is spawned with.
 *
 * `DSH_HOME` is pinned (see {@link HealOptions.dshHome}) and the bundled pnpm
 * shim goes in front of `PATH` — the CLI spawns pnpm by NAME, and this run's
 * parent is the shell, not the host child whose `PATH` already carries it.
 * `PATH`'s spelling varies (`Path` on a stock Windows environment), so the
 * existing entry is rewritten under its own name.
 */
function healEnv(options: HealOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: options.dshHome }
  if (options.pnpmBinDir === undefined) return env
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
  env[key] = `${options.pnpmBinDir}${path.delimiter}${env[key] ?? ''}`
  return env
}

/**
 * Run the repair command once. Never rejects: a spawn error and the timeout are
 * data the caller turns into an outcome, because this step is never allowed to
 * fail the boot.
 */
function runHeal(options: HealOptions, argv: readonly string[]): Promise<HealRun> {
  const spawnImpl = options.spawnImpl ?? spawn
  const timeoutMs = options.timeoutMs ?? HEAL_TIMEOUT_MS
  return new Promise<HealRun>((resolvePromise) => {
    let child: ChildProcess
    try {
      child = spawnImpl(options.node, [...argv], {
        cwd: options.profileDir,
        windowsHide: true,
        // DSH_HOME is pinned, never inherited: the CLI resolves `--profile` as
        // `$DSH_HOME/profiles/<name>`, so an inherited value could send the
        // repair at another profile entirely while this one stays broken (see
        // the HealOptions.dshHome note).
        env: healEnv(options),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolvePromise({ code: -1, output: '', timedOut: false, spawnError: error as Error })
      return
    }
    let combined = ''
    let settled = false
    const capture = (chunk: Buffer | string): void => {
      if (combined.length >= STREAM_CAPTURE_BYTES) return
      combined += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      if (combined.length > STREAM_CAPTURE_BYTES) combined = combined.slice(0, STREAM_CAPTURE_BYTES)
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)
    const timer = setTimeout(() => {
      killTree(child.pid)
      settled = true
      resolvePromise({ code: -1, output: combined, timedOut: true })
    }, timeoutMs)
    const finish = (code: number, spawnError?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ code, output: combined, timedOut: false, ...(spawnError === undefined ? {} : { spawnError }) })
    }
    child.on('error', (error: Error) => { finish(-1, error) })
    child.on('close', (code: number | null) => { finish(code ?? -1) })
  })
}

/**
 * Repair a profile whose declared dependencies are not installed.
 *
 * A no-op — no process, no log line — whenever the profile has everything it
 * declares, which is every normal boot.
 *
 * @param options - the profile, the kernel CLI, the Node that runs it.
 * @returns what happened, for the caller's log line. Never throws.
 */
export async function healProfileDependencies(options: HealOptions): Promise<ProfileHealOutcome> {
  try {
    const missing = await missingDependencies(options.profileDir)
    if (missing.length === 0) return { status: 'ok', missing: [] }
    const argv = [
      options.bin,
      'plugin',
      '--profile',
      options.profileName,
      'install',
      '--config.minimumReleaseAge=0',
    ]
    const run = await runHeal(options, argv)
    const detail = tailOf(run.output)
    if (run.spawnError !== undefined) {
      return { status: 'unrepairable', missing, detail: redact(run.spawnError.message) }
    }
    if (run.timedOut) {
      const seconds = Math.round((options.timeoutMs ?? HEAL_TIMEOUT_MS) / 1000)
      return {
        status: 'unrepairable',
        missing,
        detail: `the install did not finish within ${String(seconds)} seconds and was terminated${detail === '' ? '' : `:\n${detail}`}`,
      }
    }
    if (run.code !== 0) {
      const exit = run.code
      return {
        status: 'unrepairable',
        missing,
        detail: `the install failed (exit code ${String(exit)})${detail === '' ? '' : `:\n${detail}`}`,
      }
    }
    // A zero exit is not proof: measured on the very profile this step exists
    // for, `pnpm install` answered "Already up to date" with the packages
    // missing, because its own state files still agreed with the lockfile. The
    // tree is the only witness that matters, so it is read again.
    const still = await missingDependencies(options.profileDir)
    if (still.length > 0) {
      return {
        status: 'unrepairable',
        missing: still,
        detail: `the install reported success but ${still.join(', ')} still does not resolve${detail === '' ? '' : `:\n${detail}`}`,
      }
    }
    return { status: 'healed', missing, ...(detail === '' ? {} : { detail }) }
  } catch (error) {
    return { status: 'unrepairable', missing: [], detail: redact((error as Error).message) }
  }
}

/**
 * The one log line for an outcome. Log-only (never rendered), so it stays out
 * of the locale tables and is written in English, and `ok` produces nothing at
 * all — a healthy boot must not gain a line saying so.
 *
 * @param outcome - what {@link healProfileDependencies} answered.
 * @param profileDir - the profile it ran against, for the message.
 * @returns the line, or null when there is nothing worth saying.
 */
export function healLogLine(outcome: ProfileHealOutcome, profileDir: string): string | null {
  if (outcome.status === 'ok') return null
  const names = outcome.missing.join(', ')
  if (outcome.status === 'healed') {
    return `[suite-profile] the profile was missing ${String(outcome.missing.length)} declared package(s) (${names}); reinstalled them`
  }
  return `[suite-profile] the profile is missing ${String(outcome.missing.length)} declared package(s) (${names}) and could not be repaired: ${outcome.detail ?? 'unknown error'}; the host start reports the consequence (profile: ${profileDir})`
}
