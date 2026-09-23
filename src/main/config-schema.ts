/**
 * The profile's static composition check, run on demand from the diagnostics
 * page: `dsh --profile <name> --dump-config-schema` composes the profile WITHOUT
 * mounting it and reports what it could not type-check.
 *
 * Why this is worth a shell action rather than a log tail: the kernel already
 * computes this, and its verdict is the difference between "the app looks wrong"
 * and "row /173 has no schema". Measured on 0.1.7, a fresh stock profile — no
 * suite rows, no user patch — reports four errors and one warning of its OWN, so
 * without attribution every reading of this tool blames the suite. That is what
 * {@link attributeDiagnostics} exists for.
 *
 * What it does NOT return: the schema document. The dump is ~900 KB of JSON
 * Schema for every entry, and the page shows a handful of diagnostic lines; the
 * bytes stay here, in the main process, where the CLI wrote them.
 *
 * @module dsh-app/main/config-schema
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

/** One diagnostic the kernel's checker reported. */
export interface ConfigSchemaDiagnostic {
  /** `error` fails the check; `warning` does not. */
  readonly level: 'error' | 'warning'
  /** The checker's own JSON pointer into the composed tree (`/173`). */
  readonly path: string
  /** The kernel's English message, verbatim. */
  readonly message: string
  /** The row's loader id at that pointer, when the dump names one. */
  readonly entryId?: string
  /** The row's module name at that pointer, when the dump names one. */
  readonly entryName?: string
  /**
   * Whether this diagnostic points at a row the SUITE owns (its module name is
   * one of ours). A diagnostic on somebody else's row is reported as such
   * rather than hidden: it is still a real finding about the running app.
   */
  readonly ours: boolean
  /**
   * The row's type-check status: `schema` when the kernel resolved a config
   * schema for it, `absent` when the package is not installed, `unsupported`
   * when the package is there but declares no native schema.
   */
  readonly status?: string
}

/** What one run of the checker produced. */
export interface ConfigSchemaReport {
  readonly profile: string
  /** Whether the kernel could type-check every entry it composed. */
  readonly complete: boolean
  /** Total entries in the composed tree, for context on the count. */
  readonly entries: number
  readonly diagnostics: readonly ConfigSchemaDiagnostic[]
  /** Diagnostics that point at a suite-owned row. */
  readonly ours: number
  /** Diagnostics on rows that are not ours (the kernel's own, or a third party's). */
  readonly others: number
}

/** Everything {@link checkConfigSchema} needs from the shell. */
export interface ConfigSchemaOptions {
  /** Absolute path of the kernel CLI entry (`@deepseek-ai/dsh/lib/bin.js`). */
  readonly bin: string
  /** Node executable that must run the CLI (never Electron's own). */
  readonly node: string
  /** The profile NAME, as `dsh --profile <name>` takes it. */
  readonly profileName: string
  /**
   * The harness home the profile belongs to. Load-bearing, like the heal step:
   * the CLI resolves `--profile` as `$DSH_HOME/profiles/<name>` and NOT from its
   * own cwd, so inheriting an ambient value could check a different profile and
   * report its verdict as this one's.
   */
  readonly dshHome: string
  /** Module-name prefixes that count as the suite's own rows. */
  readonly suitePrefixes: readonly string[]
  /** Test seam; defaults to `node:child_process.spawn`. */
  readonly spawnImpl?: typeof spawn
  /** Test seam; defaults to {@link CHECK_TIMEOUT_MS}. */
  readonly timeoutMs?: number
}

/** Cap on one run. Measured at ~2 s on 0.1.7 with a full profile; this is slack. */
const CHECK_TIMEOUT_MS = 60_000
/** Cap on captured output. The dump is ~900 KB; the diagnostics are a fraction. */
const CAPTURE_BYTES = 32 * 1024 * 1024

/** Whether a module name belongs to the suite. */
function isSuiteName(name: string | undefined, prefixes: readonly string[]): boolean {
  return name !== undefined && prefixes.some(prefix => name.startsWith(prefix))
}

/**
 * Turn the kernel's dump into the small report the page renders.
 *
 * The dump's own `x-cordis.entries` is the index the diagnostics' pointers refer
 * to, so a diagnostic can be attributed to a row without re-parsing the tree.
 * An entry whose `status` is `absent` is a package that is not installed: the
 * row exists in the composition but nothing is behind it, which is worth saying
 * plainly rather than reporting as a type error.
 *
 * @param dump - the parsed `--dump-config-schema` document.
 * @param suitePrefixes - module-name prefixes that count as the suite's own.
 * @returns the report, or null when the document is not the shape expected.
 */
export function attributeDiagnostics(dump: unknown, suitePrefixes: readonly string[]): ConfigSchemaReport | null {
  if (typeof dump !== 'object' || dump === null) return null
  const cordis = (dump as { 'x-cordis'?: unknown })['x-cordis']
  if (typeof cordis !== 'object' || cordis === null) return null
  const { profile, complete, entries, diagnostics } = cordis as {
    profile?: unknown
    complete?: unknown
    entries?: unknown
    diagnostics?: unknown
  }
  if (!Array.isArray(entries) || !Array.isArray(diagnostics)) return null

  const byPath = new Map<string, { id?: unknown, name?: unknown, status?: unknown }>()
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as { path?: unknown }
    if (typeof row.path === 'string') byPath.set(row.path, entry as { id?: unknown, name?: unknown, status?: unknown })
  }

  const reported: ConfigSchemaDiagnostic[] = []
  for (const item of diagnostics) {
    if (typeof item !== 'object' || item === null) continue
    const { level, path, message } = item as { level?: unknown, path?: unknown, message?: unknown }
    if (typeof path !== 'string' || typeof message !== 'string') continue
    const row = byPath.get(path)
    const id = typeof row?.id === 'string' ? row.id : undefined
    const name = typeof row?.name === 'string' ? row.name : undefined
    const status = typeof row?.status === 'string' ? row.status : undefined
    reported.push({
      level: level === 'warning' ? 'warning' : 'error',
      path,
      message,
      ...id === undefined ? {} : { entryId: id },
      ...name === undefined ? {} : { entryName: name },
      ...status === undefined ? {} : { status },
      ours: isSuiteName(name, suitePrefixes),
    })
  }

  const ours = reported.filter(item => item.ours).length
  return {
    profile: typeof profile === 'string' ? profile : '',
    complete: complete === true,
    entries: entries.length,
    diagnostics: reported,
    ours,
    others: reported.length - ours,
  }
}

/** One run: its exit code, its captured output, and whether it timed out. */
interface CheckRun {
  readonly code: number
  /** The run's STDOUT — the schema document lives here, and only here. */
  readonly output: string
  /** The run's STDERR — human-readable diagnostic lines. */
  readonly stderr: string
  readonly timedOut: boolean
  readonly spawnError?: Error
}

/**
 * Run the checker once. Never rejects: a spawn error and a timeout are data the
 * caller turns into an outcome.
 *
 * The two streams stay SEPARATE. They carry different things — the schema
 * document on stdout, the human-readable diagnostic lines on stderr — and
 * concatenating them makes the document unparsable the moment the kernel prints
 * a single diagnostic, because JSON.parse then meets text after the closing
 * brace ("Unexpected non-whitespace character after JSON", measured on 0.1.7).
 *
 * `windowsHide` is not optional here — the shell has no console, and a spawned
 * Node on Windows without it flashes a terminal over whatever the user is doing
 * (the repository rule about probes inside Electron).
 */
function runCheck(options: ConfigSchemaOptions, argv: readonly string[]): Promise<CheckRun> {
  const spawnImpl = options.spawnImpl ?? spawn
  const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS
  return new Promise<CheckRun>((resolvePromise) => {
    let child: ChildProcess
    try {
      child = spawnImpl(options.node, [...argv], {
        cwd: options.dshHome,
        windowsHide: true,
        env: { ...process.env, DSH_HOME: options.dshHome },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolvePromise({ code: -1, output: '', stderr: '', timedOut: false, spawnError: error as Error })
      return
    }
    let stdout = ''
    let stderr = ''
    const capture = (into: 'out' | 'err') => (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      if (into === 'out') {
        if (stdout.length < CAPTURE_BYTES) stdout += text
      } else if (stderr.length < CAPTURE_BYTES) {
        stderr += text
      }
    }
    child.stdout?.on('data', capture('out'))
    child.stderr?.on('data', capture('err'))
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      child.kill()
      resolvePromise({ code: -1, output: stdout, stderr, timedOut: true })
    }, timeoutMs)
    const finish = (code: number, spawnError?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ code, output: stdout, stderr, timedOut: false, ...(spawnError === undefined ? {} : { spawnError }) })
    }
    child.on('error', (error: Error) => { finish(-1, error) })
    child.on('close', (code: number | null) => { finish(code ?? -1) })
  })
}

/**
 * Pull the JSON document out of the checker's STDOUT.
 *
 * The dump is the whole of stdout, but it is located by its first brace rather
 * than parsed whole: a future kernel that prefixes a notice line would otherwise
 * break the page silently. stderr is deliberately not searched — it holds the
 * diagnostic lines, and one of them starting with `{` would be read as the
 * document.
 *
 * @param output - the run's stdout.
 * @returns the parsed document, or null when it carries none.
 */
export function parseDump(output: string): unknown {
  const start = output.indexOf('{')
  if (start < 0) return null
  try {
    return JSON.parse(output.slice(start))
  } catch {
    return null
  }
}

/**
 * Run the profile's static composition check.
 *
 * @param options - the CLI, the profile, and the attribution prefixes.
 * @returns the report; a thrown error carries a stable reason the caller maps
 *   to shell copy (the raw text can name paths, so it is logged, not sent).
 */
export async function checkConfigSchema(options: ConfigSchemaOptions): Promise<ConfigSchemaReport> {
  const run = await runCheck(options, [options.bin, '--profile', options.profileName, '--dump-config-schema'])
  if (run.spawnError !== undefined) throw new Error(`config check could not start: ${run.spawnError.message}`)
  if (run.timedOut) throw new Error('config check timed out')
  const dump = parseDump(run.output)
  if (dump === null) {
    // The kernel's own diagnostic lines explain WHY there is no document, so
    // they ride the thrown message (which the caller logs, never sends).
    const detail = run.stderr.trim().split('\n').slice(0, 3).join(' | ')
    throw new Error(`config check produced no schema document (exit ${String(run.code)}${detail === '' ? '' : `; ${detail}`})`)
  }
  const report = attributeDiagnostics(dump, options.suitePrefixes)
  if (report === null) throw new Error('config check produced an unrecognized schema document')
  return report
}
