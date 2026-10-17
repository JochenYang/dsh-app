/**
 * Kernel-child registry for the Electron probes (`probe-settings-nav.cjs`,
 * `probe-workbench.cjs`).
 *
 * ## Why this exists on top of the process hooks
 *
 * Each probe already takes its `dsh web` child down from its own `finally`,
 * from `process.on('exit')` and from `SIGINT`/`SIGTERM` (see either probe). One
 * case is left over, and it is the one that actually happened: a probe stopped
 * by `taskkill /F`, a closed terminal or a timeboxed runner ends through
 * `TerminateProcess`, which runs NO handler at all — no signal, no `exit` hook,
 * nothing. Measured on this machine: `taskkill /F` on a running
 * `probe-settings-nav.cjs` left two kernel processes alive (411 MB together),
 * and a round of interrupted runs left four (171–397 MB each) for the operator
 * to kill by hand.
 *
 * So the cleanup also happens on the NEXT run: each probe records the process
 * ids of its kernel's whole tree, and reaps the entries whose PROBE is gone
 * before it boots its own.
 *
 * ## Why it records a SET, refreshed, rather than one pid
 *
 * The obvious version — record `spawn()`'s `child.pid`, kill that tree — does
 * not work, and it was measured: with `shell: true` the child is `cmd.exe`, and
 * after a hard kill of the probe the `cmd.exe` can be GONE while the kernel it
 * started is still running (seen: recorded pid 39484 absent, its child 34048
 * alive at 171 MB). A dead recorded root is unrecoverable — the surviving
 * process cannot be found from it. So the entry holds every pid in the tree,
 * re-read on an interval while the probe runs, and the reaper kills each
 * recorded pid that is still alive. The interval is short enough that the last
 * snapshot predates any kill that matters, and `unref`ed so it never holds a
 * probe open.
 *
 * The entry carries the PROBE's pid too, so a live probe's kernel is never
 * touched — two probes may run side by side.
 *
 * The file lives under `scratch/`, which is gitignored and already the probes'
 * own scratch area.
 *
 * @module scripts/lib/probe-kernel-registry
 */

import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The registry file, inside the repository's gitignored `scratch/`. */
const REGISTRY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scratch', '.probe-kernels.json')

/**
 * How often a tracked tree is re-snapshotted, in ms.
 *
 * Each walk is a PowerShell process (~1.2s here), so the cadence is adaptive
 * rather than flat. A tree only GROWS during the kernel's own boot — by the
 * time it has settled it is `cmd → pnpm → kernel` and nothing new appears — so
 * the walk runs fast while that is happening and slowly afterwards. A flat 8s
 * was measured to be too slow for a probe killed a few seconds in: the record
 * still held only the shell, the shell was gone by the time of the reap, and
 * the kernel survived.
 */
const REFRESH_FAST_MS = 2_000
/** The slower cadence once the tree has settled. */
const REFRESH_SLOW_MS = 12_000
/** How long the fast cadence lasts, in ms — comfortably longer than a boot. */
const REFRESH_FAST_WINDOW_MS = 25_000

/**
 * Whether a pid is still a live process.
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
 * Read the registry, tolerating an absent or hand-edited file.
 * @returns {readonly {probe: number, pids: readonly number[]}[]} the recorded trees.
 */
function read() {
  if (!existsSync(REGISTRY)) return []
  try {
    const parsed = JSON.parse(readFileSync(REGISTRY, 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry) => {
      const probe = entry?.probe
      const pids = Array.isArray(entry?.pids) ? entry.pids.filter((pid) => typeof pid === 'number') : []
      return typeof probe === 'number' && pids.length > 0 ? [{ probe, pids }] : []
    })
  } catch {
    return []
  }
}

/**
 * Write the registry back.
 * @param {readonly {probe: number, pids: readonly number[]}[]} entries - the trees to keep.
 */
function write(entries) {
  writeFileSync(REGISTRY, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
}

/** This probe's registry key: its own pid. */
const PROBE = process.pid

/**
 * Replace this probe's entry, or drop it when `pids` is empty.
 * @param {readonly number[]} pids - the tree to record.
 */
function put(pids) {
  const others = read().filter((entry) => entry.probe !== PROBE)
  write(pids.length === 0 ? others : [...others, { probe: PROBE, pids }])
}

/**
 * Every process id in the tree rooted at `rootPid`, root included.
 *
 * One PowerShell walk, because Windows has no cheaper way to ask "who are this
 * process's descendants". A tree that has already lost its root (the case the
 * module header describes) yields just what is left of it, which is why the
 * caller refreshes rather than snapshotting once.
 *
 * ASYNC on purpose: the walk takes ~1.5s, and a synchronous spawn here would
 * block the probe's event loop for that long on every refresh — the probes are
 * built on bounded waits and polls that a stalled loop would distort.
 *
 * @param {number} rootPid - the tree's root.
 * @returns {Promise<readonly number[]>} the pids, live at the moment of the walk.
 */
function descendants(rootPid) {
  const script = [
    // `[int]` casts are load-bearing: `Get-CimInstance` yields UInt32 properties,
    // and an ArrayList of Int32 does NOT match a UInt32 through `Contains`
    // (Int32.Equals boxes by type). Without the casts the walk returns the root
    // alone and never descends — measured.
    `$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId`,
    `$out = New-Object System.Collections.ArrayList`,
    `[void]$out.Add([int]${rootPid})`,
    `$changed = $true`,
    `while ($changed) {`,
    `  $changed = $false`,
    `  foreach ($p in $all) {`,
    `    if ($out.Contains([int]$p.ParentProcessId) -and -not $out.Contains([int]$p.ProcessId)) { [void]$out.Add([int]$p.ProcessId); $changed = $true }`,
    `  }`,
    `}`,
    `$out | ConvertTo-Json -Compress`,
  ].join('\n')
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20_000 }, (error, stdout) => {
      if (error !== null && error !== undefined && !stdout) {
        resolve(alive(rootPid) ? [rootPid] : [])
        return
      }
      try {
        const out = String(stdout ?? '').trim()
        resolve(out === '' ? [] : [].concat(JSON.parse(out)).filter((pid) => typeof pid === 'number'))
      } catch {
        resolve(alive(rootPid) ? [rootPid] : [])
      }
    })
  })
}

/**
 * Take down one process tree, the same way the probes do.
 * @param {number} pid - the tree's root pid.
 */
function killTree(pid) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    else process.kill(pid)
  } catch { /* already gone */ }
}

/**
 * Kill every recorded kernel tree whose probe is no longer running, and drop
 * those entries. Entries belonging to a LIVE probe are kept and left running.
 * @returns {number} how many kernel trees were taken down.
 */
export function reapStaleKernels() {
  const kept = []
  let reaped = 0
  for (const entry of read()) {
    if (alive(entry.probe)) {
      kept.push(entry)
      continue
    }
    const stillAlive = entry.pids.filter(alive)
    if (stillAlive.length > 0) {
      // Deepest first: a child killed before its parent cannot be re-parented
      // into a tree the next `taskkill /T` would miss.
      for (const pid of stillAlive.reverse()) killTree(pid)
      reaped += 1
    }
  }
  write(kept)
  return reaped
}

/**
 * Record a kernel child's whole tree, and keep the record current until the
 * returned disposer runs.
 *
 * @param {number} rootPid - the spawned child's pid (the shell, under `shell: true`).
 * @returns {() => void} a disposer clearing the interval and the entry; call it
 *   from the probe's own teardown so a kernel already taken down is not reaped
 *   again by the next run.
 */
export function trackKernel(rootPid) {
  let walking = false
  let stopped = false
  let timer = null
  const started = Date.now()
  const schedule = () => {
    if (stopped) return
    const fast = Date.now() - started < REFRESH_FAST_WINDOW_MS
    timer = setInterval(() => { void refresh() }, fast ? REFRESH_FAST_MS : REFRESH_SLOW_MS)
    // Never hold the probe open.
    timer.unref?.()
  }
  const refresh = async () => {
    if (walking || stopped) return
    walking = true
    try {
      const pids = await descendants(rootPid)
      if (stopped) return
      // A walk that found nothing means the tree is gone; keep the last record
      // rather than erasing it, so a probe that is already dead still leaves the
      // reaper something to work with.
      if (pids.length > 0) put(pids)
    } finally {
      walking = false
      // Re-arm at the cadence this moment deserves: the fast window can expire
      // while a walk is in flight, and a single long-lived interval would keep
      // the old cadence for ever.
      if (!stopped) {
        clearInterval(timer)
        schedule()
      }
    }
  }
  void refresh()
  schedule()
  return () => {
    stopped = true
    clearInterval(timer)
    put([])
  }
}
