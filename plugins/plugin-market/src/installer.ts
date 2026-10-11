/**
 * The install/uninstall executor: a thin, strictly-shaped wrapper around the
 * kernel's own plugin CLI.
 *
 * Install chain (per call):
 *   1. package name + optional exact version validated (npm.ts);
 *   2. exact version resolved FROM THE REGISTRY (`latest`, or the user's
 *      explicit exact version verified to exist) — catalog-declared versions
 *      are display metadata and never reach the CLI;
 *   3. `node <kernel bin.js> plugin --profile <profile> add <pkg>@<exact>`
 *      is spawned. The kernel CLI forwards to the profile's package manager
 *      and then reconciles `dsh.profile.bundles` against the installed state,
 *      so a package whose manifest declares `dsh.bundle` is mounted
 *      automatically on install and unmounted on remove — no patch-file
 *      editing happens here;
 *   4. stdout/stderr are captured (capped) and the tail is returned for the
 *      panel's log disclosure; the full text is scanned for pnpm's
 *      build-scripts-blocked signal so the panel can offer the whitelist +
 *      retry path (see blockedBuildsOf / build-allow.ts). Every run carries
 *      pnpm's release-age policy lifted for that run alone (see release-age.ts).
 *
 * Serialization: every install/remove is queued behind an in-process promise
 * chain, so concurrent panel actions can never run two package-manager
 * mutations against one profile at the same time.
 *
 * @module @dsh-app/plugin-market/installer
 */

import { spawn } from 'node:child_process'
import { MarketBlockedBuildError, MarketExecutionError, MarketValidationError, type HostText } from './errors.ts'
import { RELEASE_AGE_OVERRIDE, isReleaseAgeFailure } from './release-age.ts'
import { GIT_TARGET_PATTERN } from './catalog.ts'
import {
  PACKAGE_NAME_PATTERN,
  resolveDshBin,
  resolveRegistryVersion,
  validateExactVersion,
  validatePackageName,
  validateProfileName,
  tailLines,
} from './npm.ts'

/** CLI timeout: package-manager runs on cold caches can be slow. */
const CLI_TIMEOUT_MS = 120_000

/**
 * The coded message of a failed CLI run: with no output there is nothing to
 * show but the exit code, and with output the tail IS the diagnostic (it rides
 * a params slot, never a sentence the host wrote).
 */
function commandFailureHost(tail: string, code: number | undefined): HostText {
  if (tail === '') {
    const exit = code ?? 'unknown'
    return {
      code: 'install.commandFailed',
      params: { code: exit },
      text: `the command failed (exit code ${String(exit)})`,
    }
  }
  return { code: 'install.commandFailedLog', params: { log: tail }, text: `the command failed:\n${tail}` }
}

/** Per-stream capture cap before truncation. */
const STREAM_CAPTURE_BYTES = 64 * 1024

/** Output tail length returned to the panel. */
export const OUTPUT_TAIL_LINES = 30

/**
 * What pnpm prints when it skipped dependency build scripts (en + zh across
 * pnpm 10/11 wordings): the run itself succeeds, but postinstall output such
 * as native binaries is missing until the packages are whitelisted.
 */
const BUILD_BLOCKED_SIGNAL = /build scripts are blocked by pnpm|Ignored build scripts:|构建脚本被 .* 拦截/i

/** The pnpm ≤10 list form: names run from the colon to the sentence end. */
const IGNORED_LIST_LINE = /Ignored build scripts?:\s*(.+)$/i

/**
 * Package names whose build scripts pnpm skipped, extracted from the CLI
 * output — or null when no blocked signal is present. Both wordings are
 * parsed: the pnpm ≤10 list ("Ignored build scripts: a, b. Run …", cut at the
 * sentence end) and the pnpm ≥11 parenthesized name, ASCII or full-width.
 * Anything outside the npm package grammar is dropped: these names are merged
 * into pnpm-workspace.yaml later, so free-form log text must never leak in.
 */
export function blockedBuildsOf(output: string): readonly string[] | null {
  if (!BUILD_BLOCKED_SIGNAL.test(output)) return null
  const names: string[] = []
  const push = (raw: string): void => {
    const name = raw.trim()
    if (name === '' || !PACKAGE_NAME_PATTERN.test(name) || names.includes(name)) return
    names.push(name)
  }
  for (const line of output.split(/\r?\n/)) {
    const ignored = IGNORED_LIST_LINE.exec(line)
    if (ignored !== null) {
      // The list ends at the first ". " sentence boundary; a trailing period
      // without a sentence is stripped too.
      for (const part of ignored[1]!.replace(/\.\s.*$/, '').replace(/\.$/, '').split(',')) push(part)
      continue
    }
    if (!BUILD_BLOCKED_SIGNAL.test(line)) continue
    for (const paren of line.matchAll(/[(（]([^)）]+)[)）]/g)) {
      for (const part of paren[1]!.split(',')) push(part)
    }
  }
  return names
}

/** Result of one successful CLI run. */
export interface CliRunResult {
  /** Exact version installed (install only; undefined for remove). */
  readonly version?: string
  /** Tail of combined stdout/stderr, for the panel's log disclosure. */
  readonly output: string
  /**
   * Package names whose build scripts pnpm skipped during this run, present
   * only when a blocked signal was detected (possibly empty when no name could
   * be extracted from the message); undefined = nothing was blocked.
   */
  readonly blockedBuilds?: readonly string[]
}

/**
 * Validate a git install target and hand it to the CLI verbatim.
 *
 * The shape is re-validated here even though the catalog already did: the
 * value travels through the panel and back over HTTP, and the CLI argv is
 * where an unvalidated string would do damage.
 *
 * The target is NOT re-pinned to a commit here. An earlier version resolved
 * HEAD through `api.github.com/repos/<repo>/commits/HEAD` and installed
 * `github:owner/repo#<sha>`; measured on a plain link, that endpoint answers
 * 403 with `x-ratelimit-remaining: 0` (the unauthenticated limit is 60 per
 * hour per IP, and behind the app's proxy the egress IP is shared), while
 * `codeload.github.com` — what pnpm actually fetches — answered 200 in 540 ms.
 * So the pin was the ONLY thing that could fail, and it failed on ordinary
 * use. The alternative channel (parsing the `info/refs` pkt-line
 * advertisement, i.e. what `git ls-remote` does over HTTPS) means
 * hand-writing a protocol parser, which this repository's rules forbid.
 *
 * Nothing is lost by not pinning: `github:owner/repo` is the exact form the
 * catalog's own install command carries, pnpm resolves HEAD itself and
 * records the resolved commit in the profile's `pnpm-lock.yaml`, and every
 * later install reproduces that commit through the lockfile. The profile
 * manifest keeps the floating shortcut, which is what a re-install should
 * follow.
 *
 * @param gitTarget - the catalog-provided target, `github:owner/repo`
 *   (a `#<40-hex>` pin is accepted and passed through untouched).
 * @returns the validated target, verbatim.
 */
export function resolveGitInstallTarget(gitTarget: unknown): string {
  if (typeof gitTarget !== 'string' || !GIT_TARGET_PATTERN.test(gitTarget)) {
    throw new MarketValidationError({
      code: 'install.gitTargetInvalid',
      text: 'the git install target must read github:owner/repo (optionally #commit)',
    })
  }
  return gitTarget
}

/** One finished CLI invocation, successful or not (see runOnce). */
interface CliRunOutcome {
  /** Process exit code. */
  readonly code: number
  /** Tail of combined stdout/stderr, for the panel's log disclosure. */
  readonly output: string
  /** The untruncated capture, for signal scanning. */
  readonly raw: string
  /** Blocked build scripts, or null when the output carried no such signal. */
  readonly blockedBuilds: readonly string[] | null
}

type SpawnLike = typeof spawn

/**
 * Install/uninstall executor over one profile.
 */
export class PluginInstaller {
  /** Tail of the in-process mutation queue (install/remove mutex). */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly profile: string,
    private readonly argv1: string | undefined = process.argv[1],
    private readonly spawnImpl: SpawnLike = spawn,
    private readonly log: (message: string) => void = () => {},
  ) {}

  /**
   * Install one package into the profile at the registry-resolved version.
   * @param pkg - requested package name (validated here).
   * @param requestedVersion - user-specified exact version or undefined.
   * @returns the resolved version and the CLI output tail.
   */
  async install(pkg: unknown, requestedVersion?: unknown): Promise<CliRunResult> {
    const name = validatePackageName(pkg)
    const version = validateExactVersion(requestedVersion)
    return this.enqueue(async () => {
      const exact = await resolveRegistryVersion(name, version)
      const { output, blockedBuilds } = await this.runCli(['add', `${name}@${exact}`])
      this.log(`plugin-market: installed ${name}@${exact} into profile ${this.profile}`)
      return { version: exact, output, ...(blockedBuilds !== null ? { blockedBuilds } : {}) }
    })
  }

  /**
   * Install one plugin from its GitHub source.
   *
   * The target is re-validated here (the panel could have been fed a stale
   * catalog) and handed to the CLI verbatim: `github:owner/repo`, which is
   * the form the catalog's own install command carries. pnpm resolves HEAD
   * and records the resolved commit in the profile's lockfile, so the
   * install stays reproducible without this host depending on a commit-lookup
   * service (see {@link resolveGitInstallTarget} for the measurement that
   * retired the API-based pin).
   *
   * No registry step: a git source has no npm version to resolve, which is
   * the point of the path. The spec IS the version identity, and the panel's
   * installed view classifies the result as a git source (no npm update is
   * ever offered for it).
   *
   * @param gitTarget - `github:owner/repo` or `github:owner/repo#<40-hex>`.
   * @returns the target as the version identity and the CLI output tail.
   */
  async installGit(gitTarget: unknown): Promise<CliRunResult> {
    const target = resolveGitInstallTarget(gitTarget)
    return this.enqueue(async () => {
      const { output, blockedBuilds } = await this.runCli(['add', target])
      this.log(`plugin-market: installed ${target} into profile ${this.profile}`)
      return { version: target, output, ...(blockedBuilds !== null ? { blockedBuilds } : {}) }
    })
  }

  /**
   * Remove one package from the profile. The kernel CLI's reconciliation
   * drops the bundle entry; a package that is not installed fails in the CLI
   * and surfaces through the output tail.
   * @param pkg - requested package name (validated here).
   * @returns the CLI output tail.
   */
  async uninstall(pkg: unknown): Promise<CliRunResult> {
    const name = validatePackageName(pkg)
    return this.enqueue(async () => {
      const { output } = await this.runCli(['remove', name])
      this.log(`plugin-market: removed ${name} from profile ${this.profile}`)
      return { output }
    })
  }

  /**
   * Serialize mutations: each job waits for the previous one to settle.
   * Exposed for profile mutations that are not CLI runs (the build-script
   * whitelist write) so they can never interleave with an install either.
   */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job)
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Run one job under the same mutex as install/uninstall (see enqueue). */
  exclusive<T>(job: () => Promise<T>): Promise<T> {
    return this.enqueue(job)
  }

  /**
   * Run `node <dshBin> plugin --profile <p> <args...>` and capture output.
   * argv-only spawning (no shell), hidden window, hard timeout with a
   * whole-process-tree kill (the CLI spawns a package manager child).
   *
   * The FULL combined output (not the returned tail) is scanned for pnpm's
   * build-scripts-blocked signal: the warning prints near the front of long
   * install logs and would not survive the tail cut. A blocked signal turns a
   * non-zero exit into MarketBlockedBuildError so the panel can offer the
   * allow-and-retry path instead of a bare failure.
   *
   * The release-age policy is lifted for the run ITSELF (see release-age.ts),
   * never persisted. A directory whose lockfile pins a version inside pnpm's
   * window is otherwise blocked for EVERY command — install and uninstall alike —
   * for the rest of that window, which is the normal state of this profile rather
   * than an exception: the suite and the followed kernel line publish same-day,
   * and so does every plugin the user has just installed. Measured on the real
   * profile (2026-09-28): two entries in the window, and `pnpm install
   * --lockfile-only` failed on them with ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION
   * before touching anything. Waiting for that failure and re-running would work
   * — it is what this class used to do — but it pays a rejected package-manager
   * run on every action and logs an error the user did nothing to deserve.
   */
  private async runCli(args: readonly string[]): Promise<{ output: string, blockedBuilds: readonly string[] | null }> {
    const outcome = await this.runOnce([RELEASE_AGE_OVERRIDE, ...args])
    if (outcome.code !== 0) {
      if (isReleaseAgeFailure(outcome.raw)) {
        // The override did not clear it: a pnpm whose config key or policy codes
        // moved, or a policy this module does not know. Named here so the log
        // points at the cause instead of only at pnpm's own output.
        this.log(`plugin-market: pnpm's release-age policy rejected a run carrying ${RELEASE_AGE_OVERRIDE} (profile ${this.profile})`)
      }
      throw outcome.blockedBuilds !== null
        ? new MarketBlockedBuildError(commandFailureHost(outcome.output, outcome.code), outcome.blockedBuilds)
        : new MarketExecutionError(commandFailureHost(outcome.output, outcome.code), 'cli')
    }
    return { output: outcome.output, blockedBuilds: outcome.blockedBuilds }
  }

  /**
   * One CLI invocation. A non-zero exit is data (the caller decides between
   * the blocked-builds path, the release-age retry, and a reported failure);
   * only a spawn error or the timeout rejects.
   */
  private runOnce(args: readonly string[]): Promise<CliRunOutcome> {
    const profile = validateProfileName(this.profile)
    const bin = resolveDshBin(this.argv1)
    return new Promise<CliRunOutcome>((resolvePromise, rejectPromise) => {
      const child = this.spawnImpl(process.execPath, [bin, 'plugin', '--profile', profile, ...args], {
        windowsHide: true,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let combined = ''
      let truncated = false
      const onChunk = (chunk: Buffer | string): void => {
        if (combined.length >= STREAM_CAPTURE_BYTES) {
          truncated = true
          return
        }
        combined += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        if (combined.length > STREAM_CAPTURE_BYTES) {
          combined = combined.slice(0, STREAM_CAPTURE_BYTES)
          truncated = true
        }
      }
      child.stdout?.on('data', onChunk)
      child.stderr?.on('data', onChunk)

      const timer = setTimeout(() => {
        killTree(child.pid)
        const seconds = Math.round(CLI_TIMEOUT_MS / 1000)
        rejectPromise(new MarketExecutionError({
          code: 'install.timeout',
          params: { seconds },
          text: `install/uninstall timed out after ${String(seconds)} seconds; the command was terminated`,
        }, 'timeout'))
      }, CLI_TIMEOUT_MS)

      const finish = (error: Error | undefined, code: number | undefined): void => {
        clearTimeout(timer)
        if (error !== undefined) {
          rejectPromise(error)
          return
        }
        const blockedBuilds = blockedBuildsOf(combined)
        // The tail is the CLI's own output — the panel shows it in its log
        // disclosure, so it rides a message's params as data, never as copy.
        const tail = tailLines(truncated ? `${combined}\n…（输出已截断）` : combined, OUTPUT_TAIL_LINES)
        resolvePromise({ code: code ?? -1, output: tail, raw: combined, blockedBuilds })
      }

      child.on('error', (error: Error) => finish(error, undefined))
      child.on('close', (code: number | null) => finish(undefined, code ?? -1))
    })
  }
}

/**
 * Kill one child and its descendants. The CLI spawns a package-manager child
 * that a plain kill would orphan (on Windows it would keep the profile lock).
 */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return
  if (process.platform === 'win32') {
    // taskkill is the only reliable whole-tree kill for Windows children.
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
