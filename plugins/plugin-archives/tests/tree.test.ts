/**
 * Behavioral tests for the subagent-tree collector.
 *
 * What is load-bearing here:
 *   - the tree is the root PLUS every descendant, and the root is always first;
 *   - the persisted header walk needs BOTH markers: `origin: 'subagent'` and a
 *     `parentSession`. The second one alone is the fork lineage, so a fork child —
 *     a top-level session the user can see — must never join the tree;
 *   - the catalog and the header walk are UNIONED: a catalog pruned after a child
 *     completed no longer names it, and a child left behind is the orphan the whole
 *     module exists to prevent;
 *   - a catalog that cannot answer (throws, or this deployment has no session-query
 *     projection) is not a refusal — the header walk is then the answer;
 *   - a catalog row outside its published shape IS a refusal (`tree-unavailable`):
 *     that is upstream API drift, and guessing what a renamed field meant is how a
 *     plugin silently stops finding children;
 *   - going over the depth or member bound REFUSES (`tree-too-large`); it never
 *     truncates, because a truncated set would move a parent whose grandchild stays
 *     behind.
 *
 * @module @dsh-app/plugin-archives/tests/tree
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  MAX_TREE_DEPTH,
  MAX_TREE_NODES,
  collectSubagentTree,
  type SessionHeaderRow,
} from '../src/tree.ts'

const ROOT = SessionId('session-root')

/** A catalog double that answers one fixed row list. */
function catalog(rows: readonly unknown[]) {
  const asked: string[] = []
  return {
    asked,
    catalog: {
      listDescendants: async (rootSessionId: SessionId) => {
        asked.push(rootSessionId)
        return rows
      },
    },
  }
}

/** A subagent child header (`parentSession` + `origin`). */
function child(id: string, parent = 'session-root'): SessionHeaderRow {
  return { id, parentSession: parent, origin: 'subagent' }
}

test('the catalog walk is the answer, root first, in its own pre-order', async () => {
  const source = catalog([
    { kind: 'child', id: 'session-a', parentId: 'session-root', depth: 1 },
    { kind: 'child', id: 'session-b', parentId: 'session-a', depth: 2 },
  ])

  const tree = await collectSubagentTree({ rootId: ROOT, catalog: source.catalog, headers: [] })

  assert.equal(tree.kind, 'ok')
  if (tree.kind !== 'ok') return
  assert.deepEqual(tree.ids, ['session-root', 'session-a', 'session-b'])
  assert.deepEqual(source.asked, ['session-root'], 'the walk was asked about the root once')
})

test('a header-only child is added to what the catalog already named', async () => {
  const source = catalog([{ kind: 'child', id: 'session-a', parentId: 'session-root', depth: 1 }])

  const tree = await collectSubagentTree({
    rootId: ROOT,
    catalog: source.catalog,
    // The catalog was pruned after this child completed; its header still names it.
    headers: [child('session-a'), child('session-b')],
  })

  assert.equal(tree.kind, 'ok')
  if (tree.kind !== 'ok') return
  assert.deepEqual(tree.ids, ['session-root', 'session-a', 'session-b'])
  assert.deepEqual(tree.sources, ['catalog', 'headers'])
})

test('the header walk follows the subagent marker only, never the fork lineage', async () => {
  const tree = await collectSubagentTree({
    rootId: ROOT,
    catalog: undefined,
    headers: [
      // A FORK child: it carries the lineage but not the subagent origin. It is a
      // top-level session in the sidebar and must not be deleted with the root.
      { id: 'session-fork', parentSession: 'session-root' },
      child('session-a'),
      { id: 'session-unrelated' },
    ],
  })

  assert.equal(tree.kind, 'ok')
  if (tree.kind !== 'ok') return
  assert.deepEqual(tree.ids, ['session-root', 'session-a'])
})

test('the header walk reaches grandchildren', async () => {
  const tree = await collectSubagentTree({
    rootId: ROOT,
    catalog: undefined,
    headers: [child('session-a'), child('session-b', 'session-a')],
  })

  assert.equal(tree.kind, 'ok')
  if (tree.kind !== 'ok') return
  assert.deepEqual(tree.ids, ['session-root', 'session-a', 'session-b'])
})

test('a catalog that cannot answer leaves the header walk as the answer', async () => {
  const tree = await collectSubagentTree({
    rootId: ROOT,
    catalog: { listDescendants: async () => { throw new Error('session-query unavailable') } },
    headers: [child('session-a')],
  })

  assert.equal(tree.kind, 'ok')
  if (tree.kind !== 'ok') return
  assert.deepEqual(tree.ids, ['session-root', 'session-a'])
  assert.deepEqual(tree.sources, ['headers'], 'a walk nobody could run is not a member source')
})

test('a diagnostic row still names a real session and joins the tree', async () => {
  const source = catalog([
    { kind: 'diagnostic', id: 'session-a', parentId: 'session-root', depth: 1, reason: 'unavailable' },
  ])

  const tree = await collectSubagentTree({ rootId: ROOT, catalog: source.catalog, headers: [child('session-a')] })

  assert.equal(tree.kind, 'ok')
  if (tree.kind !== 'ok') return
  assert.deepEqual(tree.ids, ['session-root', 'session-a'])
})

test('a catalog row outside its published shape refuses the tree instead of guessing', async () => {
  const shapes: readonly unknown[][] = [
    [{ kind: 'grandchild', id: 'session-a', depth: 1 }],
    [{ kind: 'child', id: '', depth: 1 }],
    [{ kind: 'child', id: 'session-a', depth: 0 }],
    [{ kind: 'child', id: 'session-a' }],
    [null],
  ]
  for (const rows of shapes) {
    const tree = await collectSubagentTree({ rootId: ROOT, catalog: catalog(rows).catalog, headers: [] })
    assert.equal(tree.kind, 'refused', `${JSON.stringify(rows)} must be refused`)
    if (tree.kind !== 'refused') continue
    assert.equal(tree.reason, 'tree-unavailable')
  }
})

test('a tree with more members than the bound is refused, never truncated', async () => {
  const headers: SessionHeaderRow[] = []
  for (let index = 0; index <= MAX_TREE_NODES; index += 1) headers.push(child(`session-${index}`))

  const tree = await collectSubagentTree({ rootId: ROOT, catalog: undefined, headers })

  assert.equal(tree.kind, 'refused')
  if (tree.kind !== 'refused') return
  assert.equal(tree.reason, 'tree-too-large')
  assert.match(tree.detail, new RegExp(`more than ${MAX_TREE_NODES} sessions`))
})

test('a tree deeper than the bound is refused, never truncated', async () => {
  const headers: SessionHeaderRow[] = []
  let parent = 'session-root'
  for (let depth = 1; depth <= MAX_TREE_DEPTH + 1; depth += 1) {
    const id = `session-d${depth}`
    headers.push(child(id, parent))
    parent = id
  }

  const tree = await collectSubagentTree({ rootId: ROOT, catalog: undefined, headers })

  assert.equal(tree.kind, 'refused')
  if (tree.kind !== 'refused') return
  assert.equal(tree.reason, 'tree-too-large')
})

test('a tree exactly at the bound still answers', async () => {
  const headers: SessionHeaderRow[] = []
  let parent = 'session-root'
  for (let depth = 1; depth <= MAX_TREE_DEPTH; depth += 1) {
    const id = `session-d${depth}`
    headers.push(child(id, parent))
    parent = id
  }

  const tree = await collectSubagentTree({ rootId: ROOT, catalog: undefined, headers })

  assert.equal(tree.kind, 'ok')
  if (tree.kind !== 'ok') return
  assert.equal(tree.ids.length, MAX_TREE_DEPTH + 1)
})
