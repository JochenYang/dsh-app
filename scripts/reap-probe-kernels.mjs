/**
 * Kill the `dsh web` kernels that outlived the probe that booted them.
 *
 * ## The leak this closes
 *
 * Every Electron probe takes its own kernel down from a `finally`, and every
 * probe already handles `SIGINT`/`SIGTERM`. One case is left over, and it is the
 * one that actually happens: a probe stopped by a tool timeout, a closed
 * terminal, `taskkill /F` or a timeboxed runner ends through `TerminateProcess`,
 * which runs NO handler at all. The kernel child has no parent left to kill it
 * and keeps a full core and hundreds of MB. Measured on this machine: a batch of
 * interrupted probe runs left six kernels alive, the oldest with 1,986 s of CPU
 * time at ~350 MB each — the fan was the first symptom.
 *
 * ## Two passes, in this order
 *
 * 1. **The registry** — the probes record their kernel's pids so the NEXT probe
 *    start can reap what the last one leaked (see
 *    {@link REGISTRY} for why that file is read here rather than through the
 *    module that owns it). Entries whose probe is gone have their recorded pids
 *    killed and are dropped.
 * 2. **A sweep of the process table**, which is the case that actually happened:
 *    a kernel leaked before it could be registered, or by a probe older than the
 *    registry. The discriminator is the COMMAND LINE, not the age alone:
 *
 *    - a probe always boots its kernel with `--no-open`; `scripts/dev.mjs` runs
 *      `npm start`, and the shell's own child is `--expose-internals <entry> …`
 *      — neither carries the flag, so a developer's kernel can never match;
 *    - the shape is `node … dsh/lib/bin.js … --no-open` (the probes spawn the
 *      CLI directly) or the `pnpm … dsh web … --no-open` wrapper that spawned
 *      one (`probe-settings-nav.cjs` uses `shell: true`);
 *    - and the process must be older than the threshold (15 minutes by
 *      default), so a probe running right now is never touched.
 *
 * The reaper itself, and every ancestor of it, is refused in both passes: a
 * registry entry carrying the invoking shell's pid killed its own caller before
 * that guard existed (see {@link ownAncestry}).
 *
 * `--dry-run` prints the same decisions and changes nothing. Exit status is 0
 * whenever the reaper did its job, including when there was nothing to reap.
 *
 * Platform: the sweep is written for Windows, where this repository's probes are
 * run. Elsewhere it reads the same table through `ps` and kills pids directly
 * instead of `taskkill /T`; `ps -o etimes=` is what supplies the age there, so a
 * platform whose `ps` lacks it reports that it could not enumerate rather than
 * guessing.
 *
 * @module scripts/reap-probe-kernels
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The repository root, one level above `scripts/`. */
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * The registry file `scripts/lib/probe-kernel-registry.mjs` writes: an array of
 * `{ probe, pids }`, the probe's own pid and every pid of the kernel tree it
 * spawned, in the repository's gitignored `scratch/`.
 *
 * That module is the writer (`trackKernel`) and its own next-run reaper
 * (`reapStaleKernels`), and it is NOT imported here on purpose. On `main` it
 * does not exist — it ships on the creative-workbench branches — so an import
 * would make this script fail on the branch it is meant to protect; and where it
 * does exist it has no dry-run mode, so half of this script's contract (report
 * without touching) could not go through it. The reader and writer below are
 * therefore a minimal duplicate of that module's `read`/`write` pair, keyed to
 * the same shape. If it lands on `main`, replace {@link reapRegistry}'s kill loop
 * with `reapStaleKernels()`.
 */
const REGISTRY = path.join(ROOT, 'scratch', '.probe-kernels.json')

/** The age a match must exceed before it is treated as leaked, in minutes. */
const DEFAULT_STALE_MINUTES = 15

/** How much of a command line a report line shows. */
const MAX_CMDLINE_CHARS = 160

/** Below this pid nothing is ever touched — Windows' idle/system entries. */
const MIN_KILLABLE_PID = 5

/**
 * Whether a pid names a live process.
 *
 * `kill(pid, 0)` asks without signalling. A pid the kernel has recycled reads as
 * alive; for the registry's probe pid that is the safe direction (keep), and the
 * sweep re-reads the command line anyway.
 *
 * @param {number} pid - the pid to test.
 * @returns {boolean} true while that process exists.
 */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Split a command line into arguments, honouring double quotes.
 *
 * `Win32_Process.CommandLine` is the raw line, so a path with a space arrives
 * quoted; splitting it on whitespace would turn one argument into three and, in
 * the case this guards against, invent a `web` token out of `…\dsh web notes.md`.
 * A `\"` sequence is an escaped quote (what `shell: true` produces inside the
 * blob it hands `cmd.exe`), not a delimiter.
 *
 * @param {string} text - the command line.
 * @returns {string[]} the arguments, quotes stripped.
 */
export function splitCommandLine(text) {
  const out = []
  let current = ''
  let started = false
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\\' && text[index + 1] === '"') {
      current += '"'
      started = true
      index += 1
      continue
    }
    if (char === '"') {
      quoted = !quoted
      started = true
      continue
    }
    if (!quoted && /\s/u.test(char)) {
      if (started) out.push(current)
      current = ''
      started = false
      continue
    }
    current += char
    started = true
  }
  if (started) out.push(current)
  return out
}

/**
 * The two views of a command line the decision tests.
 *
 * `own` is the argument vector of the process itself. `blobs` holds every
 * argument that still contains whitespace, split again: a `shell: true` spawn
 * hands `cmd.exe` the whole command as ONE quoted argument, so
 * `cmd.exe /d /s /c "pnpm dsh web … --no-open"` hides its wrapper until that
 * blob is read as a command line of its own.
 *
 * The two views are kept apart on purpose. A blob belongs to a PARENT shell, and
 * a parent shell's `-c` string repeats the child's whole command line: measured,
 * `bash -c "cd … && node …/dsh/lib/bin.js … --no-open"` matched the CLI-entry
 * rule through its blob, so a real run would have killed the shell that launched
 * the probe. Only the wrapper rule is safe to read out of a blob.
 *
 * @param {string | readonly string[]} argv - a command line or an already-split argv.
 * @returns {{ own: readonly string[], blobs: readonly (readonly string[])[] }} the views.
 */
function commandLineViews(argv) {
  const own = Array.isArray(argv) ? argv.map((part) => String(part)) : splitCommandLine(String(argv))
  const blobs = own.filter((token) => /\s/u.test(token)).map(splitCommandLine)
  return { own, blobs }
}

/**
 * One token in the form the matchers compare: quotes dropped, separators
 * normalised, lowercased.
 * @param {string} token - one argument.
 * @returns {string} its comparable form.
 */
function normalized(token) {
  return token.replace(/"/gu, '').replace(/\\/gu, '/').toLowerCase()
}

/**
 * Whether a token names the dsh CLI's entry file (`…/dsh/lib/bin.js`), which is
 * how both `probe-workbench.cjs` and `probe-chrome-surfaces.cjs` spawn a kernel.
 * @param {string} token - one argument.
 * @returns {boolean} true for the CLI entry.
 */
function isDshEntry(token) {
  return normalized(token).endsWith('dsh/lib/bin.js')
}

/**
 * Whether a token names the package manager, in any of the forms a `shell: true`
 * spawn produces (`pnpm`, `pnpm.cmd`, `pnpm.cjs`).
 * @param {string} token - one argument.
 * @returns {boolean} true for a pnpm executable.
 */
function isPnpm(token) {
  const base = normalized(token).split('/').pop() ?? ''
  return /^pnpm(?:\.[a-z]+)?$/u.test(base)
}

/**
 * Whether any token is `dsh` immediately followed by `web`.
 * @param {readonly string[]} tokens - one token stream.
 * @returns {boolean} true for the `dsh web` subcommand.
 */
function hasDshWeb(tokens) {
  return tokens.some((token, index) => {
    const base = normalized(token).split('/').pop() ?? ''
    return base === 'dsh' && normalized(tokens[index + 1] ?? '') === 'web'
  })
}

/**
 * Whether a token is exactly `--no-open`.
 *
 * This is the whole safety margin: no other way of starting this app's kernel
 * passes it. `npm run dev` → `npm start` → the shell spawns
 * `--expose-internals <entry> …`, and the probes' own spawns all append it.
 *
 * @param {readonly string[]} tokens - one token stream.
 * @returns {boolean} true when the flag is present.
 */
function hasNoOpen(tokens) {
  return tokens.some((token) => normalized(token) === '--no-open')
}

/**
 * Whether a process is a probe's kernel that has outlived its probe.
 *
 * Kept pure so the decision can be tested without spawning anything: every fact
 * it needs is an argument.
 *
 * @param {string | readonly string[]} argv - the process's command line (or an
 *   already-split argv).
 * @param {number} createdMs - when the process started, epoch milliseconds.
 * @param {number} now - the current time, epoch milliseconds.
 * @param {number} staleMs - the age a match must reach before it is reaped.
 * @returns {boolean} true when this process should be killed.
 */
export function isProbeKernel(argv, createdMs, now, staleMs) {
  // A probe that is still running keeps its kernel: a young match is left alone
  // whatever its shape. `Number.isFinite` keeps a `NaN` age on the safe side.
  const age = now - createdMs
  if (!Number.isFinite(age) || age < staleMs) return false
  const { own, blobs } = commandLineViews(argv)
  if (hasNoOpen(own)) {
    // The kernel itself: `node … dsh/lib/bin.js … --no-open`, which is how
    // probe-workbench and probe-chrome-surfaces spawn it.
    if (own.some(isDshEntry)) return true
    // The wrapper is matched too, because `taskkill /T` on it takes the kernel
    // with it and it is the process a shell-spawned probe leaves holding the
    // tree together.
    if (own.some(isPnpm) && hasDshWeb(own)) return true
  }
  // The same wrapper seen through a `shell: true` spawn's single quoted argument.
  // Only the wrapper rule applies here: see {@link commandLineViews} for the
  // parent shell a broader rule would kill.
  for (const tokens of blobs) {
    if (hasNoOpen(tokens) && tokens.some(isPnpm) && hasDshWeb(tokens)) return true
  }
  return false
}

/**
 * Every process on this machine, with what the decision needs about it.
 *
 * @typedef {object} ProcessRow
 * @property {number} pid - the process id.
 * @property {number} ppid - its parent's id.
 * @property {number} createdMs - start time, epoch milliseconds (0 when unknown).
 * @property {number} workingSet - resident bytes, for the report.
 * @property {string} cmd - the raw command line.
 */

/**
 * The process table on Windows, one CIM query.
 *
 * `Win32_Process` is the only way to read another process's command line here,
 * and `scripts/lib/probe-kernel-registry.mjs` already relies on it for the same
 * reason. The epoch conversion happens in PowerShell rather than here because
 * `ConvertTo-Json` does not round-trip a `DateTime` predictably across versions.
 *
 * @returns {ProcessRow[]} the table, command lines unparsed.
 */
function processTableWindows() {
  const script = [
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
    'Get-CimInstance Win32_Process | ForEach-Object {',
    '  [pscustomobject]@{',
    '    pid = [int]$_.ProcessId',
    '    ppid = [int]$_.ParentProcessId',
    '    createdMs = $(if ($null -eq $_.CreationDate) { 0 } else { [long]([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() })',
    '    workingSet = [long]$_.WorkingSetSize',
    '    cmd = [string]$_.CommandLine',
    '  }',
    '} | ConvertTo-Json -Compress -Depth 3',
  ].join('\n')
  const stdout = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  const text = stdout.trim()
  if (text === '') return []
  const parsed = JSON.parse(text)
  return [].concat(parsed).flatMap((row) => {
    if (typeof row?.pid !== 'number' || typeof row?.ppid !== 'number') return []
    return [{
      pid: row.pid,
      ppid: row.ppid,
      createdMs: typeof row.createdMs === 'number' ? row.createdMs : 0,
      workingSet: typeof row.workingSet === 'number' ? row.workingSet : 0,
      cmd: typeof row.cmd === 'string' ? row.cmd : '',
    }]
  })
}

/**
 * The process table elsewhere, one `ps` call.
 *
 * `etimes` is elapsed seconds, which is the age this script needs without
 * parsing a locale-dependent date; `rss` is in KB on both Linux and macOS. A `ps`
 * without `etimes` fails the call, and the caller reports that instead of
 * treating an empty table as "nothing to reap".
 *
 * @returns {ProcessRow[]} the table, command lines unparsed.
 */
function processTablePosix() {
  const stdout = execFileSync('ps', ['-Ao', 'pid=,ppid=,etimes=,rss=,command='], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  const now = Date.now()
  return stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u.exec(line)
    if (match === null) return []
    const [, pid, ppid, etimes, rss, cmd] = match
    return [{
      pid: Number(pid),
      ppid: Number(ppid),
      createdMs: now - Number(etimes) * 1_000,
      workingSet: Number(rss) * 1_024,
      cmd,
    }]
  })
}

/**
 * The process table for this platform.
 * @returns {ProcessRow[]} every process, command lines unparsed.
 */
function processTable() {
  return process.platform === 'win32' ? processTableWindows() : processTablePosix()
}

/**
 * Kill one process tree.
 *
 * Windows: `/T` takes the descendants with it, which is what a kernel needs —
 * it starts its own children. Elsewhere the caller kills the pids it enumerated
 * instead, so this is the root only.
 *
 * @param {number} pid - the tree's root.
 */
function killTree(pid) {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      // Already gone, or a child that raced it: nothing left to do.
    }
    return
  }
  try {
    process.kill(pid)
  } catch {
    // Already gone.
  }
}

/**
 * This process and every ancestor of it — pids a reaper must never kill.
 *
 * The registry recorded a pid the writer had already stopped tracking, or a
 * hand-written entry paired the wrong pids with a dead probe, and the kill loop
 * took down the shell that invoked the reaper: measured, a registry entry
 * carrying the invoking shell's pid killed its own caller mid-run and left the
 * real leftovers alive, with exit status 1 and no report. The ancestry is read
 * from the same table the sweep uses, so the guard costs one walk.
 *
 * @param {ReadonlyMap<number, ProcessRow>} byPid - rows by pid.
 * @returns {ReadonlySet<number>} the pids to refuse.
 */
function ownAncestry(byPid) {
  const guard = new Set([process.pid])
  const seen = new Set()
  let parent = byPid.get(process.pid)?.ppid
  while (parent !== undefined && parent >= MIN_KILLABLE_PID && !seen.has(parent)) {
    guard.add(parent)
    seen.add(parent)
    parent = byPid.get(parent)?.ppid
  }
  return guard
}

/**
 * Read the registry, tolerating an absent or hand-edited file.
 * @returns {{ entries: { probe: number, pids: number[] }[], corrupt: boolean }} the recorded trees.
 */
function readRegistry() {  if (!existsSync(REGISTRY)) return { entries: [], corrupt: false }
  try {
    const parsed = JSON.parse(readFileSync(REGISTRY, 'utf8'))
    if (!Array.isArray(parsed)) return { entries: [], corrupt: true }
    const entries = parsed.flatMap((entry) => {
      const probe = entry?.probe
      const pids = Array.isArray(entry?.pids) ? entry.pids.filter((pid) => typeof pid === 'number') : []
      return typeof probe === 'number' && pids.length > 0 ? [{ probe, pids }] : []
    })
    return { entries, corrupt: false }
  } catch {
    return { entries: [], corrupt: true }
  }
}

/**
 * Write the registry back.
 * @param {{ probe: number, pids: number[] }[]} entries - the trees to keep.
 */
function writeRegistry(entries) {
  writeFileSync(REGISTRY, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
}

/**
 * Summarise a byte count the way the report line reads.
 * @param {number} bytes - the amount.
 * @returns {string} e.g. `0 B`, `812.4 MB`, `1.2 GB`.
 */
function humanBytes(bytes) {
  if (bytes < 1024) return `${String(bytes)} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

/**
 * Shorten a command line for a report line.
 * @param {string} cmd - the raw command line.
 * @returns {string} at most {@link MAX_CMDLINE_CHARS} characters.
 */
function brief(cmd) {
  const text = cmd.replace(/\s+/gu, ' ').trim()
  return text.length <= MAX_CMDLINE_CHARS ? text : `${text.slice(0, MAX_CMDLINE_CHARS - 1)}…`
}

/**
 * Pass 1: reap the registry.
 *
 * A dead probe's entry is always dropped, whether or not its pids were still
 * alive — that is the module's own rule, and a kept entry would be re-examined
 * on every future run.
 *
 * @param {object} options - the pass's inputs.
 * @param {boolean} options.dryRun - report only.
 * @param {ReadonlyMap<number, ProcessRow>} options.byPid - resident bytes per pid.
 * @returns {{ killed: number[], trees: number, bytes: number }} what was (or would be) reaped.
 */
function reapRegistry({ dryRun, byPid }) {
  const { entries, corrupt } = readRegistry()
  if (corrupt) {
    console.log(`registry: ${registryLabel()} is not a registry file — ignored`)
    return { killed: [], trees: 0, bytes: 0 }
  }
  if (!existsSync(REGISTRY)) {
    console.log(`registry: no ${registryLabel()} — no probe has recorded a kernel here`)
    return { killed: [], trees: 0, bytes: 0 }
  }
  const kept = []
  const reaped = []
  const refused = []
  const guarded = ownAncestry(byPid)
  for (const entry of entries) {
    if (alive(entry.probe)) {
      kept.push(entry)
      continue
    }
    for (const pid of entry.pids) {
      if (pid >= MIN_KILLABLE_PID && guarded.has(pid)) refused.push(pid)
    }
    const live = entry.pids.filter((pid) => pid >= MIN_KILLABLE_PID && !guarded.has(pid) && alive(pid))
    reaped.push({ probe: entry.probe, live })
  }
  const killed = reaped.flatMap((entry) => entry.live)
  const bytes = killed.reduce((sum, pid) => sum + (byPid.get(pid)?.workingSet ?? 0), 0)
  const trees = reaped.filter((entry) => entry.live.length > 0).length
  console.log(`registry: ${String(entries.length)} entr${entries.length === 1 ? 'y' : 'ies'}, `
    + `${String(kept.length)} live probe${kept.length === 1 ? '' : 's'} kept, `
    + `${String(trees)} dead tree${trees === 1 ? '' : 's'}`)
  if (refused.length > 0) {
    console.log(`  refused ${refused.join(', ')}: this reaper's own process or an ancestor of it`)
  }
  if (dryRun) {
    for (const entry of reaped) {
      if (entry.live.length === 0) continue
      console.log(`  would kill ${entry.live.join(', ')} (probe ${String(entry.probe)} is gone)`)
    }
    return { killed, trees, bytes }
  }
  for (const entry of reaped) {
    // Deepest first: a child killed before its parent cannot be re-parented into
    // a tree the next `taskkill /T` would miss.
    for (const pid of [...entry.live].reverse()) killTree(pid)
  }
  if (reaped.length > 0) writeRegistry(kept)
  return { killed, trees, bytes }
}

/**
 * Index every row by its parent, so a subtree can be walked.
 * @param {readonly ProcessRow[]} table - the process table.
 * @returns {Map<number, ProcessRow[]>} children per parent pid.
 */
function childrenIndex(table) {
  const index = new Map()
  for (const row of table) {
    const list = index.get(row.ppid)
    if (list === undefined) index.set(row.ppid, [row])
    else list.push(row)
  }
  return index
}

/**
 * Every descendant of a pid, parents before their own children.
 * @param {number} pid - the subtree's root.
 * @param {ReadonlyMap<number, ProcessRow[]>} index - the children index.
 * @returns {ProcessRow[]} the descendants, root excluded.
 */
function descendantsOf(pid, index) {
  const out = []
  const seen = new Set([pid])
  const queue = [pid]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const child of index.get(current) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      out.push(child)
      queue.push(child.pid)
    }
  }
  return out
}

/**
 * Whether one of a process's ancestors is also a match.
 *
 * A matched `cmd.exe → pnpm → kernel` chain is one leak: reaping the wrapper's
 * tree already takes the kernel, so the kernel must not be counted (or killed)
 * a second time.
 *
 * @param {ProcessRow} row - the candidate.
 * @param {ReadonlySet<number>} matches - every matched pid.
 * @param {ReadonlyMap<number, ProcessRow>} byPid - rows by pid.
 * @returns {boolean} true when an ancestor is matched too.
 */
function hasMatchedAncestor(row, matches, byPid) {
  const seen = new Set()
  let parent = byPid.get(row.pid)?.ppid
  while (parent !== undefined && parent >= MIN_KILLABLE_PID && !seen.has(parent)) {
    if (matches.has(parent)) return true
    seen.add(parent)
    parent = byPid.get(parent)?.ppid
  }
  return false
}

/**
 * Pass 2: sweep the process table for kernels no registry knew about.
 *
 * @param {object} options - the pass's inputs.
 * @param {boolean} options.dryRun - report only.
 * @param {readonly ProcessRow[]} options.table - the process table.
 * @param {ReadonlyMap<number, ProcessRow>} options.byPid - rows by pid.
 * @param {ReadonlySet<number>} options.alreadyClaimed - pids pass 1 already took.
 * @param {number} options.staleMs - the age a match must reach.
 * @param {number} options.now - the current time, epoch milliseconds.
 * @returns {{ killed: number[], trees: number, bytes: number }} what was (or would be) reaped.
 */
function sweepKernels({ dryRun, table, byPid, alreadyClaimed, staleMs, now }) {
  const guarded = ownAncestry(byPid)
  const candidates = table.filter((row) => row.pid >= MIN_KILLABLE_PID
    && !guarded.has(row.pid)
    && row.cmd !== ''
    && row.createdMs > 0
    && isProbeKernel(row.cmd, 0, now, 0))
  const matches = candidates.filter((row) => isProbeKernel(row.cmd, row.createdMs, now, staleMs))
  const matchSet = new Set(matches.map((row) => row.pid))
  for (const row of candidates) {
    if (matchSet.has(row.pid)) continue
    console.log(`  kept pid ${String(row.pid)} (${String(Math.floor((now - row.createdMs) / 60_000))} min old, `
      + `under the ${String(staleMs / 60_000)}-minute threshold): ${brief(row.cmd)}`)
  }
  const index = childrenIndex(table)
  const claimed = new Set(alreadyClaimed)
  const roots = matches.filter((row) => !hasMatchedAncestor(row, matchSet, byPid))
  const killed = []
  let trees = 0
  for (const root of roots) {
    if (claimed.has(root.pid)) continue
    const rows = [root, ...descendantsOf(root.pid, index)]
    const claimedRows = rows.filter((row) => !claimed.has(row.pid))
    if (claimedRows.length === 0) continue
    for (const row of claimedRows) claimed.add(row.pid)
    killed.push(...claimedRows.map((row) => row.pid))
    trees += 1
    if (dryRun) continue
    if (process.platform === 'win32') {
      killTree(root.pid)
    } else {
      // Deepest first, so no child is orphaned into a tree nothing will sweep.
      for (const row of [...claimedRows].reverse()) killTree(row.pid)
    }
  }
  const bytes = killed.reduce((sum, pid) => sum + (byPid.get(pid)?.workingSet ?? 0), 0)
  console.log(`sweep: ${String(table.length)} processes, ${String(candidates.length)} probe-shaped, `
    + `${String(trees)} to reap`)
  return { killed, trees, bytes }
}

/**
 * The command line's flags.
 * @param {readonly string[]} argv - `process.argv.slice(2)`.
 * @returns {{ dryRun: boolean, staleMinutes: number, help: boolean }} the options.
 */
export function parseArgs(argv) {
  const options = { dryRun: false, staleMinutes: DEFAULT_STALE_MINUTES, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    let raw
    if (arg === '--stale') {
      raw = argv[index + 1]
      index += 1
    } else if (arg.startsWith('--stale=')) {
      raw = arg.slice('--stale='.length)
    } else {
      throw new Error(`unknown argument: ${arg} (try --help)`)
    }
    const minutes = Number(raw)
    if (raw === undefined || raw === '' || !Number.isFinite(minutes) || minutes < 0) {
      throw new Error('--stale takes a non-negative number of minutes, e.g. --stale 15')
    }
    options.staleMinutes = minutes
  }
  return options
}

/**
 * The registry path as the reports and the help spell it.
 * @returns {string} a posix-separated path relative to the repository root.
 */
function registryLabel() {
  return path.relative(ROOT, REGISTRY).split(path.sep).join('/')
}

/** Printed by `--help`. */
const HELP = `reap-probe-kernels — kill the \`dsh web\` kernels that outlived their probe

usage: node scripts/reap-probe-kernels.mjs [--dry-run] [--stale <minutes>] [--help]

Pass 1  the registry the probes write (${registryLabel()}): every
        entry whose probe process is gone has its recorded kernel pids killed,
        and the entry is dropped.
Pass 2  a sweep of the process table for kernels no registry knew about.

A process is a probe kernel only when ALL of these hold:
  * its command line carries \`--no-open\` — every probe passes it, and a
    developer's \`npm run dev\` kernel never does (dev.mjs runs \`npm start\`, and
    the shell spawns \`--expose-internals <entry> …\`), so a dev kernel cannot match;
  * it is \`node … dsh/lib/bin.js …\` or the \`pnpm … dsh web …\` wrapper that
    spawned one;
  * it started longer ago than \`--stale\` (${String(DEFAULT_STALE_MINUTES)} minutes by default).

Safe to run at any time: nothing else is touched, and a probe that is running
right now keeps its kernel.
`

/**
 * Run the two passes and print the summary line.
 */
function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`reap-probe-kernels: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
    return
  }
  if (options.help) {
    console.log(HELP)
    return
  }
  const staleMs = options.staleMinutes * 60_000
  let table
  try {
    table = processTable()
  } catch (error) {
    const detail = error instanceof Error ? error.message.split(/\r?\n/u)[0] : String(error)
    console.error(`reap-probe-kernels: cannot read the process table — ${detail}`)
    process.exitCode = 1
    return
  }
  const now = Date.now()
  let byPid = new Map(table.map((row) => [row.pid, row]))

  const registry = reapRegistry({ dryRun: options.dryRun, byPid })
  // The registry's kernels are `--no-open` kernels too, so the sweep would find
  // them again. A dry run keeps them claimed (one leak must not count twice); a
  // real run re-reads the table, where they are simply gone.
  let claimed = new Set(registry.killed)
  if (registry.trees > 0 && !options.dryRun) {
    try {
      table = processTable()
      byPid = new Map(table.map((row) => [row.pid, row]))
      claimed = new Set()
    } catch {
      // The kills already happened; a stale table only risks a second attempt
      // on pids that are gone, which `taskkill` and `kill` both absorb.
    }
  }

  const sweep = sweepKernels({ dryRun: options.dryRun, table, byPid, alreadyClaimed: claimed, staleMs, now })
  const killed = [...registry.killed, ...sweep.killed]
  const trees = registry.trees + sweep.trees
  const bytes = registry.bytes + sweep.bytes
  if (killed.length === 0) {
    console.log(options.dryRun ? 'dry run: nothing to reap' : 'nothing to reap')
    return
  }
  const count = `${String(killed.length)} process${killed.length === 1 ? '' : 'es'} in ${String(trees)} kernel tree${trees === 1 ? '' : 's'}`
  console.log(options.dryRun
    ? `dry run: would kill ${count}, freeing ${humanBytes(bytes)}`
    : `killed ${count}, freed ${humanBytes(bytes)}`)
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
