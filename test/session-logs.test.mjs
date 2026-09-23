// Guards the rollback notice's one input: how many session logs on disk were
// written at a format the kernel being rolled back TO cannot list.
//
// The count never decides whether to roll back — only which sentence the notice
// shows — so the rules that matter are the tolerant ones: a missing, empty or
// unreadable tree must answer 0 instead of throwing into a recovery path that
// has a server to bring back up. The positive case is the one that changes what
// the user reads, so it is asserted against the real on-disk layout
// (`<root>/<project>/<session-id>/session[.vN].<ext>`) rather than a flat list.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { countV4SessionLogs } = require('../dist/main/session-logs.js')

/** A sessions tree with one project and one session directory. */
function tree(...entries) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-session-logs-'))
  const dir = path.join(root, '--D-codes-example--', '1a21a13e-5356-4d5c-8088-2b5b0795a4d0')
  mkdirSync(dir, { recursive: true })
  for (const name of entries) writeFileSync(path.join(dir, name), '')
  return root
}

test('a V4 generation is counted, and the older generations beside it are not', async () => {
  // The generations coexist by design (an adjacent migration publishes a
  // successor and never touches the source), so a session that has been through
  // the migration carries all of them at once.
  const root = tree('session.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.v4.jsonl.zstd')
  assert.equal(await countV4SessionLogs(root), 1)
})

test('every V4 generation under the tree counts, not just the first', async () => {
  const root = tree('session.v4.jsonl.zstd')
  const other = path.join(root, '--D-codes-other--', '26adf502-5018-4177-a106-7940398f3cbc')
  mkdirSync(other, { recursive: true })
  writeFileSync(path.join(other, 'session.v4.jsonl'), '')
  assert.equal(await countV4SessionLogs(root), 2)
})

test('a tree without V4 logs answers 0, so the plain rollback notice stands', async () => {
  assert.equal(await countV4SessionLogs(tree('session.jsonl.zstd', 'session.v3.jsonl.zstd')), 0)
  assert.equal(await countV4SessionLogs(tree()), 0)
})

test('a missing or unreadable root answers 0 rather than throwing', async () => {
  // The rollback path calls this before every rollback, including the first one
  // on a machine that has never written a session.
  assert.equal(await countV4SessionLogs(path.join(os.tmpdir(), 'dsh-session-logs-does-not-exist')), 0)
})

test('a file that merely starts with the session prefix is not a V4 generation', async () => {
  // `session.v4.jsonl.zstd` is the generation; a sidecar or a hand-made backup
  // beside it must not inflate a number the user reads.
  const root = tree('session.v4.jsonl.zstd.tmp', 'session.v4.jsonl.bak', 'session.v40.jsonl.zstd')
  assert.equal(await countV4SessionLogs(root), 0)
})
