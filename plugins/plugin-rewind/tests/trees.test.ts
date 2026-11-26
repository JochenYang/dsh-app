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
  drainGarbageCollection,
  dropSnapshots,
  latestSnapshotBefore,
  pathKey,
  pruneSnapshots,
  readSnapshot,
  requestCaptureCollection,
  requestGarbageCollection,
  treesRoot,
  type TreeLimits,
  type TreeSnapshot,
} from '../src/trees.ts'

/** Schedule the collection a drop/prune owes, then wait for it. */
async function collect(home: string, limits?: TreeLimits): Promise<void> {
  // The report is a no-op because `drainGarbageCollection` re-raises the same
  // rejection, which is how a failing pass reaches the assertion instead of
  // becoming an unhandled rejection inside the scheduler.
  requestGarbageCollection(home, () => {}, limits)
  await drainGarbageCollection(home)
}

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
  // The walk bound is a wall clock, and these cases are not about it: under the load
  // of the whole 19-plugin batch a 1500 ms walk could report `timeout`, which changes
  // the manifest and the blob tally. One real flake was observed that way (193/194 in
  // a batch run, green in six isolated runs). The bound has its own case.
  return { ...DEFAULT_TREE_LIMITS, maxWalkMs: 60_000, ...overrides }
}

/** Count the blobs the store holds. */
function blobCount(home: string): number {
  const root = blobsRoot(home)
  if (!existsSync(root)) return 0
  let total = 0
  for (const prefix of readdirSync(root)) total += readdirSync(join(root, prefix)).length
  return total
}

/** Store bytes no manifest names, which only a collection pass removes. */
function plantOrphan(home: string, prefix: string): string {
  const path = join(blobsRoot(home), prefix, `${prefix}${'0'.repeat(62)}`)
  mkdirSync(join(blobsRoot(home), prefix), { recursive: true })
  writeFileSync(path, 'ORPHAN')
  return path
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
  // The capture's read-failure branch records the entry (see the source rule
  // below); this pins what a manifest carrying one means.
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
})

test('source rule: a file the capture cannot read is recorded as uncaptured, never dropped', () => {
  // No fixture makes `readFile` fail on a file `stat` can see on every platform
  // this suite runs on, so the branch is asserted where it is written.
  // Normalised at the read: a CRLF checkout (Windows, `core.autocrlf=true`)
  // leaves a `\r` at every line end, so a pattern that spans two lines with
  // `\n` never matches there while CI's LF checkout stays green.
  const source = readFileSync(new URL('../src/trees.ts', import.meta.url), 'utf8').replace(/\r\n/gu, '\n')
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

test('a capture past its copy deadline stores nothing more and still carries the unchanged files', async () => {
  // The walk's own bound was honoured from the start; the copy phase that
  // follows it was not, so a 2000-file copy ran to completion against a 50 ms
  // budget (measured 842 ms, `entries 2000/2000`). This pins the stop — no read,
  // no blob — and the part a partial snapshot must keep: every file that did not
  // move is still carried forward from the previous manifest.
  const { root, home } = scratch()
  const names: string[] = []
  for (let i = 0; i < 1000; i += 1) {
    const name = `f${String(i).padStart(5, '0')}.txt`
    names.push(name)
    writeFileSync(join(root, name), `content ${String(i)}\n`)
  }
  const first = await captureWorkspace(home, 's', 1, root, limits())
  assert.equal(Object.keys(first.entries).length, 1000)
  const blobsAfterFirst = blobCount(home)
  // Every second file moves, to a different SIZE: a same-size rewrite can land
  // inside one filesystem timestamp tick and be carried as unchanged.
  for (let i = 0; i < names.length; i += 2) writeFileSync(join(root, names[i]), `changed ${String(i)}\n`)

  const second = await captureWorkspace(home, 's', 2, root, limits({ maxWalkMs: 40 }), first)
  assert.equal(second.complete, false, 'a stopped copy is a partial snapshot')
  assert.equal(second.reason, 'timeout')
  const changed = names.filter((_name, index) => index % 2 === 0)
  const unchanged = names.filter((_name, index) => index % 2 === 1)
  for (const name of unchanged) {
    assert.deepEqual(second.entries[name], first.entries[name], `${name} did not move, so it is carried without I/O`)
  }
  const stored = changed.filter((name) => second.entries[name] !== undefined)
  assert.ok(stored.length > 0, 'the copy runs until its own bound')
  assert.ok(
    stored.length < changed.length,
    `the copy stopped early (${String(stored.length)} of ${String(changed.length)} changed files)`,
  )
  assert.equal(blobCount(home) - blobsAfterFirst, stored.length, 'no blob is stored for a file the stop skipped')
  for (const name of changed) {
    if (second.entries[name] === undefined) {
      assert.equal(second.uncaptured[name], undefined, 'a skipped file is left out of both maps, not mislabelled')
    }
  }
  await cleanup(root, home)
})

test('an abort stops the copy instead of finishing it', async () => {
  // The copy loop used to set `reason` on an abort and then read and store every
  // remaining file. A real controller cannot be fired at a chosen point inside
  // the loop from a test, so this signal reports itself aborted from its third
  // read on: the walk checks it once per directory (this fixture is one
  // directory), the copy loop's first check is the next one, and the one after
  // that must stop the loop.
  const { root, home } = scratch()
  for (let i = 0; i < 6; i += 1) writeFileSync(join(root, `f${String(i)}.txt`), `content ${String(i)}\n`)
  let reads = 0
  const signal = {
    get aborted() {
      reads += 1
      return reads > 2
    },
  } as unknown as AbortSignal
  const snapshot = await captureWorkspace(home, 's', 1, root, limits(), undefined, signal)
  assert.equal(snapshot.complete, false)
  assert.equal(snapshot.reason, 'cancelled')
  assert.equal(Object.keys(snapshot.entries).length, 1, 'the file in flight when the abort landed, and nothing after it')
  assert.equal(blobCount(home), 1, 'and no bytes stored for the files it never reached')
  await cleanup(root, home)
})

test('a walk stopped on its own bound still copies the files it reached, within the copy budget', async () => {
  // `total-bytes` is about what the walk may LOOK at, not about the copy: the
  // files it reached are still copied, as far as the copy phase's own deadline
  // and abort allow. That behaviour must survive the copy getting a stop of its
  // own — which is why the two are separate flags.
  const { root, home } = scratch()
  for (let i = 0; i < 6; i += 1) writeFileSync(join(root, `f${String(i)}.txt`), `${String(i).padStart(2, '0')}${'x'.repeat(62)}`)
  const snapshot = await captureWorkspace(home, 's', 1, root, limits({ maxTotalBytes: 200 }))
  assert.equal(snapshot.reason, 'total-bytes')
  assert.equal(snapshot.complete, false)
  assert.equal(Object.keys(snapshot.entries).length, 3, 'the three files the walk reached before its cap')
  assert.equal(blobCount(home), 3, 'and each of them is stored')
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
  // The drop itself must NOT scan the store: collection parses every manifest of
  // every session and stats every blob, and the recall answers on the other side
  // of that call. The orphan is still here, which is what makes the recall fast.
  assert.equal(blobCount(home), 3, 'the blob outlives the drop, because nothing scanned for it yet')

  await collect(home)
  // 'A2' is referenced by nothing; 'A' and 'B' are still live for turn 1.
  assert.equal(blobCount(home), 2, 'the orphaned blob is collected, the shared ones survive')
  assert.ok(existsSync(treesRoot(home, 's')), 'the session directory stays')
  await cleanup(root, home)
})

test('a collection requested twice while one runs costs one extra pass, and drains to nothing', async () => {
  const { root, home } = scratch()
  writeFileSync(join(root, 'a.txt'), 'A')
  await captureWorkspace(home, 's', 1, root, limits())
  await dropSnapshots(home, 's', [1])
  // Two requests in the same tick: the second only marks the store dirty, so the
  // running pass repeats once instead of a second full scan queueing behind it.
  requestGarbageCollection(home, () => {})
  requestGarbageCollection(home, () => {})
  await drainGarbageCollection(home)
  assert.equal(blobCount(home), 0, 'the orphaned blob is gone')
  // Nothing is pending afterwards: a drain with no work resolves immediately
  // rather than waiting on a promise the scheduler forgot to clear.
  await drainGarbageCollection(home)
  await cleanup(root, home)
})

test('a collection overlapping two captures deletes nothing they stored', async () => {
  // A capture stores bytes BEFORE the manifest that names them, and releases its
  // hold as the manifest starts protecting them. A collection pass overlapping that
  // commit would see the bytes as orphans. This runs the two together, which is what
  // the overlap looks like from outside.
  //
  // What it canNOT prove: the interleaving. `collectGarbage` takes the collection
  // gate synchronously, so in a test's own ordering the pass usually finishes before
  // either capture reaches its commit, and every blob is referenced by the time a
  // pass scans. The gate's own guarantee is pinned structurally in the case below.
  // Measured downstream before that gate existed: 172–193 of 200 blobs lost, and the
  // snapshot then read back as "every file changed".
  const { root, home } = scratch()
  for (let round = 0; round < 12; round += 1) {
    writeFileSync(join(root, `a${String(round)}.txt`), `A${String(round)}`)
    writeFileSync(join(root, `b${String(round)}.txt`), `B${String(round)}`)
    const [first, second] = await Promise.all([
      captureWorkspace(home, 's', round * 2 + 1, root, limits()),
      captureWorkspace(home, 's', round * 2 + 2, root, limits()),
      collectGarbage(home),
    ])
    for (const snapshot of [first, second]) {
      for (const [rel, entry] of Object.entries(snapshot.entries)) {
        const hash = entry[0]
        assert.ok(
          existsSync(join(blobsRoot(home), hash.slice(0, 2), hash)),
          `${rel} survived the concurrent collection (round ${String(round)})`,
        )
      }
    }
  }
  await cleanup(root, home)
})

test('source rule: the manifest commit and the collection pass share one gate', () => {
  // A TIMING property is what closes the blob-loss window, and no test can force the
  // interleaving through the public API (see the case above). So the two structural
  // facts that close it are pinned as source text — the same idiom this suite uses
  // for the client wiring it cannot execute.
  //
  // What it asserts is CO-OCCURRENCE inside one gated block, not textual containment:
  // a commit that writes the manifest and then releases the holds, both inside the
  // gate, would still pass — and that ordering is safe, because the manifest already
  // protects the bytes when the hold goes.
  const text = readFileSync(new URL('../src/trees.ts', import.meta.url), 'utf8')

  const commit = text.indexOf('await withCollectionGate(async () => {')
  assert.notEqual(commit, -1, 'a capture must write its manifest inside the gate')
  const block = text.slice(commit, commit + 700)
  assert.ok(block.includes('writeManifest'), 'the manifest write must be inside that gate')
  assert.ok(block.includes('inFlight.delete'), 'the hold must be released inside the same gate, after it')

  assert.ok(
    text.includes('await withCollectionGate(() => collectOnce('),
    'a collection pass must take the same gate as the commit',
  )

  for (const name of ['dropSnapshots', 'pruneSnapshots']) {
    const start = text.indexOf(`export async function ${name}`)
    assert.notEqual(start, -1, `${name} must exist`)
    // `\n}` is a brace at column 0 — every nested one is indented — and it does not
    // assume a line ending after it (this tree mixes CRLF and LF).
    const end = text.indexOf('\n}', start)
    assert.notEqual(end, -1, `${name} must close with a brace at column 0`)
    assert.ok(
      !text.slice(start, end).includes('collectGarbage'),
      `${name} must not scan the store on its caller's path — that is the recall's answer time`,
    )
  }
})

test('source rule: the capture path asks on the interval floor, never unconditionally', () => {
  // `ensureSnapshot` is not exported, so the WIRING that used to request a
  // whole-store pass after every capture cannot be driven here; the floor's
  // behaviour is covered above. This pins the call itself — the regression is one
  // edit away and would be silent, because a pass that runs early is correct,
  // just slow. In particular it must not read a prune's drop count and turn it
  // into an immediate pass: a capped session drops one manifest per capture.
  const text = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8').replace(/\r\n/gu, '\n')
  assert.match(text, /await pruneSnapshots\(dshHome, info\.id, limits\)/u)
  assert.match(text, /requestCaptureCollection\(dshHome, \(error: unknown\) =>/u)
  assert.doesNotMatch(
    text,
    /pruneSnapshots\([^\n]*\)[\s\S]{0,400}?requestGarbageCollection\(/u,
    'a capture must go through the floored request, not call the collector directly',
  )
})

test('the retention cap keeps the newest manifests and collects what it drops', async () => {
  const { root, home } = scratch()
  writeFileSync(join(root, 'a.txt'), 'v0')
  for (let turn = 1; turn <= 4; turn += 1) {
    // A different SIZE per turn: a same-size rewrite can land inside one
    // filesystem timestamp tick and be carried as unchanged (measured here: one
    // run recorded 3 blobs for 4 turns, all two-byte values).
    writeFileSync(join(root, 'a.txt'), `v${'x'.repeat(turn)}`)
    await captureWorkspace(home, 's', turn, root, limits(), await latestSnapshotBefore(home, 's', turn))
  }
  assert.equal(blobCount(home), 4)
  await pruneSnapshots(home, 's', limits({ maxSnapshotsPerSession: 2 }))
  await collect(home, limits({ maxSnapshotsPerSession: 2 }))
  assert.equal(await readSnapshot(home, 's', 1), undefined, 'the oldest manifests are dropped')
  assert.equal(await readSnapshot(home, 's', 2), undefined)
  assert.ok(await readSnapshot(home, 's', 3) !== undefined, 'the newest are kept')
  assert.ok(await readSnapshot(home, 's', 4) !== undefined)
  assert.equal(blobCount(home), 2, 'the blobs only the dropped turns referenced are collected')
  await cleanup(root, home)
})

test('a prune inside the collection interval does not scan the store', async () => {
  // A session at its retention cap prunes ONE manifest on every capture, so a
  // prune count that forced an immediate pass put a whole-store scan behind every
  // turn of a long session again. The capture path shares one floor for both the
  // prune-dropped and the fallback case.
  const { root, home } = scratch()
  writeFileSync(join(root, 'a.txt'), 'v0')
  for (let turn = 1; turn <= 4; turn += 1) {
    // A different SIZE per turn: a same-size rewrite can land inside one
    // filesystem timestamp tick and be carried as unchanged.
    writeFileSync(join(root, 'a.txt'), `v${'x'.repeat(turn)}`)
    await captureWorkspace(home, 's', turn, root, limits(), await latestSnapshotBefore(home, 's', turn))
  }
  assert.equal(blobCount(home), 4)
  const hour = 60 * 60 * 1000
  // A pass just finished, so the floor is not due for an hour.
  await collect(home, limits({ minCollectionIntervalMs: hour }))
  assert.equal(blobCount(home), 4, 'nothing is orphaned yet')

  const dropped = await pruneSnapshots(home, 's', limits({ maxSnapshotsPerSession: 2 }))
  assert.equal(dropped, 2, 'the two oldest manifests are what it reports dropping')
  assert.equal(await pruneSnapshots(home, 's', limits({ maxSnapshotsPerSession: 2 })), 0, 'and nothing on a second pass')

  requestCaptureCollection(home, () => {}, limits({ minCollectionIntervalMs: hour }))
  await drainGarbageCollection(home)
  assert.equal(blobCount(home), 4, "the dropped turns' blobs stay until the floor passes")
  await cleanup(root, home)
})

test('once the interval has passed, a capped session\'s prune is collected', async () => {
  const { root, home } = scratch()
  writeFileSync(join(root, 'a.txt'), 'v0')
  for (let turn = 1; turn <= 4; turn += 1) {
    writeFileSync(join(root, 'a.txt'), `v${'x'.repeat(turn)}`)
    await captureWorkspace(home, 's', turn, root, limits(), await latestSnapshotBefore(home, 's', turn))
  }
  const hour = 60 * 60 * 1000
  await collect(home, limits({ minCollectionIntervalMs: hour }))
  const dropped = await pruneSnapshots(home, 's', limits({ maxSnapshotsPerSession: 2 }))
  assert.equal(dropped, 2)

  // A zero interval means the floor has passed; the next capture request runs.
  requestCaptureCollection(home, () => {}, limits({ minCollectionIntervalMs: 0 }))
  await drainGarbageCollection(home)
  assert.equal(blobCount(home), 2, "the dropped turns' blobs are collected")
  await cleanup(root, home)
})

test('the recall path is not floored: a direct request collects at once', async () => {
  // A recall just orphaned turns, so it must not wait for the capture path's
  // interval; it calls `requestGarbageCollection` itself.
  const { root, home } = scratch()
  writeFileSync(join(root, 'a.txt'), 'A')
  await captureWorkspace(home, 's', 1, root, limits())
  const hour = 60 * 60 * 1000
  await collect(home, limits({ minCollectionIntervalMs: hour }))

  const orphan = plantOrphan(home, 'cc')
  requestGarbageCollection(home, () => {}, limits({ minCollectionIntervalMs: hour }))
  await drainGarbageCollection(home)
  assert.equal(existsSync(orphan), false, 'a recall bypasses the interval floor')
  await cleanup(root, home)
})

test('a pass that throws does not start the interval clock, so the next request retries', async () => {
  const { root, home } = scratch()
  writeFileSync(join(root, 'a.txt'), 'A')
  await captureWorkspace(home, 's', 1, root, limits())
  const hour = 60 * 60 * 1000
  // A retention getter that throws: `collectOnce` reads it after it has read the
  // manifests, so the pass fails the way an unreadable store would.
  const broken = limits({ minCollectionIntervalMs: hour })
  Object.defineProperty(broken, 'maxManifestAgeMs', {
    get() { throw new Error('manifest store unreadable') },
  })
  const reported: unknown[] = []
  requestGarbageCollection(home, (error) => { reported.push(error) }, broken)
  await assert.rejects(drainGarbageCollection(home), /manifest store unreadable/u)
  assert.equal(reported.length, 1, 'the failure is reported once, through the caller\'s logger')

  // The clock was not stamped by the failed pass, so a capture request inside the
  // hour still runs — a failed collection is retried, not silently skipped.
  const orphan = plantOrphan(home, 'dd')
  requestCaptureCollection(home, () => {}, limits({ minCollectionIntervalMs: hour }))
  await drainGarbageCollection(home)
  assert.equal(existsSync(orphan), false, 'the next request was not blocked by the failed pass')
  await cleanup(root, home)
})

test('a capture that drops no manifest leaves the store to the interval floor', async () => {
  // A pass is 1.9 s of manifest parsing plus 3.2 s of `stat` on a real store, and
  // it holds the collection gate a capture has to wait for. So the no-drop path
  // must not scan at all — except for the fallback that reclaims the orphans a
  // FAILED capture leaves behind, which no prune ever sees.
  const { root, home } = scratch()
  writeFileSync(join(root, 'a.txt'), 'A')
  await captureWorkspace(home, 's', 1, root, limits())
  const hour = 60 * 60 * 1000

  const first = plantOrphan(home, 'aa')
  requestCaptureCollection(home, () => {}, limits({ minCollectionIntervalMs: hour }))
  await drainGarbageCollection(home)
  assert.equal(existsSync(first), false, 'the first fallback for a home is due')

  const second = plantOrphan(home, 'bb')
  requestCaptureCollection(home, () => {}, limits({ minCollectionIntervalMs: hour }))
  await drainGarbageCollection(home)
  assert.ok(existsSync(second), 'the interval has not passed, so nothing scans the store')

  requestCaptureCollection(home, () => {}, limits({ minCollectionIntervalMs: 0 }))
  await drainGarbageCollection(home)
  assert.equal(existsSync(second), false, 'a due fallback reclaims it')
  await cleanup(root, home)
})

test('the blob budget drops the oldest snapshots rather than growing without bound', async () => {
  const { root, home } = scratch()
  for (let turn = 1; turn <= 3; turn += 1) {
    // Each turn writes a DIFFERENT SIZE, and that is load-bearing: the capture
    // skips reading a file whose size and mtime both match the previous
    // manifest, and three back-to-back writes of one size land inside a single
    // filesystem timestamp tick (measured: 183 of 200 same-size rewrites share
    // one truncated millisecond) — so a same-size fixture would record two blobs
    // here and read as a budget bug. Real captures are a turn apart; this loop
    // is not, so the fixture must not depend on sub-tick timing.
    writeFileSync(join(root, 'a.txt'), 'x'.repeat(4096 + turn))
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
