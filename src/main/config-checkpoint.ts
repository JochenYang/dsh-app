/**
 * Configuration checkpoints: the last configurations this install booted
 * successfully, and the file-by-file way back to one of them.
 *
 * The failure this exists for: the app boots from four configuration files — the
 * booted profile's `package.json`, its `cordis.patch.yml`, its `pnpm-lock.yaml`
 * and the machine-level `$DSH_HOME/cordis.patch.yml` — and a user who edits one
 * of them into a shape the plugin tree cannot load gets a window that never
 * opens. Every recovery surface the shell then has boots the SAME files again
 * (retry, kernel rollback, reinstalling the kernel), and safe mode skips only
 * the suite overlay, not the user's own rows. There was no way back to the
 * configuration that worked ten minutes ago.
 *
 * So: after every healthy start the four files are copied into
 * `<userData>/dsh-app-config-checkpoints/<generation>/`, the newest few
 * generations are kept, and — when the user explicitly asks for it — one
 * generation is put back, with every file it replaces backed up first.
 *
 * Nothing here runs on its own. There is no startup-time repair, no automatic
 * restore, and no write outside `captureConfigCheckpoint` (a copy of the files
 * that are already on disk) and `restoreConfigCheckpoint` (a user-initiated
 * replace). The two entry points that call the latter are `index.ts`'s failure
 * card and its tray row.
 *
 * Layout — all of it under `<userData>`, never in `$DSH_HOME` and never in the
 * profile, so the checkpoint cannot become part of the configuration it
 * describes:
 *
 *   <userData>/dsh-app-config-checkpoints/
 *     checkpoint-20261013T093102Z-01/
 *       manifest.json                 what this generation holds, and its digests
 *       profile/package.json
 *       profile/cordis.patch.yml
 *       profile/pnpm-lock.yaml
 *       home/cordis.patch.yml
 *
 * A generation is a DIRECTORY rather than four files sharing a name stamp: its
 * manifest is written LAST, so a capture interrupted halfway leaves a directory
 * with no manifest — which reads as "not a checkpoint" instead of as a
 * checkpoint holding a torn file. The generation name is a UTC stamp
 * (`checkpoint-<yyyyMMdd>T<HHmmss>Z-<nn>`, the shape `event-log.ts` uses for its
 * rotations), so name order IS age order, which is the only order retention and
 * the restore path act on. Absolute paths are deliberately absent from the
 * manifest: targets are recomputed from the caller's own profile and home at
 * restore time, which is also what lets a checkpoint survive the home being
 * moved.
 *
 * Bounds. Measured on this machine's own profile (2026-10-13):
 * `package.json` 1.2 KB, `cordis.patch.yml` 46 KB, `pnpm-lock.yaml` 13 KB,
 * `$DSH_HOME/cordis.patch.yml` 2.9 KB — 63 KB for all four, i.e. ~30× under the
 * per-generation cap. An installation a hundred times heavier still fits, and a
 * pathological one is refused LOUDLY rather than captured in part:
 *
 *   - {@link CHECKPOINT_MAX_FILE_BYTES} (1 MB) per stored copy;
 *   - {@link CHECKPOINT_MAX_TOTAL_BYTES} (2 MB) per generation — a capture that
 *     would exceed either cap writes NOTHING (status `oversized`), because
 *     storing three of four files would make "restore" mean "restore what
 *     happened to fit", and the manifest's completeness check is exactly what
 *     lets the restore path refuse a generation it cannot trust;
 *   - {@link CHECKPOINT_KEEP_GENERATIONS} (3) generations, so the whole family is
 *     bounded by {@link CHECKPOINT_FAMILY_MAX_BYTES} (6 MB) — an arithmetic
 *     ceiling, derived rather than configured, exactly like the event log's.
 *
 * What a restore is and is not:
 *
 *   - the checkpoint is DATA. Bytes are copied and put back verbatim; nothing in
 *     it is executed, parsed as instructions, or read for a path. The target
 *     paths come from the caller's profile and home, never from the manifest;
 *   - it never DELETES a configuration file. A slot the checkpoint recorded as
 *     absent (the home layer is absent on most machines) is left exactly as it is
 *     on disk, so a restore cannot take away a file the user has now;
 *   - it never touches `node_modules`, the rest of the install state, sessions,
 *     logs, `.env`, or anything else. The lockfile goes back with the other three
 *     files, and the NEXT boot's existing `profile-heal` step reconciles the
 *     installed tree against what the profile now declares (see
 *     `profile-heal.ts`): that step runs the profile's own package manager when a
 *     declared dependency is not installed, which is precisely the state a
 *     rolled-back lockfile leaves behind. This module deliberately does not run a
 *     package manager, and does not delete `node_modules` to force one;
 *   - a failure part-way leaves the files already replaced in place, each with
 *     its backup beside it (see {@link restoreConfigCheckpoint}). Rolling the
 *     whole set back would be a second state machine over files that each have a
 *     copy to go back to.
 *
 * @module dsh-app/main/config-checkpoint
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { PROFILE_PATCH_FILENAME, writePatchAtomically } from './brand-suite'
import { removeWithoutLinks } from './suite-profile'

/**
 * Directory under `<userData>` holding the generations. Sits beside `kernel/`
 * and `dsh-app-office/`, and is never swept by anything else the shell does.
 */
export const CHECKPOINT_DIR_NAME = 'dsh-app-config-checkpoints'

/** The manifest inside one generation. Its presence is what makes one valid. */
export const CHECKPOINT_MANIFEST_FILE = 'manifest.json'

/** Manifest schema version; a different one reads as "not a checkpoint". */
export const CHECKPOINT_SCHEMA_VERSION = 1

/** Largest single stored copy. */
export const CHECKPOINT_MAX_FILE_BYTES = 1_000_000

/** Largest generation, counting every stored copy it holds. */
export const CHECKPOINT_MAX_TOTAL_BYTES = 2_000_000

/** Generations kept; every older one is removed right after a capture. */
export const CHECKPOINT_KEEP_GENERATIONS = 3

/**
 * Ceiling for the whole family: `CHECKPOINT_MAX_TOTAL_BYTES *
 * CHECKPOINT_KEEP_GENERATIONS` = 6 MB. Derived, so the two numbers cannot drift.
 */
export const CHECKPOINT_FAMILY_MAX_BYTES = CHECKPOINT_MAX_TOTAL_BYTES * CHECKPOINT_KEEP_GENERATIONS

/** The four files one checkpoint holds. */
export type CheckpointSlotId = 'profile-package' | 'profile-patch' | 'profile-lockfile' | 'home-patch'

/**
 * One slot: where its copy lives inside a generation, and which file under the
 * caller's profile/home it mirrors. The order here is the order every report
 * uses.
 */
interface SlotSpec {
  readonly id: CheckpointSlotId
  /** Path inside the generation directory. */
  readonly stored: string
  /** `profile` or `home` — the two target roots. */
  readonly where: 'profile' | 'home'
  /** File name under that root. */
  readonly name: string
}

const SLOTS: readonly SlotSpec[] = [
  { id: 'profile-package', stored: 'profile/package.json', where: 'profile', name: 'package.json' },
  { id: 'profile-patch', stored: `profile/${PROFILE_PATCH_FILENAME}`, where: 'profile', name: PROFILE_PATCH_FILENAME },
  // The lockfile goes back with the manifest: the two are one statement about
  // what the profile declares, and a profile whose declaration and lockfile
  // disagree is a state `pnpm install` has to resolve either way.
  { id: 'profile-lockfile', stored: 'profile/pnpm-lock.yaml', where: 'profile', name: 'pnpm-lock.yaml' },
  { id: 'home-patch', stored: `home/${PROFILE_PATCH_FILENAME}`, where: 'home', name: PROFILE_PATCH_FILENAME },
]

/** Generation directory names: `checkpoint-<yyyyMMdd>T<HHmmss>Z-<nn>`. */
const GENERATION_RE = /^checkpoint-\d{8}T\d{6}Z-\d{2}$/

/** One generation's name from a moment and a 1-based index in that second. */
export function generationName(at: Date, index: number): string {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return `checkpoint-${stamp}-${String(index).padStart(2, '0')}`
}

/** Whether a directory entry is a generation this module owns. */
export function isGenerationName(name: string): boolean {
  return GENERATION_RE.test(name)
}

/**
 * Where a checkpoint is read from and written to.
 *
 * Three directories, all supplied by the caller: this module resolves nothing
 * itself (`userData` is Electron's, `dshHome` follows `$DSH_HOME`), which is also
 * what makes every path in it testable against scratch roots.
 */
export interface ConfigCheckpointScope {
  /** The shell's `<userData>`. The checkpoints live here. */
  readonly userDataDir: string
  /** The profile the app actually booted (`ensureSuiteProfile().dir`). */
  readonly profileDir: string
  /** `$DSH_HOME`; the home layer's patch file sits directly in it. */
  readonly dshHome: string
}

/** What one capture or restore may be given beyond the scope. */
export interface ConfigCheckpointOptions extends ConfigCheckpointScope {
  /** Clock, injected so a test can pin a generation name. */
  readonly now?: () => Date
  /**
   * English diagnostic sink (`index.ts` writes one `dsh-kernel.log` line).
   * Never user-visible: the failure the user reads is localized at the call site.
   */
  readonly log?: (line: string) => void
}

/** The four live paths a scope names, in {@link SLOTS} order. */
export function slotTargets(scope: ConfigCheckpointScope): Readonly<Record<CheckpointSlotId, string>> {
  const root = (where: SlotSpec['where']): string => (where === 'profile' ? scope.profileDir : scope.dshHome)
  const targets = {} as Record<CheckpointSlotId, string>
  for (const slot of SLOTS) targets[slot.id] = path.join(root(slot.where), slot.name)
  return targets
}

/** `<userData>/dsh-app-config-checkpoints`. */
export function checkpointRoot(userDataDir: string): string {
  return path.join(userDataDir, CHECKPOINT_DIR_NAME)
}

/** What one {@link captureConfigCheckpoint} did. */
export interface CaptureOutcome {
  /**
   * `written` — a new generation holds all four slots; `empty` — every slot is
   * absent, so there was nothing worth keeping; `oversized` — a cap refused the
   * capture and nothing was written; `failed` — an I/O or state problem, see
   * `detail`. All four are non-fatal by contract: a healthy start is never
   * broken by this step.
   */
  readonly status: 'written' | 'empty' | 'oversized' | 'failed'
  /** The generation just written, for `written`. */
  readonly generation?: string
  /** Slots that were captured (present on disk), for `written`. */
  readonly slots?: number
  /** Total bytes stored, for `written`. */
  readonly bytes?: number
  /** Stable, path-free diagnostic, for `failed` / `oversized`. */
  readonly detail?: string
}

/** A slot's state on disk, as the capture and the restore both need it. */
type DiskState =
  | { readonly kind: 'regular'; readonly bytes: Buffer }
  | { readonly kind: 'absent' }
  /**
   * Present, but not a plain file — a symlink, a directory, a device. Never
   * read through and never written to: a config file living behind a link is a
   * state this module does not understand, and guessing would put the write
   * wherever the link points.
   */
  | { readonly kind: 'other' }

/** Whether an error is "the path is not there" (every other code is real). */
function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** A stable, path-free error code for a log line. */
function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === 'string' && code !== '' ? code : 'unknown'
}

/** `lstat` plus contents, with `absent` and `other` told apart from a real file. */
async function inspectPath(target: string): Promise<DiskState> {
  let stats
  try {
    stats = await fs.lstat(target)
  } catch (error) {
    if (isEnoent(error)) return { kind: 'absent' }
    throw error
  }
  // `lstat`, so a symlink is a LINK here and never the file it points at.
  if (!stats.isFile()) return { kind: 'other' }
  return { kind: 'regular', bytes: await fs.readFile(target) }
}

/** SHA-256 of a stored copy, lower-case hex. */
export function digestOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** One slot's record in a manifest. */
interface SlotRecord {
  readonly present: boolean
  readonly bytes?: number
  readonly sha256?: string
}

/** A generation's manifest, as validated. */
export interface CheckpointManifest {
  readonly version: number
  readonly createdAt: string
  readonly files: Readonly<Record<CheckpointSlotId, SlotRecord>>
}

/**
 * Generation names present in the root, oldest first (name order = age order).
 * A missing root and any unreadable entry answer "none" rather than throwing:
 * this runs on the boot path.
 *
 * Only names {@link isGenerationName} accepts are returned, so retention can
 * never delete a directory this module did not create — the same rule
 * `event-log.ts` applies to its generations.
 */
async function listGenerations(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    return entries.filter((entry) => isGenerationName(entry.name)).map((entry) => entry.name).sort()
  } catch (error) {
    if (isEnoent(error)) return []
    throw error
  }
}

/**
 * The name for a capture at `at`: `<stamp>-01`, or the next free index within
 * that second. Null when all 99 are taken, which a caller reports as a failure
 * rather than reusing a name (reusing one would overwrite a checkpoint).
 */
function nextGenerationName(at: Date, existing: readonly string[]): string | null {
  const taken = new Set(existing)
  for (let index = 1; index <= 99; index += 1) {
    const name = generationName(at, index)
    if (!taken.has(name)) return name
  }
  return null
}

/**
 * Capture the configuration the app just booted successfully.
 *
 * Reads the four targets, copies them verbatim into a new generation, writes the
 * manifest last, then removes every generation past
 * {@link CHECKPOINT_KEEP_GENERATIONS}. Never throws and never fails a boot: every
 * problem is reported through the returned outcome and the `log` sink.
 *
 * @param options - the scope (three directories), an optional clock and log.
 * @returns what happened, for the caller's log line.
 */
export async function captureConfigCheckpoint(options: ConfigCheckpointOptions): Promise<CaptureOutcome> {
  const log = options.log ?? (() => undefined)
  const now = options.now ?? ((): Date => new Date())
  const root = checkpointRoot(options.userDataDir)
  const targets = slotTargets(options)
  let dir: string | null = null
  let written: { name: string; slots: number; bytes: number } | null = null
  try {
    const states = new Map<CheckpointSlotId, DiskState>()
    for (const slot of SLOTS) {
      const state = await inspectPath(targets[slot.id])
      if (state.kind === 'other') {
        // Fail closed rather than recording "absent": a restore must not write
        // through a link it did not resolve, and a half-recorded configuration
        // is exactly what the manifest's completeness check exists to refuse.
        log(`[config-checkpoint] no checkpoint captured: ${slot.id} is not a plain file`)
        return { status: 'failed', detail: `not-a-regular-file (${slot.id})` }
      }
      states.set(slot.id, state)
    }
    const present = SLOTS.filter((slot) => states.get(slot.id)?.kind === 'regular')
    if (present.length === 0) {
      log('[config-checkpoint] no checkpoint captured: none of the four configuration files exists yet')
      return { status: 'empty' }
    }
    let total = 0
    for (const slot of present) {
      const state = states.get(slot.id)
      const bytes = state?.kind === 'regular' ? state.bytes.length : 0
      if (bytes > CHECKPOINT_MAX_FILE_BYTES) {
        log(`[config-checkpoint] no checkpoint captured: ${slot.id} is ${String(bytes)} bytes, over the ${String(CHECKPOINT_MAX_FILE_BYTES)}-byte per-file cap`)
        return { status: 'oversized', detail: `file-over-cap (${slot.id})` }
      }
      total += bytes
    }
    if (total > CHECKPOINT_MAX_TOTAL_BYTES) {
      log(`[config-checkpoint] no checkpoint captured: ${String(total)} bytes together, over the ${String(CHECKPOINT_MAX_TOTAL_BYTES)}-byte per-checkpoint cap`)
      return { status: 'oversized', detail: 'checkpoint-over-cap' }
    }

    const name = nextGenerationName(now(), await listGenerations(root))
    if (name === null) {
      log('[config-checkpoint] no checkpoint captured: this second already holds 99 generations')
      return { status: 'failed', detail: 'generation-names-exhausted' }
    }
    dir = path.join(root, name)
    await fs.mkdir(path.join(dir, 'profile'), { recursive: true })
    await fs.mkdir(path.join(dir, 'home'), { recursive: true })
    const files = {} as Record<CheckpointSlotId, SlotRecord>
    for (const slot of SLOTS) {
      const state = states.get(slot.id)
      if (state?.kind !== 'regular') {
        files[slot.id] = { present: false }
        continue
      }
      await fs.writeFile(path.join(dir, slot.stored), state.bytes)
      files[slot.id] = { present: true, bytes: state.bytes.length, sha256: digestOf(state.bytes) }
    }
    // LAST: a directory without a manifest is not a checkpoint (see the module
    // note). The dump is written through a sibling temp file for the same reason
    // every other shell record is.
    await writePatchAtomically(
      path.join(dir, CHECKPOINT_MANIFEST_FILE),
      `${JSON.stringify({ version: CHECKPOINT_SCHEMA_VERSION, createdAt: now().toISOString(), files }, undefined, 2)}\n`,
    )
    log(`[config-checkpoint] captured ${name}: ${String(present.length)} file(s), ${String(total)} bytes`)
    written = { name, slots: present.length, bytes: total }
  } catch (error) {
    if (dir !== null) await removeWithoutLinks(dir).catch(() => undefined)
    log(`[config-checkpoint] no checkpoint captured: ${errorCode(error)}`)
    return { status: 'failed', detail: `io-error (${errorCode(error)})` }
  }
  await pruneGenerations(root, log)
  return written === null
    ? { status: 'failed', detail: 'nothing-written' }
    : { status: 'written', generation: written.name, slots: written.slots, bytes: written.bytes }
}

/**
 * Remove every generation past the newest {@link CHECKPOINT_KEEP_GENERATIONS}.
 *
 * Best effort in full: a removal that fails is logged and left for the next
 * capture, because a full disk is not a reason to fail a healthy start. The
 * removal goes through the shell's link-safe walker (`removeWithoutLinks`), the
 * same one every other shell-side tree delete uses — a junction planted inside a
 * generation must be unlinked, never walked through.
 */
async function pruneGenerations(root: string, log: (line: string) => void): Promise<void> {
  let names: string[]
  try {
    names = await listGenerations(root)
  } catch (error) {
    log(`[config-checkpoint] retention pass skipped: ${errorCode(error)}`)
    return
  }
  for (const name of names.slice(0, Math.max(0, names.length - CHECKPOINT_KEEP_GENERATIONS))) {
    try {
      await removeWithoutLinks(path.join(root, name))
    } catch (error) {
      log(`[config-checkpoint] could not remove the generation ${name}: ${errorCode(error)}`)
    }
  }
}

/** A manifest field that must be a plain object (never an array, never null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse and validate a manifest. Every field the restore path relies on is
 * checked here, so a generation that cannot be trusted reads as "not a
 * checkpoint" instead of as a checkpoint with a hole in it.
 *
 * @param text - the manifest's content.
 * @returns the manifest, or a path-free reason it is unusable.
 */
export function parseManifest(text: string): { ok: true; manifest: CheckpointManifest } | { ok: false; reason: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'manifest-unreadable' }
  }
  if (!isRecord(parsed)) return { ok: false, reason: 'manifest-unreadable' }
  if (parsed.version !== CHECKPOINT_SCHEMA_VERSION) return { ok: false, reason: 'manifest-version-unknown' }
  if (typeof parsed.createdAt !== 'string' || parsed.createdAt === '') return { ok: false, reason: 'manifest-created-at-missing' }
  if (!isRecord(parsed.files)) return { ok: false, reason: 'manifest-slots-missing' }
  const files = parsed.files
  // Exactly the four slots, by name: a missing one is an incomplete checkpoint,
  // and an unknown one is a manifest this version does not understand.
  const names = Object.keys(files).sort()
  const expected = SLOTS.map((slot) => slot.id).sort()
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    return { ok: false, reason: 'manifest-slots-mismatch' }
  }
  const records = {} as Record<CheckpointSlotId, SlotRecord>
  for (const slot of SLOTS) {
    const record = files[slot.id]
    if (!isRecord(record)) return { ok: false, reason: `manifest-slot-unreadable (${slot.id})` }
    if (record.present !== true) {
      records[slot.id] = { present: false }
      continue
    }
    const bytes = record.bytes
    const sha256 = record.sha256
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0) {
      return { ok: false, reason: `manifest-size-missing (${slot.id})` }
    }
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
      return { ok: false, reason: `manifest-digest-missing (${slot.id})` }
    }
    records[slot.id] = { present: true, bytes, sha256 }
  }
  return { ok: true, manifest: { version: CHECKPOINT_SCHEMA_VERSION, createdAt: parsed.createdAt, files: records } }
}

/** A generation that passed {@link verifyGeneration}. */
export interface VerifiedCheckpoint {
  readonly generation: string
  readonly dir: string
  readonly createdAt: string
  /** Slots the generation actually holds a copy of, in {@link SLOTS} order. */
  readonly present: readonly CheckpointSlotId[]
  /** Total bytes its copies occupy. */
  readonly bytes: number
}

/** What a lookup found, in the three states the shell's entry points act on. */
export type CheckpointLookup =
  | { readonly status: 'ok'; readonly checkpoint: VerifiedCheckpoint }
  | { readonly status: 'none' }
  | { readonly status: 'invalid'; readonly generation: string; readonly reason: string }

/**
 * Verify one generation against its manifest: the manifest parses to this
 * schema, and every copy it records is a plain file of the recorded length with
 * the recorded digest. That check is what protects the restore from a capture
 * that was cut short, a copy that was truncated by a full disk, or a hand-edited
 * manifest.
 *
 * @param root - the checkpoint root.
 * @param generation - the generation directory's name.
 * @returns the verified generation, or a path-free reason it is unusable.
 */
async function verifyGeneration(root: string, generation: string): Promise<{ ok: true; checkpoint: VerifiedCheckpoint } | { ok: false; reason: string }> {
  const dir = path.join(root, generation)
  let manifest: CheckpointManifest
  try {
    const parsed = parseManifest(await fs.readFile(path.join(dir, CHECKPOINT_MANIFEST_FILE), 'utf8'))
    if (!parsed.ok) return { ok: false, reason: parsed.reason }
    manifest = parsed.manifest
  } catch (error) {
    return { ok: false, reason: isEnoent(error) ? 'manifest-missing' : `manifest-io-error (${errorCode(error)})` }
  }
  const present: CheckpointSlotId[] = []
  let bytes = 0
  for (const slot of SLOTS) {
    const record = manifest.files[slot.id]
    if (!record.present) continue
    const stored = path.join(dir, slot.stored)
    let state: DiskState
    try {
      state = await inspectPath(stored)
    } catch (error) {
      return { ok: false, reason: `copy-io-error (${slot.id}, ${errorCode(error)})` }
    }
    if (state.kind === 'absent') return { ok: false, reason: `copy-missing (${slot.id})` }
    if (state.kind === 'other') return { ok: false, reason: `copy-not-a-regular-file (${slot.id})` }
    if (state.bytes.length !== record.bytes) return { ok: false, reason: `copy-size-mismatch (${slot.id})` }
    if (digestOf(state.bytes) !== record.sha256) return { ok: false, reason: `copy-digest-mismatch (${slot.id})` }
    present.push(slot.id)
    bytes += state.bytes.length
  }
  if (present.length === 0) return { ok: false, reason: 'no-file-captured' }
  return { ok: true, checkpoint: { generation, dir, createdAt: manifest.createdAt, present, bytes } }
}

/**
 * The newest generation, verified. ONLY the newest one is ever considered: if it
 * does not verify, the lookup answers `invalid` instead of reaching further back,
 * so "restore the last working configuration" always names the same thing the
 * failure card offered. Reaching back would silently restore a configuration the
 * user never saw named, and a damaged newest checkpoint is a fact worth
 * reporting rather than working around. (The older generations are still there;
 * they are simply not what this entry point means.)
 *
 * @param scope - the three directories.
 * @returns `ok`, `none`, or `invalid` naming the generation and a path-free reason.
 */
export async function findRestorableCheckpoint(scope: ConfigCheckpointScope): Promise<CheckpointLookup> {
  const root = checkpointRoot(scope.userDataDir)
  let names: string[]
  try {
    names = await listGenerations(root)
  } catch {
    return { status: 'none' }
  }
  const newest = names.at(-1)
  if (newest === undefined) return { status: 'none' }
  const verified = await verifyGeneration(root, newest)
  if (!verified.ok) return { status: 'invalid', generation: newest, reason: verified.reason }
  return { status: 'ok', checkpoint: verified.checkpoint }
}

/**
 * Whether a restore could be performed right now. What the failure card asks
 * before it offers its button, so a machine with no checkpoint never shows an
 * action whose only outcome is a sentence.
 */
export async function hasRestorableConfigCheckpoint(scope: ConfigCheckpointScope): Promise<boolean> {
  return (await findRestorableCheckpoint(scope)).status === 'ok'
}

/** What happened to one slot during a restore. */
export interface RestoreAction {
  readonly slot: CheckpointSlotId
  /**
   * `replaced` — the target was there and is now the checkpoint's copy (with a
   * backup beside it); `created` — the target was absent and the copy was
   * written; `kept` — the checkpoint recorded no copy, so the file on disk was
   * left exactly as it is.
   */
  readonly action: 'replaced' | 'created' | 'kept'
  /** The backup's path, for `replaced`. */
  readonly backup?: string
}

/**
 * The restore's result. A tagged union rather than one shape with optional
 * fields, because the caller's next move depends on which one it is: only
 * `restored` reruns the app, and the other three exist to produce a sentence.
 */
export type RestoreOutcome =
  | {
    readonly status: 'restored'
    readonly generation: string
    readonly createdAt: string
    readonly actions: readonly RestoreAction[]
    /** Backups written, in slot order. */
    readonly backups: readonly string[]
    /**
     * Always true, and a literal so it cannot be ignored: the four files are read
     * when the host starts, so the app must RELAUNCH (`app.relaunch()` +
     * `app.quit()`, the path safe mode already takes) — reloading the window
     * would leave the running host on the configuration it composed, and the
     * shell has no in-place "recompose the profile" path.
     */
    readonly restartRequired: true
  }
  | { readonly status: 'none'; readonly restartRequired: false }
  | { readonly status: 'invalid'; readonly generation: string; readonly reason: string; readonly restartRequired: false }
  | { readonly status: 'failed'; readonly detail: string; readonly restartRequired: false }

/** Backup suffix: local time, the shape this repo's own backups already use. */
function backupStamp(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(at.getFullYear())}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
}

/**
 * A backup path beside a target that is free. `.bak-before-restore-<stamp>`
 * matches the shape `home-layer-rows.ts` writes for the same reason (a user
 * recognises it in their folder), and the `-2`, `-3` … suffix keeps a second
 * restore in the same second from overwriting the first one's backup.
 *
 * @param target - the file about to be replaced.
 * @param at - the moment of the restore.
 * @returns a path that does not exist yet.
 */
export async function freeBackupPath(target: string, at: Date): Promise<string> {
  const base = `${target}.bak-before-restore-${backupStamp(at)}`
  for (let index = 1; ; index += 1) {
    const candidate = index === 1 ? base : `${base}-${String(index)}`
    try {
      await fs.lstat(candidate)
    } catch (error) {
      if (isEnoent(error)) return candidate
      throw error
    }
  }
}

/**
 * Put a verified checkpoint back, after backing up everything it replaces.
 *
 * Order is deliberate: every target and every stored copy is checked BEFORE the
 * first write, so a refusal (a target that is a link, a copy that vanished between
 * the verification and here) leaves the whole configuration untouched. Once the
 * writes start, a failure part-way leaves the files already replaced in place,
 * each with its backup; `detail` names the error code and the app is not
 * restarted, so the next boot fails the same way and the user can retry.
 *
 * @param options - the scope, an optional clock and log.
 * @returns what was put back, or what stopped it.
 */
export async function restoreConfigCheckpoint(options: ConfigCheckpointOptions): Promise<RestoreOutcome> {
  const log = options.log ?? (() => undefined)
  const now = options.now ?? ((): Date => new Date())
  const lookup = await findRestorableCheckpoint(options)
  if (lookup.status === 'none') {
    log('[config-checkpoint] restore refused: no checkpoint to restore')
    return { status: 'none', restartRequired: false }
  }
  if (lookup.status === 'invalid') {
    log(`[config-checkpoint] restore refused: ${lookup.generation} does not verify (${lookup.reason})`)
    return { status: 'invalid', generation: lookup.generation, reason: lookup.reason, restartRequired: false }
  }
  const checkpoint = lookup.checkpoint
  const targets = slotTargets(options)
  const at = now()
  try {
    // Pre-flight: the targets the restore would write, and the copies it would
    // write from. Any refusal here costs nothing, because no write has happened.
    const plans: { slot: CheckpointSlotId; target: string; plan: 'replace' | 'create'; bytes: Buffer; backup?: string }[] = []
    for (const slot of SLOTS) {
      const target = targets[slot.id]
      if (!checkpoint.present.includes(slot.id)) continue
      const bytes = await fs.readFile(path.join(checkpoint.dir, slot.stored))
      const state = await inspectPath(target)
      if (state.kind === 'other') {
        log(`[config-checkpoint] restore refused: ${slot.id} is not a plain file, so it is never written through`)
        return { status: 'failed', detail: `target-not-a-regular-file (${slot.id})`, restartRequired: false }
      }
      if (state.kind === 'regular') plans.push({ slot: slot.id, target, plan: 'replace', bytes, backup: await freeBackupPath(target, at) })
      else plans.push({ slot: slot.id, target, plan: 'create', bytes })
    }
  const actions: RestoreAction[] = []
    const backups: string[] = []
    for (const plan of plans) {
      // The write order inside one slot is: backup first, then replace. A crash
      // between the two leaves the target intact AND a backup of it.
      if (plan.plan === 'replace' && plan.backup !== undefined) {
        await fs.copyFile(plan.target, plan.backup)
        backups.push(plan.backup)
      }
      await fs.mkdir(path.dirname(plan.target), { recursive: true })
      await writePatchAtomically(plan.target, plan.bytes)
      actions.push({ slot: plan.slot, action: plan.plan === 'replace' ? 'replaced' : 'created', backup: plan.backup })
    }
    // Slot order, whether a slot was written or left alone: the caller's report
    // reads in the same order as the slot list.
    const writtenBySlot = new Map(actions.map((action) => [action.slot, action]))
    const ordered = SLOTS.map((slot): RestoreAction => writtenBySlot.get(slot.id) ?? { slot: slot.id, action: 'kept' })
    log(`[config-checkpoint] restored ${checkpoint.generation}: ${String(actions.length)} file(s) written, ${String(backups.length)} backup(s); the app must relaunch`)
    return { status: 'restored', generation: checkpoint.generation, createdAt: checkpoint.createdAt, actions: ordered, backups, restartRequired: true }
  } catch (error) {
    log(`[config-checkpoint] restore failed: ${errorCode(error)}`)
    return { status: 'failed', detail: `io-error (${errorCode(error)})`, restartRequired: false }
  }
}

/**
 * Whether a start that just completed should be captured.
 *
 * The judgement, stated once and testable: a start is HEALTHY when the host
 * answered `ready` AND the window was handed the live UI — the two facts the
 * shell's own `host.start.ready` / `window.ready` milestones record. Anything
 * less (the host came up but the UI never loaded) is not a configuration worth
 * calling known-good.
 *
 * Two further refusals: safe mode, because a diagnostic run is by definition a
 * run whose configuration is suspect, and capturing it would let a broken
 * configuration become the thing a later restore puts back; and a second capture
 * in one process, because the checkpoint describes a START, and the shell's
 * later re-entries into the start path (tray restart, proxy watchdog, kernel
 * rollback) are not new configurations.
 *
 * What this cannot see: the shell has no client-side first-paint signal, so a
 * page that loads and then throws before painting still counts as handed over.
 * Adding one would mean changing the event stream, which this work item is
 * explicitly not allowed to do.
 */
export function shouldCaptureCheckpoint(health: {
  /** The host child answered `ready` (`DshServer.start` resolved). */
  readonly hostReady: boolean
  /** The window is showing the live UI (`window.ready`). */
  readonly uiShown: boolean
  /** This run booted in safe mode (`safe-mode.ts`). */
  readonly safeMode: boolean
  /** A checkpoint was already captured in this process. */
  readonly alreadyCaptured: boolean
}): boolean {
  return health.hostReady && health.uiShown && !health.safeMode && !health.alreadyCaptured
}
