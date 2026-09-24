// Guard for the one recursive-delete shape that has already cost us a tree.
//
// Measured on this machine (scratch/rm-junction-semantics.mjs reproduces it):
// `fs.rmSync(dir, { recursive: true })` FOLLOWS a directory junction — deleting a
// throwaway DSH_HOME whose profiles/*/node_modules held junctions into a runtime
// tree emptied that runtime's own package directories. The hazard belongs to the
// runtime the app actually ships: Electron 44.4.1 / Node 24.21 empties the target,
// the machine's own Node 24.18.0 does not, and the ASYNC `fs.rm` does not on
// either — which is why the shell's own deletes (src/main/suite-profile.ts,
// src/kernel/manager.ts) use the async form and why scripts that clean a scratch
// HOME go through scripts/lib/remove-tree.mjs.
//
// Two things are asserted here:
//   1. every sync recursive delete in the tree is on the audited list below, with
//      a reason — a new call anywhere in src/, scripts/, test/ or plugins/ turns
//      this red until someone reviews it (the plugins hold none: each deletes
//      through its own copy of the walker, `plugins/*/src/remove-tree.ts`);
//   2. the walker that replaces it really does not follow a link, and the test can
//      tell the difference (the contrast below empties a linked tree on purpose).
//
// Known blind spot: occurrences inside comments are not calls and are not counted,
// so a comment may quote the sync form freely (this file does).
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { readdir, rmdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { removeTree } from '../scripts/lib/remove-tree.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

// ------------------------------------------------------------------ 1. audit

/** Directories a scan must not enter: dependencies and build output, never source. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', '.test-dist', 'release', 'scratch',
  'runtime-dist', 'runtime-layers', 'bundled-kernel', 'repo', 'logs', '__pycache__',
])
const SCAN_ROOTS = ['src', 'scripts', 'test', 'plugins']
const SOURCE_EXT = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.js'])
const CALL = /\b(rmSync|rmdirSync)\s*\(/g

/**
 * The audited list. `match` is a path glob (relative to the repo root, `/`
 * separated): an exact path, or a glob when a whole class of files shares one
 * reason. The FIRST entry that matches a file claims it, so an exact entry above
 * a glob carves that file out. `count` is the number of call occurrences in the
 * files an entry claims — a new call in a claimed file breaks the count, and a
 * count without a claim is reported as a stale entry.
 */
const AUDIT = [
  // ── shell + tooling, reviewed call by call ────────────────────────────────
  {
    match: 'src/main/log-file.ts',
    count: 1,
    why: 'kernel log rotation: unlinks the single file `<dsh-kernel.log>.1` in the app log dir, never a tree',
  },
  {
    match: 'scripts/smoke-suite.mjs',
    count: 1,
    why: 'the mkdtemp dir this probe unpacked a runtime tgz into: a tree the probe made, with no link pointing out of it. The scratch HOME — which DOES hold @dsh-app junctions into that runtime — goes through remove-tree.mjs instead (the extraction root is removed in the same finally, after the kernel child is gone)',
  },
  {
    match: 'scripts/diagnose-modelscope-upload.mjs',
    count: 1,
    why: 'the mkdtemp dir holding the drill body files, created by the drill itself',
  },
  {
    match: 'scripts/probe-launch-folder.mjs',
    count: 1,
    why: 'the mkdtemp out dir for one esbuild bundle of a probe module',
  },
  {
    match: 'scripts/publish-modelscope.mjs',
    count: 2,
    why: 'one downloaded asset file (not recursive), and the mkdtemp download dir',
  },
  // ── plugin tooling: build output only ────────────────────────────────────
  {
    match: 'plugins/plugin-doc/scripts/test.mjs',
    count: 1,
    why: "wipes the plugin's own `.test-dist` before esbuild writes it",
  },
  {
    match: 'plugins/plugin-pdf/scripts/test.mjs',
    count: 1,
    why: "wipes the plugin's own `.test-dist` before esbuild writes it",
  },
  {
    match: 'plugins/plugin-ppt/scripts/test.mjs',
    count: 1,
    why: "wipes the plugin's own `.test-dist` before esbuild writes it",
  },
  {
    match: 'plugins/plugin-sheet/scripts/test.mjs',
    count: 1,
    why: "wipes the plugin's own `.test-dist` before esbuild writes it",
  },
  {
    match: 'plugins/plugin-ppt/scripts/preview-scenes.mjs',
    count: 1,
    why: 'one generated scene file, not recursive',
  },
  // ── plugin source: no sync delete left ───────────────────────────────────
  // Every delete in a plugin's own source goes through that plugin's private
  // walker copy (`plugins/<plugin>/src/remove-tree.ts`, a copy of the shape
  // below): it unlinks a link and otherwise deletes asynchronously, so the
  // plugin needs no entry here at all.
  // ── suites ───────────────────────────────────────────────────────────────
  {
    match: 'test/recursive-delete-guard.test.mjs',
    count: 1,
    why: 'this file: the contrast below calls the sync form on purpose, on a structure built and thrown away inside the test (everything else here cleans up through the walker it is testing)',
  },
  {
    match: 'test/*.test.mjs',
    count: 27,
    why: 'root suites: every call removes an os.tmpdir scratch root that test just created (the mirror test also deletes a hardlink-only profile mirror on purpose, the kernel-manager suite removes one package out of a scratch runtime tree to prove `load()` refuses an incomplete one, the office-payload suite removes its mkdtemp userData/fixture roots at process exit, the activation-guard suite removes its mkdtemp bundle/userData roots plus the symlink-privilege probe dir, the graph suite removes the plugin skeleton it wrote, and the updater suites remove their mkdtemp download destinations) — no link out of any of them; the profile-repair suite cleans its scratch roots the same way, through one helper',
  },
  {
    match: 'plugins/*/tests/**',
    count: 98,
    why: 'plugin suites: every call removes an os.tmpdir scratch root or fixture home that test just created — no link points out of any of them (was 97: the two release-age file-level cleanups went away with the exclusion-list tests; back to 97 with the office_to_pdf e2e scratch home + workspace; 98 with the preset-migration suite, whose one call clears the mkdtemp roots its own fixtures built — it creates plain directories only, no symlink or junction)',
  },
]

/** Glob → RegExp: `*` stays inside one path segment, `**` crosses segments. */
function globToRegExp(glob) {
  const source = glob
    .split('/')
    .map((segment) => (segment === '**' ? '.*' : segment.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '[^/]*')))
    .join('/')
  return new RegExp(`^${source}$`)
}

/** Call occurrences in one file. A line that begins a comment is not a call. */
function countCalls(file) {
  let hits = 0
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '')
    if (/^\s*(?:\/\/|\*|\/\*|<!--)/.test(line)) continue
    hits += (line.match(CALL) ?? []).length
  }
  return hits
}

/** Every source file under the scan roots that calls a sync delete, with its count. */
function scan() {
  const found = new Map()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const relative = path.relative(ROOT, full).split(path.sep).join('/')
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        // A plugin's own build output is generated, not source.
        if (/^plugins\/[^/]+\/lib$/.test(relative)) continue
        walk(full)
        continue
      }
      if (!SOURCE_EXT.has(path.extname(entry.name))) continue
      const hits = countCalls(full)
      if (hits > 0) found.set(relative, hits)
    }
  }
  for (const root of SCAN_ROOTS) walk(path.join(ROOT, root))
  return found
}

test('every recursive sync delete in the tree is audited', () => {
  const found = new Map(scan())
  const claims = new Map(AUDIT.map((entry) => [entry, { files: [], count: 0 }]))
  const problems = []

  for (const [file, hits] of found) {
    const entry = AUDIT.find((candidate) => globToRegExp(candidate.match).test(file))
    if (entry === undefined) {
      problems.push(`${file} calls a sync recursive delete (${String(hits)}x) and is not on AUDIT.`
        + ' Review what it deletes: a tree that can hold a junction (a profile, a scratch home, a'
        + ' runtime tree) must go through scripts/lib/remove-tree.mjs instead; otherwise add an'
        + ' entry with the reason it is safe.')
      continue
    }
    const claim = claims.get(entry)
    claim.files.push(file)
    claim.count += hits
    found.delete(file)
  }

  // Every problem is reported, not just the first: an audit that stops at one
  // line makes whoever fixes it run the suite once per mistake.
  for (const [entry, claim] of claims) {
    if ((entry.why?.length ?? 0) === 0) problems.push(`AUDIT entry ${entry.match} carries no reason`)
    if (claim.files.length === 0) problems.push(`AUDIT entry ${entry.match} matched no file — stale entry, drop it`)
    else if (claim.count !== entry.count) {
      problems.push(`${entry.match} now holds ${String(claim.count)} sync delete call(s) in ${claim.files.join(', ')};`
        + ` AUDIT says ${String(entry.count)}. Re-review the reason before updating the count.`)
    }
  }
  assert.deepEqual(problems, [])
})

// ------------------------------------------------- 2. the walker's guarantee

/** A throwaway "home" linked into a separate "runtime" tree, in the shell's own shape. */
function buildHome(tag) {
  const root = mkdtempSync(path.join(os.tmpdir(), `dsh-rm-guard-${tag}-`))
  const runtime = path.join(root, 'runtime')
  const home = path.join(root, 'home')
  mkdirSync(path.join(runtime, 'plugin-x'), { recursive: true })
  writeFileSync(path.join(runtime, 'plugin-x', 'package.json'), '{"name":"plugin-x"}\n')
  writeFileSync(path.join(runtime, 'plugin-x', 'client.js'), 'export default 1\n')
  mkdirSync(path.join(home, 'profiles'), { recursive: true })
  writeFileSync(path.join(home, 'profiles', 'state.json'), '{}\n')
  // Both scopes brand-suite.ts writes (src/main/brand-suite.ts).
  const links = [
    path.join(home, 'profiles', 'dsh-app', 'node_modules', '@dsh-app', 'plugin-x'),
    path.join(home, 'profiles', 'node_modules', '@dsh-app', 'plugin-x'),
  ]
  const kind = process.platform === 'win32' ? 'junction' : 'dir'
  for (const link of links) {
    mkdirSync(path.dirname(link), { recursive: true })
    symlinkSync(path.join(runtime, 'plugin-x'), link, kind)
  }
  return { root, runtime, home, links, target: path.join(runtime, 'plugin-x') }
}

/** What is left of the linked tree: the two files it shipped with. */
function targetFiles(target) {
  return existsSync(target) ? readdirSync(target).sort() : []
}

test('removeTree deletes the home and never follows a link out of it', async (t) => {
  const fixture = buildHome('walker')
  // Cleanup is registered before the assertions: a failure below must not leave
  // a temp tree (with junctions in it) behind for the next run to trip over.
  t.after(() => removeTree(fixture.root))
  // The safety of the walker rests on this: a junction reads as a link, not as a
  // directory. If a runtime ever changes that, the walker degrades silently.
  for (const link of fixture.links) {
    assert.equal(lstatSync(link).isSymbolicLink(), true, `${link} must read as a link`)
  }

  await removeTree(fixture.home)

  assert.equal(existsSync(fixture.home), false, 'the home is gone')
  assert.equal(existsSync(fixture.links[0]), false, 'the link inside it is gone, not left dangling')
  assert.deepEqual(targetFiles(fixture.target), ['client.js', 'package.json'],
    'the linked tree still holds every file it had — this is the whole point')
  await removeTree(fixture.home) // idempotent, like force: true
  await removeTree(path.join(fixture.home, 'never-existed')) // absent target is a no-op
})

// ------------------------------------------------------- 3. discriminating

/** A deleter that descends by `stat`, i.e. the naive shape that follows links. */
async function deleteFollowingLinks(target) {
  const stats = await stat(target)
  if (!stats.isDirectory()) {
    await rm(target, { force: true })
    return
  }
  for (const entry of await readdir(target)) await deleteFollowingLinks(path.join(target, entry))
  await rmdir(target)
}

test('the same structure can lose the linked tree — the guarantee above is not vacuous', async (t) => {
  const roots = []
  t.after(async () => { for (const root of roots) await removeTree(root) })
  const make = (tag) => {
    const fixture = buildHome(tag)
    roots.push(fixture.root)
    return fixture
  }

  // A walker built on `stat` instead of `lstat` reads the junction as a directory
  // and deletes THROUGH it. This is the control for the test above: on any platform,
  // if this stops emptying the target, that test could no longer tell the two apart.
  const following = make('following')
  await deleteFollowingLinks(following.home).catch(() => undefined)
  assert.deepEqual(targetFiles(following.target), [],
    'a link-following delete must empty the linked tree, or the test cannot discriminate')

  // The async form is what the shell itself uses on trees that hold links, so it
  // is asserted, not merely observed: it must leave the linked tree alone.
  const asyncCase = make('async')
  await rm(asyncCase.home, { recursive: true, force: true })
  assert.deepEqual(targetFiles(asyncCase.target), ['client.js', 'package.json'],
    'the async recursive form does not follow a link')

  // The sync form's outcome is the environment-specific fact this guard exists
  // for: it is reported rather than asserted, because the machine's own Node does
  // not reproduce what Electron's Node does (see the header).
  const syncCase = make('sync')
  rmSync(syncCase.home, { recursive: true, force: true })
  const survived = targetFiles(syncCase.target).length > 0
  assert.equal(existsSync(syncCase.home), false, 'the sync form does delete the home')
  t.diagnostic(`sync recursive delete on a linked tree: ${survived ? 'linked tree survived' : 'LINKED TREE EMPTIED'}`
    + ` (node ${process.versions.node}${process.versions.electron === undefined ? '' : ` / electron ${process.versions.electron}`};`
    + ' emptied under Electron 44.4.1 / Node 24.21, survived under plain Node 24.18.0)')
})
