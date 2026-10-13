/**
 * Structured event sink for the shell: `<logs>/dsh-events.jsonl`.
 *
 * Why this exists beside `dsh-kernel.log`: that file is free text mixing the
 * kernel child's own output with the shell's milestones, so "when did the host
 * last restart, and how long did that install take" is a grep through tens of
 * thousands of lines. One JSON object per line — with a per-start correlation
 * id, a monotonic sequence and a duration where one is meaningful — makes those
 * questions a filter instead of a read.
 *
 * Shape, one line per event:
 *
 *   {"ts":"2026-10-13T09:12:04.512Z","event":"host.start.ready","seq":5,
 *    "run":"20261013T091155Z-4172-a3f1","pid":4172,"ms":8312,
 *    "detail":{"transport":"web","kernel":"0.2.0-rc.2"}}
 *
 * - `ts` — ISO instant, UTC.
 * - `event` — a stable name (`host.start.ready`). A name outside
 *   `[a-z0-9._]` is recorded as `event.invalid`, with the rejected name in
 *   `detail.event`, so a typo cannot invent a new namespace.
 * - `seq` — 1-based, strictly increasing across the lines actually written in
 *   this run (a line that could not be written does not consume a number, so a
 *   gap never has to be interpreted).
 * - `run` — the correlation id of one application start
 *   (`<stamp>-<pid>-<nonce>`, see {@link newRunId}); every event of one run
 *   carries the same value, which is what lets one start be read out of a file
 *   that several runs append to.
 * - `pid` — the shell's own process id.
 * - `ms` — the duration the event reports: the operation's elapsed time on an
 *   `.end` event, the time since the run began on a startup milestone. Absent
 *   where nothing is measured.
 * - `detail` — up to {@link MAX_EVENT_DETAIL_KEYS} scalar fields. Every string
 *   value is redacted and capped at `MAX_LOG_LINE` BEFORE it is serialized:
 *   redaction inside a line could otherwise cut valid JSON in half. One of those
 *   keys is the sink's own `truncated` note, which states how many fields were
 *   left out; a caller field using that name gives way to it (see
 *   `renderDetail`).
 *
 * **What never lands here**: prompt text, tool arguments or results, HTTP/SSE
 * bodies, authentication headers, cookies, tokens — and, on the one path where
 * the shell is handed the CHILD'S OWN OUTPUT, that output. `host.start.failed`
 * records derived facts only (`how`, `code`, `signal`, `attempt`); the Error it
 * is built from carries the host's last 2 KB of stderr, which on a real
 * `dsh-server-*.log` tail is the full host path, the child's whole argv and the
 * account plugin's request lines. That tail stays where it already is
 * (`dsh-kernel.log`, `dsh-server-*.log`) and on the user-visible failure card.
 * `app.boot.failed` is the same case one layer up — the rejection it catches is
 * an arbitrary library's, not this codebase's — and records derived facts only
 * too (see `errorFactsDetail`), with its message going to `dsh-kernel.log` and
 * to the failure card instead.
 *
 * What does reach the sink is the shell's own material: it emits events at its
 * own milestones and every string value passes through `redact()` (see
 * `redact.ts`), so the worst case is a credential-shaped fragment replaced by
 * `[redacted]` and a payload-sized value truncated to 2 KB. The API has no
 * channel for content: a value is a scalar; a structured value with no JSON
 * rendering is recorded as a marker rather than as text that reads like a value
 * and says nothing (see `sanitizeDetailValue`); and an Error's own MESSAGE is
 * recorded only where this codebase wrote it (`trackedEventOperation`).
 *
 * Every write is SYNCHRONOUS — `mkdirSync`, one `statSync`, one
 * `appendFileSync`, with nothing queued behind them — so the caller does wait
 * for the line to land. Measured here: 0.07 ms an event and ~1 ms for a boot's
 * 13 events, which is why blocking is acceptable at all.
 *
 * Bounds — an unbounded log is worse than none (the reason stated in
 * `log-file.ts`), so every part of the family is capped:
 *
 * - live file `<logs>/dsh-events.jsonl`;
 * - rotation by SIZE: once the live file reaches {@link EVENT_LOG_MAX_BYTES}
 *   (2 MB) it is renamed to
 *   `dsh-events.<yyyyMMdd>T<HHmmss>Z.<nn>.jsonl` and the live file restarts;
 * - rotation by DAY: the first write of a new UTC day also rotates, so no file
 *   mixes two days even when it is small — and a reader can delete "yesterday"
 *   as a file rather than filtering by `ts`. The name carries the moment the
 *   file CLOSED (the size rule's own name) — or, when the clock reads EARLIER
 *   than the newest generation already stored, that generation's own stamp (see
 *   `rotationStamp`). Clamping is what keeps the name order equal to the
 *   rotation order, which is the only order retention can act on: without it a
 *   clock that stepped backwards named the file it had just closed with the
 *   OLDEST stamp in the directory, and the pass below deleted it on the spot;
 * - retention: the newest {@link EVENT_LOG_KEEP_ROTATIONS} (4) generations are
 *   kept, older ones are deleted right after a rotation. Each removal stands on
 *   its own: a directory carrying a generation's name makes `rmSync` fail with
 *   `ERR_FS_EISDIR`, and one such failure used to abandon the whole pass AND the
 *   write that followed it (the rotation has already renamed the live file away
 *   by then). Only names matching {@link isRotatedEventFileName} are ever
 *   touched, so no other file in the log directory can be removed by this
 *   module;
 * - ceiling: {@link EVENT_LOG_MAX_TOTAL_BYTES} (10 MB) for the whole family.
 *   The cap is checked before a write, so a rotated file can exceed the 2 MB
 *   mark by exactly one line.
 *
 * The budget is that size because the alternative to a bound is a directory that
 * grows for the life of the installation: nothing else rotates this file away,
 * and the shell's own `dsh-server-*.log` files (10 kept, no size cap each)
 * already sit beside it. Measured on the shipped build: a boot emits 13 events,
 * 2.3 KB in total (178 bytes a line), so one 2 MB file holds ~900 starts and the
 * whole family a few thousand — months of daily use, or every start of a boot
 * loop for days. Past that the file that matters is the newest one, and a boot
 * loop worth diagnosing rotates for real.
 *
 * Nothing this sink is handed can make it throw (a log must not fail a boot) and
 * nothing is swallowed: a failed write and a `detail` value that cannot be
 * rendered (a `toJSON` or `toString` that throws) take the same path — the FIRST
 * failure of an episode reaches `onFailure` once, the shell points that at
 * `dsh-kernel.log`, and a later successful write closes the episode, so a new
 * failure is reported again rather than being lost behind the first one.
 *
 * @module dsh-app/main/event-log
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { redact } from './redact'

/** Live event file, beside `dsh-kernel.log` in the log directory. */
export const EVENT_LOG_FILENAME = 'dsh-events.jsonl'

/** Rotate the live file once it reaches this size (~2 MiB). */
export const EVENT_LOG_MAX_BYTES = 2_000_000

/** Rotated generations kept beside the live file. */
export const EVENT_LOG_KEEP_ROTATIONS = 4

/**
 * Ceiling for the whole family — live file plus every generation kept:
 * `EVENT_LOG_MAX_BYTES * (EVENT_LOG_KEEP_ROTATIONS + 1)` = 10 MB. A rotated
 * file may exceed the per-file cap by the single line that crossed it.
 */
export const EVENT_LOG_MAX_TOTAL_BYTES = EVENT_LOG_MAX_BYTES * (EVENT_LOG_KEEP_ROTATIONS + 1)

/**
 * Detail fields one event may carry. One of them is the sink's own `truncated`
 * note when anything had to be left out, so a record never carries more keys
 * than this number.
 */
export const MAX_EVENT_DETAIL_KEYS = 12

/** An event name: lower-case segments joined by `.` or `_` (`host.start.ready`). */
const EVENT_NAME_RE = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/

/** Rotated file names: `dsh-events.<yyyyMMdd>T<HHmmss>Z.<nn>.jsonl`. */
const ROTATED_PREFIX = 'dsh-events.'
const ROTATED_SUFFIX = '.jsonl'
const ROTATED_NAME_RE = /^dsh-events\.\d{8}T\d{6}Z\.\d{2}\.jsonl$/

/** One scalar of an event's `detail`. */
export type EventDetailValue = string | number | boolean | null

/** The record as it is serialized (see the module note for field meanings). */
export interface ShellEventRecord {
  ts: string
  event: string
  seq: number
  run: string
  pid: number
  ms?: number
  detail?: Record<string, EventDetailValue>
}

/** Who wrote an event: the correlation id, the process, and the sequence. */
export interface EventIdentity {
  run: string
  pid: number
  seq: number
}

/** What a caller supplies for one event. */
export interface EventInput {
  /** Stable event name (`host.start.ready`). */
  event: string
  /** The duration this event reports, in milliseconds. */
  ms?: number
  /** Scalar diagnostics; every string is redacted and capped. */
  detail?: Record<string, unknown>
}

/** Options for one {@link EventLog}. */
export interface EventLogOptions {
  /** Directory the family lives in — the shell's `<logs>`. */
  dir: string
  /** Correlation id for this run; defaults to {@link newRunId} of `now()` and this pid. */
  run?: string
  /** Clock, injected so a test can pin a rotation boundary. */
  now?: () => Date
  /**
   * Called once per failure episode: the first failed write is reported, and a
   * later successful write lets the next failure be reported again. Point it at
   * the shell's log (`index.ts` writes one `dsh-kernel.log` line).
   */
  onFailure?: (error: unknown) => void
}

/** UTC day of a moment, `yyyy-mm-dd`: the day rule's key. */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10)
}

/** Compact UTC stamp used in a run id and a rotated file name: `20261013T091155Z`. */
function utcStamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

/**
 * Correlation id for one application start: `<stamp>-<pid>-<nonce>`. Readable
 * and sortable (the stamp is UTC), the pid says which process, and the nonce
 * makes two ids distinct even when a restart lands on the same second — with a
 * recycled pid, or two sinks in one process, `<stamp>-<pid>` alone would not.
 *
 * @param at - when the run began.
 * @param pid - the shell's process id.
 * @param nonce - short random suffix; passed in by a test, drawn here otherwise.
 * @returns the run id.
 */
export function newRunId(at: Date, pid: number, nonce: string = randomBytes(2).toString('hex')): string {
  return `${utcStamp(at)}-${String(pid)}-${nonce}`
}

/**
 * Name of the generation a rotation produces.
 *
 * @param at - the moment of the rotation (the upper bound of the file's content).
 * @param index - 1-based suffix, 2 digits, disambiguating two rotations in one second.
 * @returns the file name, without its directory.
 */
export function rotatedEventFileName(at: Date, index: number): string {
  return rotatedNameFromStamp(utcStamp(at), index)
}

/** One generation's file name, from an already-formatted stamp. */
function rotatedNameFromStamp(stamp: string, index: number): string {
  return `${ROTATED_PREFIX}${stamp}.${String(Math.max(1, Math.trunc(index))).padStart(2, '0')}${ROTATED_SUFFIX}`
}

/**
 * The stamp inside a rotated name (`20261013T091155Z`). Only meaningful for a
 * name {@link isRotatedEventFileName} accepted.
 */
function stampOfRotatedName(name: string): string {
  return name.slice(ROTATED_PREFIX.length, name.length - ROTATED_SUFFIX.length).slice(0, 16)
}

/**
 * Whether a directory entry is a rotated generation this module owns. The
 * retention pass deletes only names this returns true for.
 *
 * @param name - a bare file name.
 * @returns true for `dsh-events.<stamp>.<nn>.jsonl`.
 */
export function isRotatedEventFileName(name: string): boolean {
  return ROTATED_NAME_RE.test(name)
}

/**
 * What a value with no JSON rendering and no usable text is recorded as. A
 * marker, not a value: exactly the cases this catches — a cycle, an object
 * holding a BigInt — are the ones where `String(value)` answers
 * `[object Object]`, text that reads like a value while saying nothing, which
 * is how an unreadable object once hid inside a shared log.
 */
const UNSERIALISABLE = '[unserialisable]'

/** `String(value)`, guarded against a value whose own `toString` throws. */
function safeText(value: unknown): string {
  try {
    return String(value)
  } catch {
    return UNSERIALISABLE
  }
}

/**
 * One `detail` value, made safe to serialize. Strings are redacted (which also
 * caps them at `MAX_LOG_LINE`); a non-finite number becomes null; an Error is
 * named by its message rather than by `{}`; a function or a symbol — the two
 * things JSON has no form for at all — keeps its own text; anything else is
 * rendered as JSON, and a value JSON cannot render is marked rather than
 * described as text. `undefined` drops the key, and no input can make this
 * throw: the caller was promised a sink that does not fail its boot.
 *
 * @param value - the caller's value.
 * @returns the serializable scalar, or undefined to drop the key.
 */
function sanitizeDetailValue(value: unknown): EventDetailValue | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return redact(value)
  if (value instanceof Error) return redact(`${value.name}: ${value.message}`)
  if (typeof value === 'function' || typeof value === 'symbol') return redact(safeText(value))
  try {
    const json = JSON.stringify(value)
    if (json !== undefined) return redact(json)
  } catch {
    // A cycle or a BigInt reaches here; `JSON.stringify` returns undefined for
    // an object whose `toJSON` answers undefined. Both are unreadable as text.
  }
  return redact(UNSERIALISABLE)
}

/** The one `detail` key the sink writes itself; see {@link renderDetail}. */
const TRUNCATION_NOTE_KEY = 'truncated'

/**
 * The `detail` object of one record, or undefined when there is nothing to say.
 *
 * Keys are capped at {@link MAX_EVENT_DETAIL_KEYS}: the note is one of them, so
 * a record never carries more keys than the cap states, and the note's value is
 * the number of entries this call did NOT keep — including a caller field that
 * had to give way for the note itself.
 *
 * The note's key belongs to the sink. A caller field using it is superseded
 * rather than written beside it: a reader has to be able to read `truncated` as
 * the sink's own statement, and no second spelling of the key could be told
 * apart from a caller's field.
 *
 * @param detail - the caller's fields.
 * @param rejectedEvent - the name an `event.invalid` line was given, if any.
 * @returns the serializable detail, or undefined when there is nothing to say.
 */
function renderDetail(
  detail: Record<string, unknown> | undefined,
  rejectedEvent: string | undefined,
): Record<string, EventDetailValue> | undefined {
  const entries: Array<[string, EventDetailValue]> = []
  if (rejectedEvent !== undefined) entries.push(['event', redact(rejectedEvent)])
  for (const [key, value] of Object.entries(detail ?? {})) {
    const safe = sanitizeDetailValue(value)
    if (safe !== undefined) entries.push([redact(key), safe])
  }
  if (entries.length === 0) return undefined
  const caller = entries.filter(([key]) => key !== TRUNCATION_NOTE_KEY)
  // A note is owed when a caller field lost its key to the note, or when the
  // caller's fields do not all fit. One slot is reserved for it in the second
  // case, so what is left out is exactly what the note reports: replacing the
  // LAST kept entry with the note, as this once did, dropped one more than it
  // could state.
  const noteOwed = caller.length !== entries.length || caller.length > MAX_EVENT_DETAIL_KEYS
  const kept = caller.slice(0, noteOwed ? MAX_EVENT_DETAIL_KEYS - 1 : MAX_EVENT_DETAIL_KEYS)
  const dropped = entries.length - kept.length
  if (dropped > 0) kept.push([TRUNCATION_NOTE_KEY, dropped])
  return Object.fromEntries(kept)
}

/**
 * The name a rejected event is recorded under `detail.event`: the value's own
 * text, never re-entered into the pattern. This path exists BECAUSE the caller
 * passed something odd, so it is the last one that may throw — a value with a
 * hostile `toString` yields the marker instead.
 */
function rejectedEventText(event: unknown): string {
  return typeof event === 'string' ? event : safeText(event)
}

/**
 * Render one event as a single jsonl line (no trailing newline). Pure: no file
 * system, no clock of its own — `at` is a parameter.
 *
 * The name is accepted as a `string` only. Anything else is refused the same way
 * an out-of-namespace name is, before the pattern can coerce it: a number would
 * pass `EVENT_NAME_RE.test` as text and then reach `redact()` as a number, which
 * throws `line.replace is not a function` out of a sink that promises not to.
 *
 * @param input - the event name, an optional duration and detail fields.
 * @param identity - the run id, pid and sequence the line is stamped with.
 * @param at - the instant the event is recorded at.
 * @returns one line of JSON, safe to append to the event file.
 */
export function renderEventLine(input: EventInput, identity: EventIdentity, at: Date = new Date()): string {
  const name = typeof input.event === 'string' && EVENT_NAME_RE.test(input.event) ? input.event : 'event.invalid'
  const record: ShellEventRecord = {
    ts: at.toISOString(),
    event: name,
    seq: identity.seq,
    run: redact(identity.run),
    pid: identity.pid,
  }
  if (typeof input.ms === 'number' && Number.isFinite(input.ms)) record.ms = Math.max(0, Math.round(input.ms))
  const detail = renderDetail(input.detail, name === 'event.invalid' ? rejectedEventText(input.event) : undefined)
  if (detail !== undefined) record.detail = detail
  return JSON.stringify(record)
}

/**
 * The event sink: one live jsonl file, rotated by size and by day, with a
 * bounded family (see the module note). One instance per process, owned by
 * {@link configureEventLog}.
 */
export class EventLog {
  private readonly dir: string
  private readonly run: string
  private readonly pid: number
  private readonly now: () => Date
  private readonly onFailure: ((error: unknown) => void) | undefined
  /** Sequence of the lines already written; the next event gets `seq + 1`. */
  private seq = 0
  /** UTC day the live file was last written; seeded from its own mtime. */
  private liveDay: string | null = null
  /** Set while a failure has been reported and no write has succeeded since. */
  private failureReported = false

  constructor(options: EventLogOptions) {
    this.dir = options.dir
    this.pid = process.pid
    this.now = options.now ?? ((): Date => new Date())
    this.run = options.run ?? newRunId(this.now(), this.pid)
    this.onFailure = options.onFailure
  }

  /** Absolute path of the live file. */
  get file(): string {
    return path.join(this.dir, EVENT_LOG_FILENAME)
  }

  /** Sequence number of the last line written (0 before the first). */
  get lastSeq(): number {
    return this.seq
  }

  /**
   * Record one event. Never throws: a failed write is reported through
   * `onFailure` once per episode (see the module note).
   *
   * @param event - stable event name.
   * @param options - optional duration and detail fields.
   */
  log(event: string, options: { ms?: number; detail?: Record<string, unknown> } = {}): void {
    try {
      // RENDERING is inside the try, not only the write: `detail` is the
      // caller's own data, and a value whose `toJSON` or `toString` throws used
      // to escape from here — the one function documented as never throwing.
      const at = this.now()
      const line = renderEventLine(
        { event, ms: options.ms, detail: options.detail },
        { run: this.run, pid: this.pid, seq: this.seq + 1 },
        at,
      )
      this.append(line, at)
      this.seq += 1
      this.failureReported = false
    } catch (error) {
      if (this.failureReported) return
      this.failureReported = true
      try {
        this.onFailure?.(error)
      } catch {
        // The reporter is the caller's own code (a log line): it must not turn a
        // failed write into a thrown one.
      }
    }
  }

  /** Rotate when due, then append the line. Throws so {@link log} can report it. */
  private append(line: string, at: Date): void {
    mkdirSync(this.dir, { recursive: true })
    const file = this.file
    const stat = statSync(file, { throwIfNoEntry: false })
    const size = stat?.size ?? 0
    const day = utcDay(at)
    // Seeded from the file's own mtime: the day rule has to see the file a
    // PREVIOUS run left behind, not today's date. An empty file (or none) is
    // today's.
    const liveDay = this.liveDay ?? (size === 0 || stat === undefined ? day : utcDay(stat.mtime))
    if (size >= EVENT_LOG_MAX_BYTES || liveDay !== day) this.rotate(file, at)
    appendFileSync(file, `${line}\n`)
    this.liveDay = day
  }

  /**
   * The stamp a rotation is named with: `at`, or the newest stamp already on
   * disk when the clock reads EARLIER than that.
   *
   * A clock that steps backwards — a manual correction, a VM or backup restore
   * — used to name the file it had just closed with a stamp older than
   * generations already stored, and the retention pass, which keeps the newest
   * BY NAME, then deleted the generation the same call had created. Clamping
   * keeps the name order equal to the rotation order, which is the only order
   * retention can act on.
   *
   * @param at - when the rotation happened.
   * @returns the `yyyyMMddTHHmmssZ` stamp to name the new generation with.
   */
  private rotationStamp(at: Date): string {
    const wanted = utcStamp(at)
    let newest = ''
    for (const name of readdirSync(this.dir)) {
      if (!isRotatedEventFileName(name)) continue
      const stamp = stampOfRotatedName(name)
      if (stamp > newest) newest = stamp
    }
    return wanted > newest ? wanted : newest
  }

  /** Rename the live file out of the way and drop the generations over the cap. */
  private rotate(file: string, at: Date): void {
    // Windows refuses a rename onto an existing target, so the suffix is probed
    // free rather than assumed; two rotations inside one second is the only way
    // to collide, and the probe costs one `existsSync`.
    const stamp = this.rotationStamp(at)
    let index = 1
    while (index < 100 && existsSync(path.join(this.dir, rotatedNameFromStamp(stamp, index)))) index += 1
    renameSync(file, path.join(this.dir, rotatedNameFromStamp(stamp, index)))
    this.prune()
  }

  /**
   * Keep the newest {@link EVENT_LOG_KEEP_ROTATIONS} generations. Only names
   * {@link isRotatedEventFileName} accepts are candidates, so nothing else in
   * the log directory can be removed from here.
   *
   * Each removal stands alone. A DIRECTORY carrying a generation's name makes
   * `rmSync` fail with `ERR_FS_EISDIR`, and one such failure used to abandon the
   * rest of the pass and, with it, the append that follows: the rotation has
   * already renamed the live file away by the time this runs, so the event being
   * written was lost as well. A name this module owns but cannot remove is left
   * where it is — the next rotation tries again.
   */
  private prune(): void {
    const generations = readdirSync(this.dir).filter(isRotatedEventFileName).sort()
    for (const name of generations.slice(0, Math.max(0, generations.length - EVENT_LOG_KEEP_ROTATIONS))) {
      try {
        rmSync(path.join(this.dir, name), { force: true })
      } catch {
        // Left in place; a later rotation tries again.
      }
    }
  }
}

/** The process-wide sink, installed once by the shell's boot path. */
let sink: EventLog | null = null

/**
 * Install the process-wide sink. The shell calls this at module load
 * (`index.ts`), before any code that emits an event can run.
 *
 * @param options - where the family lives, and what to do on a write failure.
 * @returns the sink, for a caller that wants its path or its sequence.
 */
export function configureEventLog(options: EventLogOptions): EventLog {
  sink = new EventLog(options)
  return sink
}

/**
 * Record one event on the process-wide sink. A no-op before
 * {@link configureEventLog} has run: every call site is a function of the shell
 * or of a module the shell drives, and the shell configures the sink before it
 * runs any of them.
 *
 * @param event - stable event name.
 * @param options - optional duration and detail fields.
 */
export function logEvent(event: string, options: { ms?: number; detail?: Record<string, unknown> } = {}): void {
  sink?.log(event, options)
}

/**
 * A class name (`TypeError`, `AbortError`): the only shape a derived `how` may
 * take besides `typeof` of a value that is not an Error.
 */
const ERROR_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/

/** A Node/undici error code (`ENOENT`, `UND_ERR_SOCKET`): the shape of a derived `code`. */
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,39}$/

/**
 * The `detail` of a failure whose Error the shell did NOT author. `app.boot.failed`
 * is the one such event: whatever escapes `boot()` is an arbitrary library's
 * rejection, and its message is exactly where a registry URL carrying userinfo,
 * a whole command line or a `C:\Users\<name>\…` path rides out — into the file a
 * user is asked to send. `hostStartFailureDetail` records the host's death this
 * way for the same reason.
 *
 * What is recorded instead: `how` — the error's own class name, or the `typeof`
 * of a value that is not an Error — and `code`, when it carries an
 * identifier-shaped one. Both are checked against a shape no path, command or
 * credential can have, so a hostile `name` or `code` cannot smuggle text through
 * the derived fields either. Nothing is lost: the message goes to the local
 * `dsh-kernel.log` and to the failure card, which is where the user reads it.
 *
 * WHERE the boot failed is answered by the milestone events already in this
 * file — `app.boot.begin`, `window.created`, `host.start.begin` / `ready` — so
 * no phase counter is threaded through `boot()` for it.
 *
 * @param error - whatever was thrown (`app.boot.failed`'s rejection).
 * @param context - the shell's own facts about the failure, merged in beside the derived ones.
 * @returns the `detail` object, safe to record.
 */
export function errorFactsDetail(
  error: unknown,
  context: Record<string, EventDetailValue> = {},
): Record<string, EventDetailValue> {
  const name = error instanceof Error ? error.name : typeof error
  const code = error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  return {
    ...context,
    how: ERROR_NAME_RE.test(name) ? name : error instanceof Error ? 'Error' : typeof error,
    code: typeof code === 'string' && ERROR_CODE_RE.test(code) ? code : null,
  }
}

/**
 * Run one operation and record it as a bracketed event triple: `<name>.begin`
 * (no `ms`), then `<name>.end` with the elapsed time, or `<name>.failed` with
 * the elapsed time and the error's message. The caller's return value and
 * thrown error pass through unchanged — this measures and records, it never
 * changes an outcome or an order — and `detail` is repeated on all three
 * lines so an end can be read without its begin.
 *
 * @param name - base event name (`kernel.install`).
 * @param detail - the facts that identify the operation.
 * @param run - the operation itself.
 * @returns whatever `run` resolves to.
 */
export async function trackedEventOperation<T>(
  name: string,
  detail: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T> {
  const started = Date.now()
  logEvent(`${name}.begin`, { detail })
  try {
    const result = await run()
    logEvent(`${name}.end`, { ms: Date.now() - started, detail })
    return result
  } catch (error) {
    logEvent(`${name}.failed`, {
      ms: Date.now() - started,
      detail: { ...detail, error: error instanceof Error ? error.message : String(error) },
    })
    throw error
  }
}
