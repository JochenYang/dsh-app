/**
 * The two replay scripts, on CONSTRUCTED logs and a CONSTRUCTED graph.
 *
 * The scripts exist so that a number in `docs/plans/codegraph-understanding-
 * and-cost.md` can be re-measured; a re-measurement nobody can check is only a
 * number. So the fixtures here are built to known counts — one session with an
 * overview that is re-pushed twice, one without, a log that cannot decode, one
 * that predates `--since` — and the JSON is asserted against them, field by
 * field. A change to a counting rule that moves a number shows up as a failed
 * assertion rather than as a quietly different report.
 *
 * The second thing pinned is the discipline both scripts promise: counts and
 * sizes, never a message, a tool argument, an overview text, a token. Every
 * string a real log would keep is a sentinel here, and stdout must contain
 * none of them.
 *
 * The fixtures are multi-frame zstd, built frame by frame with the compressor
 * itself, the way `plugins/plugin-memory/tests/memory-usage.test.ts` builds
 * them: the kernel appends one frame per write, and the reader must walk all
 * of them. The graph is the plugin's own store (`openGraph`, `replaceFile`),
 * placed where the plugin would place it, so the replay opens it read-only
 * exactly as it opens a real one.
 *
 * @module plugin-codegraph/tests/replay-scripts
 */

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { openGraph, replaceFile, type FileRecord, type SymbolRecord } from '../src/store.ts'
import { removeTree } from '../../../scripts/lib/remove-tree.mjs'

// `zstdCompressSync` builds the fixtures; `node:sqlite` is what the graph
// fixture and prefetch-replay open. Both are builtins of a recent Node (zstd
// since 22.15, sqlite unflagged since 22.13), and a Node without zstd cannot
// load this file's named import at all — the memory plugin's usage suite makes
// the same assumption. The second check keeps the intent explicit.
const HAS_ZSTD = typeof zstdCompressSync === 'function' && typeof zstdDecompressSync === 'function'
const HAS_SQLITE = typeof DatabaseSync === 'function'
const skip = HAS_ZSTD && HAS_SQLITE ? false : 'this Node has no zstd support in node:zlib, or no node:sqlite'

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts')

const SINCE = '2026-11-01'
const T = Date.parse(`${SINCE}T00:00:00Z`)

/** Sentinels: each stands for a piece of a real log the report must never echo. */
const OVERVIEW_SYMBOL = 'PrefetchCalibrationSentinel'
const SHARED_NAME = 'sharedHelper'
const UNKNOWN_NAME = 'unknownIdentifier'
const FILE = 'src/app.ts'
const PROSE = 'SENTINEL-prose-xq71'
const QUERY = 'SENTINEL-query-xq71'
const CONTEXT_SYMBOL = 'SENTINEL-context-symbol-xq71'
const SOURCE_TEXT = 'SENTINEL-source-xq71-a'
/** A compaction summary's text: on the surface as a node, measured by length only. */
const SUMMARY_TEXT = 'SENTINEL-summary-xq71'
const SENTINELS = [OVERVIEW_SYMBOL, SHARED_NAME, UNKNOWN_NAME, FILE, PROSE, QUERY, CONTEXT_SYMBOL, SOURCE_TEXT, SUMMARY_TEXT]

/** The runtime-context contribution the overview arrives under (src/prompt.ts). */
const OVERVIEW = 'dsh-app:codegraph:overview'

const ALPHA = 'D:\\proj\\alpha'
const BETA = 'D:\\proj\\beta'
const LATE = 'D:\\proj\\late'
const OLD = 'D:\\proj\\older'

/** Two overview versions that differ in exactly two lines: the headline and one hub row. */
function overviewText(files: string, callSites: string): string {
  return [
    `Code graph for this project (${files} files, ~200 symbols, ~300 edges; typescript ~100).`,
    'Covers the project\u2019s indexed files: imports, calls, extends/implements.',
    'Files nothing else imports \u2014 where a project starts (query one with `codegraph_context("<path>")`):',
    `- ${FILE} (starts at function ${OVERVIEW_SYMBOL}:1)`,
    'Most-referenced symbols in source files \u2014 read these first to learn the vocabulary (each id is directly queryable):',
    `- ${FILE}#function:${OVERVIEW_SYMBOL} \u2014 ${callSites} source call site(s)`,
  ].join('\n')
}
const OVERVIEW_V1 = overviewText('~100', '~5')
const OVERVIEW_V2 = overviewText('~110', '~10')

/** One logged event. */
function event(time: number, type: string, data: unknown): string {
  return `${JSON.stringify({ type, time, data })}\n`
}

/** The header the kernel writes first: no `time`, the project's cwd verbatim. */
function header(cwd: string): string {
  return `${JSON.stringify({ version: 4, id: 's1', type: 'session', createdAt: T, cwd })}\n`
}

/** A native tool call + its result, as the kernel logs them (arguments as JSON text). */
function native(time: number, callId: string, name: string, args: unknown, text: string, isError = false): string[] {
  return [
    event(time, 'tool/call', { name, callId, arguments: JSON.stringify(args), step: 1, turn: 1 }),
    event(time + 1, 'tool/result', { step: 1, turn: 1, message: { toolCallId: callId, isError, role: 'tool', content: [{ type: 'text', text }] } }),
  ]
}

/** A run_code dispatch of a tool + its result (arguments as an object). */
function ptc(time: number, subCallId: string, name: string, args: unknown, text: string): string[] {
  return [
    event(time, 'tool/ptc-dispatch-start', { name, subCallId, arguments: args }),
    event(time + 1, 'tool/ptc-dispatch', { name, subCallId, isError: false, content: [{ type: 'text', text }] }),
  ]
}

const stepStart = (time: number): string => event(time, 'step/start', { step: 1, turn: 1 })

/** A runtime-context snapshot: the whole text, and the sections it was assembled from. */
function snapshot(time: number, sections: { name: string, text: string }[]): string {
  return event(time, 'user/message', {
    role: 'user',
    content: [{ type: 'text', text: sections.map(section => section.text).join('\n') }],
    source: { kind: 'runtime-context', form: 'sections', sections },
  })
}

/** A message a person wrote. */
function human(time: number, text: string): string {
  return event(time, 'user/message', { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
}

const assistantUsage = (time: number, usage: Record<string, number>): string =>
  event(time, 'assistant/message', { message: { content: [{ type: 'text', text: 'ok' }] }, usage })

/**
 * One session's lines the way the kernel writes them for the SURFACE (what the
 * model sees): the header without a seq, every later event with a contiguous
 * `seq` from 0, and every message-producing event with its `surfaceOp` —
 * `append` to join at its own seq, or a replace over `startSeq..endSeq` whose
 * `sourceEventSeqs` cite the nodes it shadows. Each writer returns the seq it
 * gave the event, for the ranges that cite it.
 */
class SessionLog {
  readonly lines: string[] = []
  seq = 0
  constructor(cwd: string) {
    this.lines.push(header(cwd))
  }
  /** A log-only event: no surface marker (a step, a call, a compaction record, a title). */
  log(time: number, type: string, data: unknown): number {
    this.lines.push(`${JSON.stringify({ type, time, seq: this.seq, data })}\n`)
    return this.seq++
  }
  /** A message-producing event that joins the surface at its own seq. */
  enter(time: number, type: string, data: unknown): number {
    this.lines.push(`${JSON.stringify({ type, time, seq: this.seq, data, surfaceOp: 'append' })}\n`)
    return this.seq++
  }
  /** A message-producing event that shadows `startSeq..endSeq` and stands in their place. */
  replace(time: number, type: string, data: unknown, startSeq: number, endSeq: number, shadowed: number[]): number {
    this.lines.push(`${JSON.stringify({ type, time, seq: this.seq, data, surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs: shadowed })}\n`)
    return this.seq++
  }
}

/** A long request that names a held file and a uniquely declared identifier, padded past 600 chars with prose. */
const LONG_MESSAGE = `${`${PROSE} plain prose words here. `.repeat(20)}Please look at ${FILE} and ${OVERVIEW_SYMBOL} before you start.`

/**
 * Session A: an overview, re-pushed twice; one codegraph_find natively and one
 * codegraph_context inside run_code; reads with and without a range, one path
 * read again; three human messages for the prefetch gate and one too short.
 */
function sessionAlpha(): string[] {
  return [
    header(ALPHA),
    stepStart(T + 1),
    snapshot(T + 2, [{ name: OVERVIEW, text: OVERVIEW_V1 }, { name: 'harness:source', text: SOURCE_TEXT }]),
    stepStart(T + 3),
    ...native(T + 4, 'c1', 'codegraph_find', { query: QUERY }, 'x'.repeat(507)),
    ...native(T + 6, 'c2', 'read', { path: FILE, offset: 10, limit: 20 }, 'L'.repeat(100)),
    ...ptc(T + 8, 'p1', 'read', { path: FILE }, 'M'.repeat(80)),
    stepStart(T + 9),
    // Re-push 1: the overview text itself changed.
    snapshot(T + 10, [{ name: OVERVIEW, text: OVERVIEW_V2 }, { name: 'harness:source', text: SOURCE_TEXT }]),
    ...ptc(T + 11, 'p2', 'codegraph_context', { symbol: CONTEXT_SYMBOL }, 'y'.repeat(300)),
    stepStart(T + 12),
    // Re-push 2: the overview rode along; only another contribution changed.
    snapshot(T + 13, [{ name: OVERVIEW, text: OVERVIEW_V2 }, { name: 'harness:source', text: `${SOURCE_TEXT}-b` }]),
    stepStart(T + 14),
    ...native(T + 15, 'c3', 'read', { path: FILE }, 'N'.repeat(60)),
    human(T + 16, LONG_MESSAGE),
    human(T + 18, `fix ${SHARED_NAME} and ${UNKNOWN_NAME} please`),
    human(T + 19, `open app.ts and missing_thing.ts now please`),
    human(T + 20, 'ok'),
    assistantUsage(T + 22, { inputTokens: 100, cacheReadTokens: 900, outputTokens: 50, totalTokens: 1050 }),
  ]
}

/** Session B: no overview, no graph; a run_code, a path read twice natively, one plain message. */
function sessionBeta(): string[] {
  return [
    header(BETA),
    stepStart(T + 1),
    ...native(T + 2, 'c1', 'run_code', { code: 'x' }, 'R'.repeat(200)),
    ...native(T + 4, 'c2', 'read', { path: 'a.ts' }, 'A'.repeat(10)),
    ...native(T + 6, 'c3', 'read', { path: 'a.ts' }, 'A'.repeat(10)),
    ...native(T + 8, 'c4', 'read', { path: 'b.ts' }, 'B'.repeat(10)),
    human(T + 10, 'please continue with the second part'),
  ]
}

/** Session D: everything before --since, so none of it may be counted. */
function sessionOld(): string[] {
  return [header('D:\\proj\\old'), stepStart(T - 86_400_000), ...native(T - 86_399_000, 'old', 'codegraph_find', { query: QUERY }, 'x'.repeat(999))]
}

/** Lines into frames, `perFrame` lines per frame, as the kernel appends one frame per write. */
function multiFrame(lines: string[], perFrame: number): Buffer {
  const frames: Buffer[] = []
  for (let at = 0; at < lines.length; at += perFrame) {
    frames.push(zstdCompressSync(Buffer.from(lines.slice(at, at + perFrame).join(''), 'utf8')))
  }
  return Buffer.concat(frames)
}

/** Every scratch directory this run created, removed when it finishes. */
const scratch: string[] = []
after(async () => {
  for (const dir of scratch.splice(0)) await removeTree(dir)
})

/** A scratch directory under the system temp, with a name no earlier run left behind. */
function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

/** Write one log where the kernel would: <root>/<slug>/session-<n>/session.v4.jsonl.zstd. */
function writeLog(root: string, slug: string, lines: string[], perFrame = 1): string {
  const dir = join(root, slug, `session-${slug}`)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, multiFrame(lines, perFrame))
  return file
}

/**
 * Build the sessions fixture: A (several lines per frame), B (one line per
 * frame), D (before --since), and a log that is not zstd at all.
 * @returns the sessions root.
 */
function sessionsFixture(): string {
  const root = scratchDir('dshcg-replay-sessions-')
  writeLog(root, 'alpha', sessionAlpha(), 3)
  writeLog(root, 'beta', sessionBeta(), 1)
  writeLog(root, 'old', sessionOld(), 2)
  const broken = join(root, 'broken', 'session-broken')
  mkdirSync(broken, { recursive: true })
  writeFileSync(join(broken, 'session.v4.jsonl.zstd'), Buffer.from('not a zstd stream', 'utf8'))
  return root
}

/** The text of session R's resident nodes, by contributor; the overview's is OVERVIEW_V2. */
const R_SIZES = { system: 'sys'.length, summary: SUMMARY_TEXT.length, harness: 'h2'.length, runCode: 500, injected: 30, human: 20, found: 'pruned'.length, assistant: 'ok'.length }
/** Session R's resident chars: its nodes at the end, the overview's text included. */
const R_CHARS = Object.values(R_SIZES).reduce((total, size) => total + size, 0) + OVERVIEW_V2.length
/** Session R's prompt at its last usage: input + cache read + cache write. */
const R_TOKENS = 100 + 180 + 20
/** Session U's resident chars (one human message, one assistant text) and prompt. */
const U_CHARS = 40 + 'done'.length
const U_TOKENS = 100 + 400

/**
 * Session R: the surface the resident measure is taken over. A system prompt,
 * then an early stretch — a snapshot with the overview, a read, a human message,
 * a step with usage — that a compaction shadows with a summary node; after it a
 * second snapshot, a codegraph_find answer that a prune later shortens, a
 * run_code whose sub-call answer must not count beside its result, an injected
 * and a human message, and a last step whose usage is the resident prompt and
 * whose reasoning must not count.
 */
function sessionResident(): string[] {
  const s = new SessionLog(ALPHA)
  s.enter(T + 1, 'system/message', { step: 1, turn: 1, message: { role: 'system', content: [{ type: 'text', text: 'sys' }] } })
  s.log(T + 2, 'step/start', { step: 1, turn: 1 })
  const snapshot1 = s.enter(T + 3, 'user/message', {
    role: 'user',
    content: [{ type: 'text', text: `${OVERVIEW_V1}\nctx-one\n${SOURCE_TEXT}` }],
    source: { kind: 'runtime-context', form: 'sections', sections: [{ name: OVERVIEW, text: OVERVIEW_V1 }, { name: 'dsh-app:task-context:current', text: 'ctx-one' }, { name: 'harness:source', text: SOURCE_TEXT }] },
  })
  s.log(T + 4, 'tool/call', { name: 'read', callId: 'c1', arguments: JSON.stringify({ path: FILE }), step: 1, turn: 1 })
  const read = s.enter(T + 5, 'tool/result', { step: 1, turn: 1, message: { toolCallId: 'c1', isError: false, role: 'tool', content: [{ type: 'text', text: 'L'.repeat(100) }] } })
  const human1 = s.enter(T + 6, 'user/message', { role: 'user', content: [{ type: 'text', text: 'H'.repeat(40) }], source: { kind: 'user' } })
  const early = s.enter(T + 7, 'assistant/message', { step: 1, turn: 1, usage: { inputTokens: 10, cacheReadTokens: 90, outputTokens: 5, totalTokens: 105 }, message: { role: 'assistant', content: [{ type: 'text', text: 'early' }] } })
  // The compaction record, then the summary node that shadows the stretch: the kernel's order.
  s.log(T + 8, 'compaction/summary', { compactionId: 'k1', model: 'm', provider: 'p', rawOutput: 'raw', shadowedRange: { start: snapshot1, end: early }, shadowedSeqs: [snapshot1, read, human1, early], shadowedTokenCount: 300, summary: [{ type: 'text', text: SUMMARY_TEXT }] })
  s.replace(T + 9, 'user/message', { role: 'user', content: [{ type: 'text', text: SUMMARY_TEXT }], source: { kind: 'spine-checkpoint' } }, snapshot1, early, [snapshot1, read, human1, early])
  s.enter(T + 10, 'user/message', {
    role: 'user',
    content: [{ type: 'text', text: `${OVERVIEW_V2}\nh2` }],
    source: { kind: 'runtime-context', form: 'sections', sections: [{ name: OVERVIEW, text: OVERVIEW_V2 }, { name: 'harness:source', text: 'h2' }] },
  })
  s.log(T + 11, 'step/start', { step: 2, turn: 1 })
  s.log(T + 12, 'tool/call', { name: 'codegraph_find', callId: 'c2', arguments: JSON.stringify({ query: QUERY }), step: 2, turn: 1 })
  const found = s.enter(T + 13, 'tool/result', { step: 2, turn: 1, message: { toolCallId: 'c2', isError: false, role: 'tool', content: [{ type: 'text', text: 'x'.repeat(300) }] } })
  s.log(T + 14, 'tool/call', { name: 'run_code', callId: 'c3', arguments: JSON.stringify({ code: 'x' }), step: 2, turn: 1 })
  // The sub-call's answer is inside the run_code result below, not beside it.
  s.log(T + 15, 'tool/ptc-dispatch-start', { name: 'read', subCallId: 'p1', arguments: { path: FILE } })
  s.log(T + 16, 'tool/ptc-dispatch', { name: 'read', subCallId: 'p1', isError: false, content: [{ type: 'text', text: 'M'.repeat(80) }] })
  s.enter(T + 17, 'tool/result', { step: 2, turn: 1, message: { toolCallId: 'c3', isError: false, role: 'tool', content: [{ type: 'text', text: 'R'.repeat(R_SIZES.runCode) }] } })
  s.enter(T + 18, 'user/message', { role: 'user', content: [{ type: 'text', text: 'I'.repeat(R_SIZES.injected) }], source: { kind: 'time-context' } })
  s.enter(T + 19, 'user/message', { role: 'user', content: [{ type: 'text', text: 'U'.repeat(R_SIZES.human) }], source: { kind: 'user' } })
  // A prune: the find answer is rewritten in place, and only the rewrite is resident.
  s.log(T + 20, 'compaction/prune', { shadowedRange: { start: found, end: found }, shadowedSeqs: [found], shadowedTokenCount: 80 })
  s.replace(T + 21, 'tool/result', { step: 2, turn: 1, message: { toolCallId: 'c2', isError: false, role: 'tool', content: [{ type: 'text', text: 'pruned' }] } }, found, found, [found])
  s.enter(T + 22, 'assistant/message', {
    step: 2, turn: 1,
    usage: { inputTokens: 100, cacheReadTokens: 180, cacheWriteTokens: 20, outputTokens: 20, totalTokens: 320 },
    message: { role: 'assistant', content: [{ type: 'reasoning', text: 'r'.repeat(1000) }, { type: 'text', text: 'ok' }] },
  })
  s.log(T + 23, 'request/context', { contextWindow: 2000, model: 'm', provider: 'p' })
  return s.lines
}

/** Session S: a human message and no assistant usage — nothing to measure the window against. */
function sessionNoUsage(): string[] {
  const s = new SessionLog(BETA)
  s.log(T + 1, 'step/start', { step: 1, turn: 1 })
  s.enter(T + 2, 'user/message', { role: 'user', content: [{ type: 'text', text: 'N'.repeat(10) }], source: { kind: 'user' } })
  return s.lines
}

/** Session U: its usage predates --since; a title event after it keeps it in the window. */
function sessionLate(): string[] {
  const s = new SessionLog(LATE)
  s.log(T - 3000, 'step/start', { step: 1, turn: 1 })
  s.enter(T - 2500, 'user/message', { role: 'user', content: [{ type: 'text', text: 'K'.repeat(40) }], source: { kind: 'user' } })
  s.enter(T - 2000, 'assistant/message', { step: 1, turn: 1, usage: { inputTokens: 100, cacheReadTokens: 400, outputTokens: 1, totalTokens: 501 }, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } })
  s.log(T + 500, 'session/title', { title: 't' })
  return s.lines
}

/** Session OLD: a usage, but everything before --since — in no section. */
function sessionOldWithUsage(): string[] {
  const s = new SessionLog(OLD)
  s.enter(T - 5000, 'assistant/message', { step: 1, turn: 1, usage: { inputTokens: 9999, outputTokens: 1, totalTokens: 10000 }, message: { role: 'assistant', content: [{ type: 'text', text: 'old' }] } })
  return s.lines
}

/**
 * The sessions for the resident measure: R, S, U and OLD, one log each.
 * @returns the sessions root.
 */
function residentFixture(): string {
  const root = scratchDir('dshcg-replay-resident-')
  writeLog(root, 'resident', sessionResident(), 3)
  writeLog(root, 'nousage', sessionNoUsage(), 1)
  writeLog(root, 'late', sessionLate(), 2)
  writeLog(root, 'older', sessionOldWithUsage(), 1)
  return root
}

/** A file row and a symbol row for the graph fixture. */
const fileRow = (path: string): FileRecord => ({ path, mtime: 1, size: 10, hash: 'h1', lang: 'typescript' })
const symbolRow = (path: string, name: string): SymbolRecord => ({
  id: `${path}#function:${name}`, path, name, kind: 'function', line: 1, endLine: 1, parent: undefined,
})

/**
 * A DSH home whose code-graph storage holds one graph for project ALPHA: one
 * file with a uniquely declared symbol and a shared one, a second file that
 * shares the name. Placed at `<home>/storages/dsh-app-plugin-codegraph/projects/
 * <sha256(cwd)[:32]>/graph.db`, the layout src/index.ts derives.
 * @returns the home.
 */
function graphFixture(): string {
  const home = scratchDir('dshcg-replay-home-')
  const key = createHash('sha256').update(ALPHA).digest('hex').slice(0, 32)
  const graph = openGraph(join(home, 'storages', 'dsh-app-plugin-codegraph', 'projects', key, 'graph.db'))
  replaceFile(graph.db, fileRow(FILE), [symbolRow(FILE, OVERVIEW_SYMBOL), symbolRow(FILE, SHARED_NAME)], [])
  replaceFile(graph.db, fileRow('src/util.ts'), [symbolRow('src/util.ts', SHARED_NAME)], [])
  graph.close()
  return home
}

/** Run a script and return its status and both streams. */
function run(script: string, args: string[], home?: string): { status: number, stdout: string, stderr: string } {
  // windowsHide: a probe run inside Electron must not pop a console per child.
  const result = spawnSync(process.execPath, [join(scripts, script), ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: home === undefined ? process.env : { ...process.env, DSH_HOME: home },
  })
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** The JSON a script printed, after checking it exited 0 and echoed no sentinel. */
function jsonOf(result: { status: number, stdout: string, stderr: string }, label: string): Record<string, any> {
  assert.equal(result.status, 0, `${label}: ${result.stderr}`)
  for (const sentinel of SENTINELS) {
    assert.equal(result.stdout.includes(sentinel), false, `${label} stdout echoes ${sentinel}`)
  }
  return JSON.parse(result.stdout)
}

test('usage-replay counts adoption, re-pushes, reads and the multiplier against known fixtures', { skip }, () => {
  const root = sessionsFixture()
  const report = jsonOf(run('usage-replay.mjs', ['--sessions', root, '--since', SINCE, '--json']), 'usage-replay')

  // Four logs read; the broken one is skipped and counted, the old one parsed but out of the window.
  assert.equal(report.scope.files, 4)
  assert.equal(report.scope.parsed, 3)
  assert.equal(report.scope.skipped, 1)
  assert.equal(report.scope.lines, sessionAlpha().length + sessionBeta().length + sessionOld().length)
  assert.equal(report.scope.unparsable, 0)

  // Adoption: two sessions in the window (A: five steps, B: one), one overview, two graph calls.
  assert.equal(report.adoption.sessions, 2)
  assert.equal(report.adoption.steps, 6)
  assert.equal(report.adoption.sessionsWithOverview, 1)
  assert.equal(report.adoption.sessionsWithGraphTool, 1)
  assert.equal(report.adoption.graphToolCalls, 2)
  assert.deepEqual(report.adoption.byTool.codegraph_find, { calls: 1, errors: 0, answers: { n: 1, p50: 507, p90: 507, max: 507, sum: 507 } })
  assert.deepEqual(report.adoption.byTool.codegraph_context, { calls: 1, errors: 0, answers: { n: 1, p50: 300, p90: 300, max: 300, sum: 300 } })
  assert.equal(report.adoption.byTool.codegraph_impact.calls, 0)

  // Answers: a native read and a run_code read are counted apart, then together.
  assert.deepEqual(report.answers.read.native, { calls: 5, errors: 0, answers: { n: 5, p50: 10, p90: 100, max: 100, sum: 190 } })
  assert.deepEqual(report.answers.read.ptc, { calls: 1, errors: 0, answers: { n: 1, p50: 80, p90: 80, max: 80, sum: 80 } })
  assert.deepEqual(report.answers.read.all, { n: 6, p50: 60, p90: 100, max: 100, sum: 270 })
  assert.equal(report.answers.run_code.native.calls, 1)
  assert.equal(report.answers.grep.all.n, 0)

  // Snapshots: two re-pushes, one where the overview itself changed, one where it rode along.
  const snap = report.snapshots
  assert.equal(snap.repushes, 2)
  assert.equal(snap.repushesWithOverview, 2)
  assert.equal(snap.overviewChanged, 1)
  assert.equal(snap.otherOnly, 1)
  assert.equal(snap.unchanged, 0)
  const v2Chars = OVERVIEW_V2.length + 1 + SOURCE_TEXT.length
  assert.equal(snap.overviewChangedRereadChars, v2Chars * 2)
  assert.equal(snap.otherOnlyRereadChars, v2Chars + 2)
  assert.equal(snap.overviewShareOfOtherOnlyRereadChars, OVERVIEW_V2.length)
  assert.deepEqual(snap.perSessionWithOverview, { n: 1, p50: 2, p90: 2, max: 2, sum: 2 })
  assert.deepEqual(snap.overviewChars, { n: 3, p50: OVERVIEW_V2.length, p90: OVERVIEW_V2.length, max: OVERVIEW_V2.length, sum: OVERVIEW_V1.length + OVERVIEW_V2.length * 2 })
  assert.deepEqual(snap.changedPartners, [{ name: 'harness:source', count: 1 }])
  // One version compared; its two changed lines are the headline and a hub row.
  assert.equal(snap.versionsCompared, 1)
  assert.deepEqual(snap.lineClasses, {
    headline: { versions: 1, lines: 2 }, status: { versions: 0, lines: 0 }, note: { versions: 0, lines: 0 }, scope: { versions: 0, lines: 0 },
    layout: { versions: 0, lines: 0 }, entry: { versions: 0, lines: 0 }, hub: { versions: 1, lines: 2 }, other: { versions: 0, lines: 0 },
  })

  // Explore: both call forms in A, native only in B; one read with a range of six.
  const explore = report.explore
  assert.deepEqual(explore.mode, { nativeOnly: 1, ptcOnly: 0, both: 1, neither: 0 })
  assert.equal(explore.reads.native.calls, 5)
  assert.equal(explore.reads.native.withRange, 1)
  assert.equal(explore.reads.ptc.calls, 1)
  assert.equal(explore.reads.allCalls, 6)
  assert.equal(explore.reads.allWithRange, 1)
  assert.deepEqual(explore.reads.withRangePct, { native: 20, ptc: 0, all: 17 })
  assert.deepEqual(explore.reads.native.answers, { n: 5, p50: 10, p90: 100, max: 100, sum: 190 })
  assert.deepEqual(explore.reads.bands, { '<=2000': 6, '2001-5000': 0, '5001-10000': 0, '10001-20000': 0, '20001-50000': 0, '>50000': 0 })
  // Re-reading: natively src/app.ts twice (A) and a.ts twice (B); in run_code src/app.ts once more.
  assert.deepEqual(
    { reads: explore.repeatReads.native.reads, paths: explore.repeatReads.native.paths, repeats: explore.repeatReads.native.repeats, sharePct: explore.repeatReads.native.sharePct, maxReadsOfOnePath: explore.repeatReads.native.maxReadsOfOnePath },
    { reads: 5, paths: 3, repeats: 2, sharePct: 40, maxReadsOfOnePath: 2 },
  )
  assert.equal(explore.repeatReads.ptc.repeats, 0)
  assert.deepEqual(
    { reads: explore.repeatReads.all.reads, paths: explore.repeatReads.all.paths, repeats: explore.repeatReads.all.repeats, sharePct: explore.repeatReads.all.sharePct, maxReadsOfOnePath: explore.repeatReads.all.maxReadsOfOnePath },
    { reads: 6, paths: 3, repeats: 3, sharePct: 50, maxReadsOfOnePath: 3 },
  )
  assert.deepEqual(explore.repeatReads.all.perSessionRepeats, { n: 2, p50: 2, p90: 2, max: 2, sum: 3 })
  assert.deepEqual(explore.repeatReads.all.perSessionMaxReadsOfOnePath, { n: 2, p50: 3, p90: 3, max: 3, sum: 5 })
  assert.equal(explore.sessionsWithToolCalls, 2)
  assert.equal(explore.firstSixAllRunCode, 0)

  // The multiplier: A's answers at steps 2 and 3 are re-read by the steps after them; B has one step, so nothing.
  const appended = 507 + 100 + 80 + 300 + 60 + 200 + 10 + 10 + 10
  const reread = (507 + 100 + 80) * 3 + 300 * 2 + 60 * 0
  assert.equal(report.multiplier.appendedChars, appended)
  assert.equal(report.multiplier.rereadChars, reread)
  assert.equal(report.multiplier.factor, reread / appended)
  assert.equal(report.multiplier.sessionsAtLeast20Steps, 0)
  assert.equal(report.multiplier.perSession.n, 0)

  assert.deepEqual(report.tokens, { inputTokens: 100, cacheReadTokens: 900, outputTokens: 50, totalTokens: 1050 })
})

test('usage-replay prints the same data as text, honors --since, and exits 2 on a bad argument', { skip }, () => {
  const root = sessionsFixture()
  const text = run('usage-replay.mjs', ['--sessions', root, '--since', SINCE])
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /== adoption\nsessions=2 steps=6/u)
  assert.match(text.stdout, /codegraph_find: calls=1 answers n=1 p50=507/u)
  assert.match(text.stdout, /re-pushes=2; carrying an overview=2 \(overview text itself changed=1, only other contributions changed=1/u)
  assert.match(text.stdout, /headline 1\/2, status 0\/0/u)
  assert.match(text.stdout, /since=2026-11-01/u)
  for (const sentinel of SENTINELS) {
    assert.equal(text.stdout.includes(sentinel), false, `the text report echoes ${sentinel}`)
  }
  // The directory it read is on stderr, not in the report.
  assert.equal(text.stdout.includes(root), false, 'the report echoes the sessions root')
  assert.match(text.stderr, /reading /u)

  // Without --since the old session counts too: one more session, one more graph call.
  const all = jsonOf(run('usage-replay.mjs', ['--sessions', root, '--json']), 'usage-replay (all)')
  assert.equal(all.scope.since, 'beginning')
  assert.equal(all.adoption.sessions, 3)
  assert.equal(all.adoption.byTool.codegraph_find.calls, 2)
  assert.equal(all.adoption.byTool.codegraph_find.answers.max, 999)

  // A date nothing postdates is zero counts and exit 0; the rest is exit 2.
  const empty = jsonOf(run('usage-replay.mjs', ['--sessions', root, '--since', '2999-01-01', '--json']), 'usage-replay (empty)')
  assert.equal(empty.adoption.sessions, 0)
  assert.deepEqual(empty.adoption.byTool.codegraph_find.answers, { n: 0, p50: 0, p90: 0, max: 0, sum: 0 })
  assert.equal(run('usage-replay.mjs', ['--sessions', root, '--since', '2026-13-40']).status, 2)
  assert.equal(run('usage-replay.mjs', ['--sessions', root, '--bogus']).status, 2)
  assert.equal(run('usage-replay.mjs', ['--sessions', join(root, 'no-such-dir')]).status, 2)
  assert.equal(run('usage-replay.mjs', ['--sessions', join(root, 'alpha', 'session-alpha', 'session.v4.jsonl.zstd')]).status, 2)
})

test('usage-replay measures the resident context at session end: the last usage, and the surface nodes still standing', { skip }, () => {
  const root = residentFixture()
  const report = jsonOf(run('usage-replay.mjs', ['--sessions', root, '--since', SINCE, '--json']), 'usage-replay (resident)')
  const resident = report.resident

  // The section's shape.
  assert.deepEqual(Object.keys(resident), [
    'n', 'withoutUsage', 'unmarkedEntries', 'unplacedReplaces', 'sessionsWithMedia',
    'tokens', 'windowShare', 'compactions', 'prunes', 'chars', 'charsPerToken', 'contributors',
  ])

  // Two sessions with a usage record: R, and U whose usage predates --since but
  // whose title keeps it in the window — measured over its whole log. S has
  // none; OLD is before the window. Every entry carried its marker.
  assert.equal(resident.n, 2)
  assert.equal(resident.withoutUsage, 1)
  assert.equal(resident.unmarkedEntries, 0)
  assert.equal(resident.unplacedReplaces, 0)

  // The prompt at the LAST usage decides: input + cache read + cache write, so
  // R holds 300 (not its earlier step's 100) and U 500.
  assert.deepEqual(resident.tokens, { n: 2, p50: 500, p90: 500, max: 500, sum: 800 })
  // Only R named a context window: 300 of 2000.
  assert.deepEqual(resident.windowShare, { n: 1, p50: 15, p90: 15, max: 15, sum: 15 })
  assert.deepEqual(resident.compactions, { n: 2, p50: 1, p90: 1, max: 1, sum: 1 })
  assert.deepEqual(resident.prunes, { n: 2, p50: 1, p90: 1, max: 1, sum: 1 })

  // The calibration, per session then as a distribution: R's resident chars over
  // its 300 tokens, U's 44 over 500. U's 500 tokens are why it is not the p50.
  const rRatio = Math.round((R_CHARS / R_TOKENS) * 100) / 100
  const uRatio = Math.round((U_CHARS / U_TOKENS) * 100) / 100
  assert.equal(resident.chars, R_CHARS + U_CHARS)
  assert.deepEqual({ n: resident.charsPerToken.n, p50: resident.charsPerToken.p50, p90: resident.charsPerToken.p90, max: resident.charsPerToken.max }, { n: 2, p50: rRatio, p90: rRatio, max: rRatio })
  assert.ok(Math.abs(resident.charsPerToken.sum - (rRatio + uRatio)) < 1e-9)

  // The split, largest first: only what stood at the end. The shadowed stretch
  // (the first overview, the read, the first human message) and the 300-char
  // find answer its prune rewrote are gone; the run_code result stands alone,
  // its sub-call answer not beside it; the reasoning block is not in `assistant`.
  const total = R_CHARS + U_CHARS
  const share = (chars: number): number => Math.round((chars / total) * 1000) / 10
  const est = (inR: number, inU: number): number => Math.round((inR / R_CHARS) * R_TOKENS + (inU / U_CHARS) * U_TOKENS)
  assert.deepEqual(resident.contributors, [
    // The overview fixture (512 chars) now outsizes the run_code result (500): its
    // hub heading and row label both grew when the count became the source one.
    { name: 'codegraph overview', chars: OVERVIEW_V2.length, sharePct: share(OVERVIEW_V2.length), tokensEstimate: est(OVERVIEW_V2.length, 0) },
    { name: 'run_code', chars: R_SIZES.runCode, sharePct: share(R_SIZES.runCode), tokensEstimate: est(R_SIZES.runCode, 0) },
    { name: 'human', chars: R_SIZES.human + 40, sharePct: share(R_SIZES.human + 40), tokensEstimate: est(R_SIZES.human, 40) },
    { name: 'injected', chars: R_SIZES.injected, sharePct: share(R_SIZES.injected), tokensEstimate: est(R_SIZES.injected, 0) },
    { name: 'compaction summary', chars: R_SIZES.summary, sharePct: share(R_SIZES.summary), tokensEstimate: est(R_SIZES.summary, 0) },
    { name: 'assistant', chars: R_SIZES.assistant + 'done'.length, sharePct: share(R_SIZES.assistant + 'done'.length), tokensEstimate: est(R_SIZES.assistant, 'done'.length) },
    { name: 'codegraph find', chars: R_SIZES.found, sharePct: share(R_SIZES.found), tokensEstimate: est(R_SIZES.found, 0) },
    { name: 'system', chars: R_SIZES.system, sharePct: share(R_SIZES.system), tokensEstimate: est(R_SIZES.system, 0) },
    { name: 'harness:source', chars: R_SIZES.harness, sharePct: share(R_SIZES.harness), tokensEstimate: est(R_SIZES.harness, 0) },
  ])
  const names = resident.contributors.map((row: { name: string }) => row.name)
  for (const gone of ['read', 'task-context', 'unpaired', 'other']) assert.equal(names.includes(gone), false, `${gone} is shadowed and must not be resident`)
  assert.equal(names.some((name: string) => name.startsWith('ptc')), false, 'a run_code sub-call answer is inside the run_code result')
  // The estimates add up to the measured prompts, give or take the rounding.
  const estimated = resident.contributors.reduce((sum: number, row: { tokensEstimate: number }) => sum + row.tokensEstimate, 0)
  assert.ok(Math.abs(estimated - 800) <= resident.contributors.length)

  // The text report carries the same section, says the split is an estimate, and no sentinel.
  const text = run('usage-replay.mjs', ['--sessions', root, '--since', SINCE])
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /== resident context at session end:/u)
  assert.match(text.stdout, /sessions with a usage record=2 \(without=1\); prompt tokens at the last usage \(input \+ cache\): n=2 p50=500 p90=500 max=500/u)
  assert.match(text.stdout, /window share, percent of contextWindow \(sessions with a window\): n=1 p50=15 p90=15 max=15/u)
  assert.match(text.stdout, /compactions per session: n=2 p50=1 p90=1 max=1; pruned tool results per session: n=2 p50=1 p90=1 max=1/u)
  assert.match(text.stdout, new RegExp(`chars per resident token, per session: n=2 p50=${String(rRatio)} p90=${String(rRatio)} max=${String(rRatio)}`, 'u'))
  assert.match(text.stdout, /without a surface marker=0, replaces this reader could not place=0/u)
  assert.match(text.stdout, /tokens are measured; the split is by characters and converted at each session's own chars\/token/u)
  assert.match(text.stdout, new RegExp(`contributors by chars \\(share of resident chars, estimated tokens\\): codegraph overview ${String(OVERVIEW_V2.length)} \\(${String(share(OVERVIEW_V2.length))}%, ~${String(est(OVERVIEW_V2.length, 0))}\\), run_code ${String(R_SIZES.runCode)} \\(${String(share(R_SIZES.runCode))}%, ~${String(est(R_SIZES.runCode, 0))}\\)`, 'u'))
  for (const sentinel of SENTINELS) {
    assert.equal(text.stdout.includes(sentinel), false, `the text report echoes ${sentinel}`)
  }
})

/**
 * Session W: a read whose result holds an image, a first answer, a second answer
 * that a rewind then undoes. The window at the end is the first answer's, the
 * image is a placeholder, and the undone answer is not resident.
 */
function sessionRewound(): string[] {
  const s = new SessionLog(ALPHA)
  s.log(T + 1, 'step/start', { step: 1, turn: 1 })
  s.enter(T + 2, 'user/message', { role: 'user', content: [{ type: 'text', text: 'H'.repeat(40) }], source: { kind: 'user' } })
  s.log(T + 3, 'tool/call', { name: 'read_image', callId: 'c1', arguments: '{}', step: 1, turn: 1 })
  s.enter(T + 4, 'tool/result', { step: 1, turn: 1, message: { toolCallId: 'c1', isError: false, role: 'tool', content: [{ type: 'text', text: 'shot' }, { type: 'image', data: 'A'.repeat(5000) }] } })
  s.enter(T + 5, 'assistant/message', { step: 1, turn: 1, usage: { inputTokens: 100, cacheReadTokens: 200, outputTokens: 1, totalTokens: 301 }, message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] } })
  const later = s.enter(T + 6, 'assistant/message', { step: 2, turn: 1, usage: { inputTokens: 900, cacheReadTokens: 0, outputTokens: 1, totalTokens: 901 }, message: { role: 'assistant', content: [{ type: 'text', text: 'later' }] } })
  // The rewind: the second answer is replaced by the record of its undoing.
  s.replace(T + 7, 'user/message', { role: 'user', content: [{ type: 'text', text: 'undone' }], source: { kind: 'rewind' } }, later, later, [later])
  return s.lines
}

test('usage-replay prices the window the model still holds after a rewind, and counts an image as a placeholder', { skip }, () => {
  const root = scratchDir('dshcg-replay-rewound-')
  writeLog(root, 'rewound', sessionRewound(), 2)
  const ran = run('usage-replay.mjs', ['--sessions', root, '--since', SINCE, '--json'])
  assert.equal(ran.status, 0, `${ran.stderr}\n--- stdout ---\n${ran.stdout.slice(0, 600)}`)
  const resident = JSON.parse(ran.stdout).resident

  // The undone answer's usage (901) is not the window; the standing one's is.
  assert.deepEqual(resident.tokens, { n: 1, p50: 300, p90: 300, max: 300, sum: 300 })
  // Resident: the human message, the read (its text plus a 7-character
  // placeholder for the image, never the 5,000-character payload), the first
  // answer, and the rewind record; not `later`.
  assert.equal(resident.chars, 40 + 'shot'.length + '[image]'.length + 'first'.length + 'undone'.length)
  assert.equal(resident.sessionsWithMedia, 1)
  const byName = Object.fromEntries(resident.contributors.map((row: { name: string, chars: number }) => [row.name, row.chars]))
  assert.deepEqual(byName, { human: 40, 'read_image': 'shot'.length + '[image]'.length, assistant: 'first'.length, injected: 'undone'.length })
  const text = run('usage-replay.mjs', ['--sessions', root, '--since', SINCE])
  assert.match(text.stdout, /sessions with image or offload blocks \(each counted as a placeholder\)=1/u)
  assert.equal(text.stdout.includes('A'.repeat(50)), false, 'the image payload never reaches the report')
})

test('prefetch-replay resolves tokens against a constructed graph and reports the gate', { skip }, () => {
  const root = sessionsFixture()
  const home = graphFixture()
  const result = run('prefetch-replay.mjs', ['--sessions', root, '--since', SINCE, '--json'], home)
  const report = jsonOf(result, 'prefetch-replay')
  assert.equal(result.stderr.includes(home), true, 'the graph root is named on stderr')

  // Two sessions in the window; only ALPHA's project has a graph on disk, and
  // a session without one is skipped whole — B's message is not in any denominator.
  assert.equal(report.scope.files, 4)
  assert.equal(report.scope.skipped, 1)
  assert.deepEqual(report.sessions, { total: 2, withGraph: 1, noGraph: 1, openFailed: 0, noCwd: 0 })

  // Three of A's messages count, one is too short; all three carry a token; two pass the strict gate.
  const messages = report.messages
  assert.equal(messages.count, 3)
  assert.equal(messages.tooShort, 1)
  assert.equal(messages.withToken, 3)
  assert.equal(messages.withPath, 2)
  assert.equal(messages.withUniqueName, 1)
  assert.equal(messages.strictHits, 2)
  assert.deepEqual(
    { tokenPct: messages.tokenPct, pathPct: messages.pathPct, uniqueNamePct: messages.uniqueNamePct, strictPct: messages.strictPct },
    { tokenPct: 100, pathPct: 67, uniqueNamePct: 33, strictPct: 67 },
  )
  assert.deepEqual(messages.tokensPerMessage, { n: 3, p50: 2, p90: 2, max: 2, sum: 6 })
  assert.deepEqual(messages.consideredPerMessage, { n: 3, p50: 2, p90: 2, max: 2, sum: 6 })
  // The long message resolves two things (a file and a symbol), the suffix message one, the shared-only one none.
  assert.deepEqual(messages.resolvedPerMessage, { n: 3, p50: 1, p90: 2, max: 2, sum: 3 })

  // The length split: the one long message passes; one of two short ones does.
  assert.deepEqual(report.groups.long, { messages: 1, strict: 1, strictPct: 100, loose: 1, loosePct: 100 })
  assert.deepEqual(report.groups.short, { messages: 2, strict: 1, strictPct: 50, loose: 2, loosePct: 100 })

  // Tokens: an exact path and a bare name placed by its unique suffix hit; a
  // missing file does not; one name is unique, one shared, one undeclared.
  assert.deepEqual(report.tokens, { path: 3, absolutePath: 0, pathHit: 2, pathMiss: 1, identifier: 3, unique: 1, shared: 1, none: 1 })

  // The pack estimate: one file + one symbol for the long message, one file for the suffix one.
  assert.deepEqual(report.packChars.stats, { n: 2, p50: 680, p90: 680, max: 680, sum: 1140 })
  assert.match(report.packChars.basis, /estimate/u)

  // The text report carries the same gate numbers, and no token.
  const text = run('prefetch-replay.mjs', ['--sessions', root, '--since', SINCE], home)
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /strict gate \(either\)=2 \(67%\)/u)
  assert.match(text.stdout, /long messages \(>= 600 chars\)=1: strict gate 1 \(100%\)/u)
  assert.match(text.stdout, /short messages=2: strict gate 1 \(50%\)/u)
  for (const sentinel of SENTINELS) {
    assert.equal(text.stdout.includes(sentinel), false, `the text report echoes ${sentinel}`)
  }

  // A graph that is not a database is counted as failed to open, never read.
  const key = createHash('sha256').update(BETA).digest('hex').slice(0, 32)
  const betaGraph = join(home, 'storages', 'dsh-app-plugin-codegraph', 'projects', key, 'graph.db')
  mkdirSync(dirname(betaGraph), { recursive: true })
  writeFileSync(betaGraph, 'not a database')
  const broken = jsonOf(run('prefetch-replay.mjs', ['--sessions', root, '--since', SINCE, '--json'], home), 'prefetch-replay (broken graph)')
  assert.deepEqual(broken.sessions, { total: 2, withGraph: 1, noGraph: 0, openFailed: 1, noCwd: 0 })
  assert.deepEqual(broken.messages, report.messages)

  // The same exit-code contract as usage-replay.
  assert.equal(run('prefetch-replay.mjs', ['--sessions', root, '--since', '2999-01-01', '--json'], home).status, 0)
  assert.equal(run('prefetch-replay.mjs', ['--sessions', root, '--since', 'yesterday'], home).status, 2)
  assert.equal(run('prefetch-replay.mjs', ['--sessions', join(root, 'no-such-dir')], home).status, 2)
})
