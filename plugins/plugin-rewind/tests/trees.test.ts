/**
 * Tests for the workspace snapshot store.
 *
 * This is the half that covers what the write waterfalls cannot see — a shell
 * command, a script the model ran, an office renderer — so the properties pinned
 * here are the ones that decide whether a recall puts the tree back or damages it:
 *
 *   1. a change made by ANY writer is found by diffing the current tree against
 *      the snapshot, and its bytes come back byte-exact (a generated PNG must not
 *      be "restored" through a text decode);
 *   2. a file the range created is a removal, and a file it deleted comes back;
 *   3. an INCOMPLETE snapshot — or an incomplete DIFF walk — never decides that a
 *      file was created. That judgement moves a user's file out of the workspace,
 *      and a walk that stopped early cannot tell "new" from "never looked at";
 *   4. a file the walk SAW but could not copy (too large, unreadable, a link) is
 *      never mistaken for created either, and a change to it is reported;
 *   5. a blob whose bytes do not match the hash its manifest names is reported
 *      rather than written back;
 *   6. dropping a turn collects the blobs nothing else references, and the store
 *      is trimmed by count, by age and by total size.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  blobsRoot,
  captureWorkspace,
  collectGarbage,
  DEFAULT_TREE_LIMITS,
  diffWorkspace,
  dropSnapshots,
  latestSnapshotBefore,
  pathKey,
  pruneSnapshots,
  readSnapshot,
  treesRoot,
  type TreeLimits,
  type TreeSnapshot,
} from '../src/trees.ts'

/** A scratch workspace plus a scratch `$DSH_HOME`, both removed by the caller. */
function scratch(): { root: string, home: string } {
  // Canonicalized the way `captureWorkspace` stores its root. `realpathSync.native`
  // is the one that agrees with the async `realpath` on Windows: the plain
  // `realpathSync` returns the short (8.3) spelling while the async call returns
  // the long one, and comparing the two spellings of one directory is exactly the
  // mismatch `pathKey` exists for.
  return {
    root: realpathSync.native(mkdtempSync(join(tmpdir(), 'rewind-ws-'))),
    home: realpathSync.native(mkdtempSync(join(tmpdir(), 'rewind-home-'))),
  }
}

/** The shipped bounds, with per-test overrides. */
function limits(overrides: Partial<TreeLimits> = {}): TreeLimits {
  return { ...DEFAULT_TREE_LIMITS, ...overrides }
}

/** Count the blobs the store holds. */
function blobCount(home: string): number {
  const root = blobsRoot(home)
  if (!existsSync(root)) return 0
  let total = 0
  for (const prefix of readdirSync(root)) total += readdirSync(join(root, prefix)).length
  return total
}

/** A symlink to a directory, spelled the way the platform allows. */
function linkDir(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

/** Remove both scratch trees. */
async function cleanup(root: string, home: string): Promise<void> {
  await rm(root, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
}

test('a change made outside the write tools is found and its bytes come back', async () => {
  // The case this module exists for: nothing told the plugin about this write.
  const { root, home } = scratch()
  writeFileSync(join(root, 'sprite.png'), Buffer.from([1, 2, 3, 0, 4]))
  writeFileSync(join(root, 'note.md'), 'ORIGINAL')
  await captureWorkspace(home, 's', 1, root, limits())

  // A shell command rewrites one file and creates another.
  writeFileSync(join(root, 'sprite.png'), Buffer.from([9, 9, 9, 0, 9, 9]))
  writeFileSync(join(root, 'generated.txt'), 'NEW')
  const snapshot = await readSnapshot(home, 's', 1)
  assert.ok(snapshot !== undefined)
  const diff = await diffWorkspace(snapshot, home, limits())

  const byPath = new Map(diff.restore.map((t) => [t.path, t.before]))
  assert.ok(byPath.get(join(root, 'sprite.png'))?.equals(Buffer.from([1, 2, 3, 0, 4])), 'binary bytes are exact')
  assert.equal(byPath.get(join(root, 'generated.txt')), null, 'a created file is a removal')
  assert.equal(byPath.has(join(root, 'note.md')), false, 'an untouched file is not a target')
  assert.equal(diff.removalsSuppressed, false)
  await cleanup(root, home)
})

test('a file the range deleted is restored, and a skipped directory is left alone', async () => {
  const { root, home } = scratch()
  writeFileSync(join(root, 'kept.txt'), 'KEPT')
  mkdirSync(join(root, 'node_modules'))
  writeFileSync(join(root, 'node_modules', 'dep.js'), 'DEP')
  await captureWorkspace(home, 's', 1, root, limits())

  // The shell deletes a file and rewrites one under the skipped directory.
  await rm(join(root, 'kept.txt'))
  writeFileSync(join(root, 'node_modules', 'dep.js'), 'DEP CHANGED')
  const snapshot = await readSnapshot(home, 's', 1)
  assert.ok(snapshot !== undefined)
  const diff = await diffWorkspace(snapshot, home, limits())

  const byPath = new Map(diff.restore.map((t) => [t.path, t.before]))
  assert.equal(byPath.get(join(root, 'kept.txt'))?.toString('utf8'), 'KEPT', 'a deleted file comes back')
  assert.equal(byPath.has(join(root, 'node_modules', 'dep.js')), false, 'a skipped directory is not covered')
  assert.equal(diff.coveredOf(join(root, 'node_modules', 'dep.js')), false)
  assert.equal(diff.coveredOf(join(root, 'kept.txt')), true)
  await cleanup(root, home)
})

test('an incomplete snapshot never decides that a file was created', async () => {
  // The dangerous case: the walk stopped early, so a file it never reached looks
  // exactly like a file that did not exist. Treating the two alike moves a file
  // the user still has out of the workspace.
  const { root, home } = scratch()
  for (let i = 0; i < 5; i += 1) writeFileSync(join(root, `f${String(i)}.txt`), `content ${String(i)}`)
  await captureWorkspace(home, 's', 1, root, limits({ maxFiles: 2 }))

  const snapshot = await readSnapshot(home, 's', 1)
  assert.ok(snapshot !== undefined)
  assert.equal(snapshot.complete, false, 'the walk must report that it stopped early')
  const diff = await diffWorkspace(snapshot, home, limits({ maxFiles: 2 }))
  assert.equal(diff.removalsSuppressed, true, 'removals must be suppressed')
  assert.equal(diff.restore.some((t) => t.before === null), false, 'nothing may be treated as created')
  await cleanup(root, home)
})

test('an incomplete DIFF walk suppresses removals too', async () => {
  // The mirror image of the case above: the snapshot was whole, but the walk at
  // recall time stopped early. A manifest entry it never reached then looks
  // DELETED, and a file that is present looks created — both directions move a
  // file the user has.
  const { root, home } = scratch()
  for (let i = 0; i < 5; i += 1) writeFileSync(join(root, `f${String(i)}.txt`), `content ${String(i)}`)
  await captureWorkspace(home, 's', 1, root, limits())
  writeFileSync(join(root, 'created.txt'), 'NEW')

  const snapshot = await readSnapshot(home, 's', 1)
  assert.ok(snapshot !== undefined)
  const diff = await diffWorkspace(snapshot, home, limits({ maxFiles: 2 }))
  assert.equal(diff.removalsSuppressed, true, 'the diff walk was cut short, so nothing may be called created')
  assert.equal(diff.restore.some((t) => t.before === null), false, 'and nothing may be called deleted')
  assert.equal(diff.coveredOf(join(root, 'created.txt')), false, 'so the recorder keeps this path')
  await cleanup(root, home)
})

test('a file seen but not copied is never created, and its change is reported', async () => {
  // Two causes reach this table: too large to copy, and a read that failed after
  // the stat succeeded. Both mean "it existed", which is what forbids the
  // created/removal judgement — a dropped entry would be indistinguishable from
  // absence.
  const { root, home } = scratch()
  const big = join(root, 'big.bin')
  writeFileSync(big, Buffer.alloc(64, 7))
  await captureWorkspace(home, 's', 1, root, limits({ maxFileBytes: 16 }))

  const snapshot = await readSnapshot(home, 's', 1)
  assert.ok(snapshot !== undefined)
  assert.equal(snapshot.entries['big.bin'], undefined, 'too large to copy')
  assert.equal(snapshot.uncaptured['big.bin']?.reason, 'too-large', 'but recorded, with its cause')
  assert.equal((await diffWorkspace(snapshot, home, limits({ maxFileBytes: 16 }))).coveredOf(big), false)

  writeFileSync(big, Buffer.alloc(128, 8))
  const diff = await diffWorkspace(snapshot, home, limits({ maxFileBytes: 16 }))
  assert.deepEqual(diff.uncapturedChanged, [big], 'its change is reported rather than silently dropped')
  assert.equal(diff.restore.some((t) => t.path === big), false, 'and it is never a target')
  await cleanup(root, home)
})

test('a manifest entry recorded as unreadable is not treated as created either', async () => {
  // The capture's read-failure branch writes into `uncaptured` (see the source
  // assertion below); this pins what a manifest carrying one means.
  const { root, home } = scratch()
  writeFileSync(join(root, 'locked.txt'), 'CONTENT')
  await captureWorkspace(home, 's', 1, root, limits())
  const snapshot = await readSnapshot(home, 's', 1)
  assert.ok(snapshot !== undefined)
  const patched: TreeSnapshot = {
    ...snapshot,
    entries: {},
    uncaptured: { 'locked.txt': { size: 7, mtimeMs: 1, reason: 'unreadable' } },
  }
  const diff = await diffWorkspace(patched, home, limits())
  assert.equal(diff.restore.length, 0, 'it is not a removal, and there is nothing to write back')
  assert.deepEqual(diff.uncapturedChanged, [join(root, 'locked.txt')], 'a change to it is reported')
  await cleanup(root, home)

  const source = readFileSync(new URL('../src/trees.ts', import.meta.url), 'utf8')
  const code = source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
  assert.match(
    code,
    /catch \{\n\s+uncaptured\[rel\] = \{ size: found\.size, mtimeMs: found\.mtimeMs, reason: 'unreadable' \}/u,
    'a read failure must be recorded as uncaptured, never dropped',
  )
})

test('a symlinked directory makes the snapshot partial, so nothing is called created', async () => {
  const { root, home } = scratch()
  const outside = mkdtempSync(join(tmpdir(), 'rewind-out-'))
  writeFileSync(join(root, 'a.txt'), 'A')
  writeFileSync(join(outside, 'linked.txt'), 'L')
  try {
    linkDir(outside, join(root, 'linked'))
  } catch {
    // A platform that will not let this process create a link: the property is
    // unreachable here rather than failing.
    await cleanup(root, home)
    await rm(outside, { recursive: true, force: true })
    return
  }
  await captureWorkspace(home, 's', 1, root, limits())
  const snapshot = await readSnapshot(home, 's', 1)
  assert.ok(snapshot !== undefined)
  assert.equal(snapshot.complete, false, 'a subtree the walk refused to enter is a hole, not a clean tree')
  assert.equal(snapshot.reason, 'symlink')
  assert.equal(snapshot.entries['linked/linked.txt'], undefined, 'and it is not covered')
  await cleanup(root, home)
  await rm(outside, { recursive: true, force: true })
})

test('a blob whose bytes do not match its hash is reported, never written back', async () => {
  const { root, home } = scratch()
  writeFileSync(join(root, 'a.txt'), 'ORIGINAL')
  await captureWorkspace(home, 's', 1, root, limits())
  // Corrupt the stored bytes in place: the manifest still names the old hash.
  const prefix = readdirSync(blobsRoot(home))[0]
  const hash = readdirSync(join(blobsRoot(home), prefix))[0]
  writeFileSync(join(blobsRoot(home), prefix, hash), 'NOT THE BEFORE IMAGE')
  writeFileSync(join(root, 'a.txt'), 'CHANGED')

  const snapshot = await readSnapshot(home, 's', 1)
  assert.ok(snapshot !== undefined)
  const diff = await diffWorkspace(snapshot, home, limits())
  assert.deepEqual(diff.restore, [], 'a blob that is not the before-image must not be restored')
  assert.deepEqual(diff.missing, [join(root, 'a.txt')], 'and it is reported instead')
  await cleanup(root, home)
})

test('an unchanged tree is re-read only for what moved', async () => {
  const { root, home } = scratch()
  writeFileSync(join(root, 'a.txt'), 'A')
  writeFileSync(join(root, 'b.txt'), 'B')
  const first = await captureWorkspace(home, 's', 1, root, limits())
  assert.equal(blobCount(home), 2)
  // Same content, same mtime: the hashes carry forward and nothing new is stored.
  const second = await captureWorkspace(home, 's', 2, root, limits(), first)
  assert.deepEqual(second.entries, first.entries)
  assert.equal(blobCount(home), 2)
  assert.equal(second.complete, true)
  await cleanup(root, home)
})

test('the newest manifest before a turn is what a capture reuses', async () => {
  const { root, home } = scratch()
  writeFileSync(join(root, 'a.txt'), 'A')
  await captureWorkspace(home, 's', 1, root, limits())
  await captureWorkspace(home, 's', 4, root, limits())
  assert.equal((await latestSnapshotBefore(home, 's', 5))?.turn, 4)
  assert.equal((await latestSnapshotBefore(home, 's', 4))?.turn, 1)
  assert.equal(await latestSnapshotBefore(home, 's', 1), undefined)
  await cleanup(root, home)
})

test('dropping a turn collects the blobs nothing references any more', async () => {
  const { root, home } = scratch()
  writeFileSync(join(root, 'a.txt'), 'A')
  writeFileSync(join(root, 'b.txt'), 'B')
  await captureWorkspace(home, 's', 1, root, limits())
  // Turn 2 rewrites one file: its old content is referenced by turn 1 only, its
  // new content by turn 2 only, and b.txt by both.
  writeFileSync(join(root, 'a.txt'), 'A2')
  await captureWorkspace(home, 's', 2, root, limits(), await readSnapshot(home, 's', 1))
  assert.equal(blobCount(home), 3)

  await dropSnapshots(home, 's', [2])
  assert.equal(await readSnapshot(home, 's', 2), undefined, 'the manifest is gone')
  // 'A2' is referenced by nothing; 'A' and 'B' are still live for turn 1.
  assert.equal(blobCount(home), 2, 'the orphaned blob is collected, the shared ones survive')
  assert.ok(existsSync(treesRoot(home, 's')), 'the session directory stays')
  await cleanup(root, home)
})

test('a blob a capture is holding is never collected under it', async () => {
  // A capture stores bytes BEFORE the manifest that names them, so a collection
  // running in that window must not treat them as orphans — the manifest written
  // a moment later would name bytes that no longer exist. The hold is in-process
  // and exact (an mtime grace period is not: a blob that already existed because
  // another turn stored the same content keeps its OLD mtime). This test runs the
  // two concurrently; the interleaving is not guaranteed, so it can only fail in
  // the bad case.
  const { root, home } = scratch()
  writeFileSync(join(root, 'a.txt'), 'A')
  writeFileSync(join(root, 'b.txt'), 'B')
  const [snapshot] = await Promise.all([
    captureWorkspace(home, 's', 1, root, limits()),
    collectGarbage(home),
  ])
  const hashes = Object.values(snapshot.entries).map((entry) => entry[0])
  assert.equal(hashes.length, 2)
  for (const hash of hashes) {
    assert.ok(
      existsSync(join(blobsRoot(home), hash.slice(0, 2), hash)),
      'every blob the manifest names survived the concurrent collection',
    )
  }
  await cleanup(root, home)
})

test('the retention cap keeps the newest manifests and collects what it drops', async () => {
  const { root, home } = scratch()
  writeFileSync(join(root, 'a.txt'), 'v0')
  for (let turn = 1; turn <= 4; turn += 1) {
    writeFileSync(join(root, 'a.txt'), `v${String(turn)}`)
    await captureWorkspace(home, 's', turn, root, limits(), await latestSnapshotBefore(home, 's', turn))
  }
  assert.equal(blobCount(home), 4)
  await pruneSnapshots(home, 's', limits({ maxSnapshotsPerSession: 2 }))
  assert.equal(await readSnapshot(home, 's', 1), undefined, 'the oldest manifests are dropped')
  assert.equal(await readSnapshot(home, 's', 2), undefined)
  assert.ok(await readSnapshot(home, 's', 3) !== undefined, 'the newest are kept')
  assert.ok(await readSnapshot(home, 's', 4) !== undefined)
  assert.equal(blobCount(home), 2, 'the blobs only the dropped turns referenced are collected')
  await cleanup(root, home)
})

test('the blob budget drops the oldest snapshots rather than growing without bound', async () => {
  const { root, home } = scratch()
  const payload = 'x'.repeat(4096)
  for (let turn = 1; turn <= 3; turn += 1) {
    writeFileSync(join(root, 'a.txt'), `${payload}${String(turn)}`)
    await captureWorkspace(home, 's', turn, root, limits(), await latestSnapshotBefore(home, 's', turn))
  }
  assert.equal(blobCount(home), 3)
  // A budget that only one snapshot fits into: the oldest two go, and their
  // manifests with them (a manifest is dropped whole, never half-described).
  await collectGarbage(home, limits({ maxBlobBytes: 8192 }))
  assert.equal(blobCount(home), 1, 'the store is back inside its budget')
  assert.equal(await readSnapshot(home, 's', 1), undefined, 'the oldest snapshots are gone')
  assert.equal(await readSnapshot(home, 's', 2), undefined)
  assert.ok(await readSnapshot(home, 's', 3) !== undefined, 'the newest survives')
  await cleanup(root, home)
})

test('a manifest past its age is dropped, so an abandoned session stops pinning blobs', async () => {
  const { root, home } = scratch()
  writeFileSync(join(root, 'a.txt'), 'A')
  await captureWorkspace(home, 's', 1, root, limits())
  await collectGarbage(home, limits({ maxManifestAgeMs: -1 }))
  assert.equal(await readSnapshot(home, 's', 1), undefined, 'the manifest is expired')
  assert.equal(blobCount(home), 0, 'and its blob with it')
  await cleanup(root, home)
})

test('an empty store collects nothing and throws nothing', async () => {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'rewind-home-')))
  await collectGarbage(home)
  assert.equal(await readSnapshot(home, 'nobody', 1), undefined)
  assert.equal(blobCount(home), 0)
  await rm(home, { recursive: true, force: true })
})

test('a manifest is written atomically, so a half file is never read as one', async () => {
  const { root, home } = scratch()
  writeFileSync(join(root, 'a.txt'), 'A')
  await captureWorkspace(home, 's', 1, root, limits())
  const names = readdirSync(treesRoot(home, 's'))
  assert.deepEqual(names, ['1.json'], 'no temp file is left behind')
  assert.ok(readFileSync(join(treesRoot(home, 's'), '1.json'), 'utf8').startsWith('{"v":1'), 'and it parses as one')
  await cleanup(root, home)
})

test('the stored root is canonical, so one file has one spelling', async () => {
  // The manifest's paths are built from the session cwd, while the write
  // waterfall hands over the filesystem provider's canonical realpath. On
  // Windows a short (8.3) cwd spells one directory two ways, and a target list
  // keyed by the raw string then holds one file twice — measured in the
  // end-to-end probe as a doubled restore and a doubled quarantine copy.
  const raw = mkdtempSync(join(tmpdir(), 'rewind-ws-'))
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'rewind-home-')))
  writeFileSync(join(raw, 'a.txt'), 'A')
  const snapshot = await captureWorkspace(home, 's', 1, raw, limits())
  assert.equal(snapshot.root, realpathSync.native(raw), 'the root is stored canonical')
  assert.equal(snapshot.entries['a.txt'] !== undefined, true, 'the entry key is relative to it')
  await cleanup(raw, home)
})

test('pathKey resolves a path and folds the case a Windows path arrives in', () => {
  const base = join(tmpdir(), 'a', 'b.ts')
  assert.equal(pathKey(join(tmpdir(), 'a', '..', 'a', 'b.ts')), pathKey(base), 'resolved')
  if (process.platform === 'win32') {
    assert.equal(pathKey('C:\\Users\\X\\A.TS'), pathKey('c:\\users\\x\\a.ts'), 'case folded')
  } else {
    assert.notEqual(pathKey('/A/TS'), pathKey('/a/ts'), 'case is significant on this platform')
  }
})
