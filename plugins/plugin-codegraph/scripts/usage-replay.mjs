#!/usr/bin/env node
/**
 * Replay the kernel's session logs and print what the code graph costs and
 * buys, in COUNTS and SIZES only.
 *
 *   node plugins/plugin-codegraph/scripts/usage-replay.mjs [--sessions <dir>] [--since YYYY-MM-DD] [--json]
 *
 *   --sessions   the sessions directory (default: <DSH home>/sessions; the DSH
 *                home is $DSH_HOME, else ~/.dsh)
 *   --since      count events from this date on (UTC midnight; default: the whole log)
 *   --json       the same data as one JSON object instead of the text report
 *
 * Exit codes: 0 (even when nothing was found to count), 2 for an argument it
 * cannot parse or a sessions directory it cannot read. The directory it read
 * is named on stderr, never in the report.
 *
 * ## Why this exists
 *
 * `docs/plans/codegraph-understanding-and-cost.md` rests its "current state"
 * numbers on one-off probes. This script is those probes, kept: the adoption
 * counts (A), the snapshot bill (B), the read shapes and the multiplier that
 * the overview's stability work (S1-S3), the answer budget (U3) and the
 * prefetch gate (R1) are decided against. Run it before and after a change and
 * compare the sections; a number that moved is the change's effect, a number
 * that did not is the change's blind spot.
 *
 * ## What it prints, and what it never does
 *
 * Counts, sizes in characters, tool names, contribution names and the line
 * class of a changed overview line. Never a message, a tool argument, a tool
 * answer, a symbol id or a file path: tool arguments are read for one property
 * each (does the read carry a line range; which path it reads — kept as a
 * counter key and dropped), and the overview text is only split into lines and
 * classified by its head. A redirect of stdout stays free of this machine's
 * conversations.
 *
 * ## What it relies on
 *
 * The kernel's session-log FORMAT, not anything this plugin owns: multi-frame
 * zstd, one JSON event per line, `tool/call` + `tool/result` paired by
 * `callId`, `tool/ptc-dispatch-start` + `tool/ptc-dispatch` paired by
 * `subCallId`, the runtime context as a `user/message` whose
 * `source.kind` is `runtime-context`. The reader is the repository root's
 * `scripts/lib/session-log.mjs`; when the kernel changes the format, the
 * counts change silently — check `parsed` against `files` first.
 *
 * Needs Node 22.15+ (`node:zlib` zstd support). Writes nothing.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { decompressFrames, listSessionLogs, parseEvents, parseSince } from '../../../scripts/lib/session-log.mjs'

const USAGE = 'usage: node plugins/plugin-codegraph/scripts/usage-replay.mjs [--sessions <dir>] [--since YYYY-MM-DD] [--json]'

/** The runtime-context contribution the overview arrives under (src/prompt.ts). */
const OVERVIEW = 'dsh-app:codegraph:overview'
const GRAPH_TOOL = /^codegraph_/u
/** The three tools this plugin registers; any other `codegraph_*` name is counted apart. */
const GRAPH_TOOLS = ['codegraph_find', 'codegraph_impact', 'codegraph_context']
/** The file tools whose answer sizes stand beside the graph's, for scale. */
const ANSWER_TOOLS = ['read', 'grep', 'glob', 'run_code']
/** The names a file read goes by, natively and inside run_code. */
const READ_TOOLS = new Set(['read', 'read_file'])
/** Argument keys a read uses to ask for a line range. */
const RANGE_KEYS = ['offset', 'limit', 'start_line', 'end_line', 'startLine', 'endLine', 'from', 'to', 'lines']
/** Upper edges (chars) of the read-size bands. */
const SIZE_BANDS = [2000, 5000, 10000, 20000, 50000]
/** The usage fields of an `assistant/message`. */
const TOKEN_KEYS = ['inputTokens', 'cacheReadTokens', 'outputTokens', 'totalTokens']
/** The overview's line classes, in report order. Classified by the line's head (see `lineClass`). */
const LINE_CLASSES = ['headline', 'status', 'note', 'scope', 'layout', 'entry', 'hub', 'other']
/** A contribution name is a code identifier; anything else is counted as `other` and never printed. */
const CONTRIBUTION_NAME = /^[\w.:-]+$/u

function fail(message) {
  process.stderr.write(`usage-replay: ${message}\n`)
  process.exit(2)
}

/** Where the kernel keeps its logs on this machine. */
function defaultSessions() {
  return join(resolveDshHome(), 'sessions')
}

const argv = process.argv.slice(2)
let sessionsDir = ''
let since = ''
let json = false
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg === '--help' || arg === '-h') {
    process.stdout.write(`${USAGE}\n`)
    process.exit(0)
  } else if (arg === '--sessions') {
    sessionsDir = argv[i + 1] ?? ''
    i += 1
  } else if (arg.startsWith('--sessions=')) {
    sessionsDir = arg.slice('--sessions='.length)
  } else if (arg === '--since') {
    since = argv[i + 1] ?? ''
    i += 1
  } else if (arg.startsWith('--since=')) {
    since = arg.slice('--since='.length)
  } else if (arg === '--json') {
    json = true
  } else fail(`unknown argument "${arg}"; ${USAGE}`)
}

let sinceMs = 0
if (since !== '') {
  try {
    sinceMs = parseSince(since)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}
// Unlike memory-usage.mjs, a missing directory is an error here: the default
// names a machine's own kernel, and a caller who typed a path wants to hear
// that it is wrong rather than read a green report of zeroes.
const root = resolve(sessionsDir === '' ? defaultSessions() : sessionsDir)
if (!existsSync(root)) fail(`--sessions does not exist: ${root}`)
if (!statSync(root).isDirectory()) fail(`--sessions must be a directory, got a file: ${root}`)

// The report on stdout carries counts only, so a redirect of it stays free of
// this machine's paths; where it read from goes to stderr.
process.stderr.write(`usage-replay: reading ${root}\n`)
const report = replay(listSessionLogs(root), sinceMs, since === '' ? 'beginning' : since)
process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${renderText(report)}\n`)

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

/**
 * Count every log under a root.
 * @param {string[]} files - the log files (`listSessionLogs`).
 * @param {number} sinceMs - count events at or after this epoch ms (0 = all).
 * @param {string} sinceLabel - `YYYY-MM-DD`, or `beginning` for the whole log.
 * @returns {ReturnType<emptyReport>} the report, every distribution already reduced to stats.
 */
function replay(files, sinceMs, sinceLabel) {
  const report = emptyReport(sinceLabel)
  // Collectors that are reduced to stats once every session is counted.
  const graphSizes = Object.fromEntries([...GRAPH_TOOLS, 'other'].map(name => [name, []]))
  const answerSizes = Object.fromEntries(ANSWER_TOOLS.map(name => [name, { native: [], ptc: [] }]))
  const snapshotChars = []
  const snapshotCharsWithOverview = []
  const overviewChars = []
  const repushesPerSession = []
  const repushesPerOverviewSession = []
  const partners = new Map()
  const readSizes = { native: [], ptc: [] }
  // Per-session repeat-read samples, per call form: `native`, `ptc`, and the two together.
  const perSessionRepeats = { native: [], ptc: [], all: [] }
  const perSessionMaxReads = { native: [], ptc: [], all: [] }
  const multipliers = []
  const lineClassVersions = Object.fromEntries(LINE_CLASSES.map(name => [name, 0]))
  const lineClassLines = Object.fromEntries(LINE_CLASSES.map(name => [name, 0]))

  for (const file of files) {
    report.scope.files += 1
    let events
    try {
      const decoded = decompressFrames(readFileSync(file))
      // No frame decoded is not a log this reader understands, not an empty one.
      if (decoded.frames === 0) throw new Error('no zstd frame decoded')
      if (decoded.truncated) report.scope.truncated += 1
      const parsed = parseEvents(decoded.text)
      report.scope.lines += parsed.lines
      report.scope.unparsable += parsed.unparsable
      events = parsed.events
    } catch (error) {
      // One bad log must not take the rest of the history with it; it is
      // counted, and named on stderr so a low total has a visible reason.
      report.scope.skipped += 1
      process.stderr.write(`usage-replay: skipped a log that could not be decoded: ${file} (${error instanceof Error ? error.message : String(error)})\n`)
      continue
    }
    report.scope.parsed += 1
    countSession(report, events, sinceMs, {
      graphSizes, answerSizes, snapshotChars, snapshotCharsWithOverview, overviewChars,
      repushesPerSession, repushesPerOverviewSession, partners, readSizes,
      perSessionRepeats, perSessionMaxReads, multipliers, lineClassVersions, lineClassLines,
    })
  }
  if (report.scope.skipped > 0) process.stderr.write(`usage-replay: skipped ${String(report.scope.skipped)} log(s) that could not be decoded\n`)

  for (const name of GRAPH_TOOLS) report.adoption.byTool[name].answers = stats(graphSizes[name])
  report.adoption.byTool.other.answers = stats(graphSizes.other)
  for (const name of ANSWER_TOOLS) {
    const sizes = answerSizes[name]
    report.answers[name].native.answers = stats(sizes.native)
    report.answers[name].ptc.answers = stats(sizes.ptc)
    report.answers[name].all = stats([...sizes.native, ...sizes.ptc])
  }
  const snap = report.snapshots
  snap.perSession = stats(repushesPerSession)
  snap.perSessionWithOverview = stats(repushesPerOverviewSession)
  snap.snapshotChars = stats(snapshotChars)
  snap.snapshotCharsWithOverview = stats(snapshotCharsWithOverview)
  snap.overviewChars = stats(overviewChars)
  snap.changedPartners = [...partners.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([name, count]) => ({ name, count }))
  for (const name of LINE_CLASSES) {
    snap.lineClasses[name] = { versions: lineClassVersions[name], lines: lineClassLines[name] }
  }
  const exp = report.explore
  exp.reads.native.answers = stats(readSizes.native)
  exp.reads.ptc.answers = stats(readSizes.ptc)
  exp.reads.all = stats([...readSizes.native, ...readSizes.ptc])
  exp.reads.bands = bandsOf([...readSizes.native, ...readSizes.ptc])
  exp.reads.allCalls = exp.reads.native.calls + exp.reads.ptc.calls
  exp.reads.allWithRange = exp.reads.native.withRange + exp.reads.ptc.withRange
  exp.reads.withRangePct = {
    native: pct(exp.reads.native.withRange, exp.reads.native.calls),
    ptc: pct(exp.reads.ptc.withRange, exp.reads.ptc.calls),
    all: pct(exp.reads.allWithRange, exp.reads.allCalls),
  }
  for (const kind of ['native', 'ptc', 'all']) {
    const row = exp.repeatReads[kind]
    row.sharePct = row.reads === 0 ? 0 : Math.round((row.repeats / row.reads) * 100)
    row.perSessionRepeats = stats(perSessionRepeats[kind])
    row.perSessionMaxReadsOfOnePath = stats(perSessionMaxReads[kind])
  }
  report.multiplier.perSession = stats(multipliers)
  report.multiplier.factor = report.multiplier.appendedChars === 0 ? 0 : report.multiplier.rereadChars / report.multiplier.appendedChars
  return report
}

/** A fresh report, every count zero and every distribution empty. */
function emptyReport(sinceLabel) {
  const answer = () => ({ calls: 0, errors: 0, answers: stats([]) })
  const reads = () => ({ calls: 0, withRange: 0, answers: stats([]) })
  const repeats = () => ({
    reads: 0, paths: 0, repeats: 0, sharePct: 0, maxReadsOfOnePath: 0,
    perSessionRepeats: stats([]), perSessionMaxReadsOfOnePath: stats([]),
  })
  return {
    scope: { since: sinceLabel, files: 0, parsed: 0, skipped: 0, truncated: 0, lines: 0, unparsable: 0 },
    adoption: {
      sessions: 0, steps: 0, sessionsWithOverview: 0, sessionsWithGraphTool: 0, graphToolCalls: 0,
      byTool: Object.fromEntries([...GRAPH_TOOLS, 'other'].map(name => [name, answer()])),
    },
    answers: Object.fromEntries(ANSWER_TOOLS.map(name => [name, { native: answer(), ptc: answer(), all: stats([]) }])),
    snapshots: {
      repushes: 0, repushesWithOverview: 0, overviewChanged: 0, otherOnly: 0, unchanged: 0,
      overviewChangedRereadChars: 0, otherOnlyRereadChars: 0, overviewShareOfOtherOnlyRereadChars: 0,
      perSession: stats([]), perSessionWithOverview: stats([]),
      snapshotChars: stats([]), snapshotCharsWithOverview: stats([]), overviewChars: stats([]),
      versionsCompared: 0,
      lineClasses: Object.fromEntries(LINE_CLASSES.map(name => [name, { versions: 0, lines: 0 }])),
      changedPartners: [],
    },
    explore: {
      mode: { nativeOnly: 0, ptcOnly: 0, both: 0, neither: 0 },
      reads: { native: reads(), ptc: reads(), all: stats([]), allCalls: 0, allWithRange: 0, bands: {}, withRangePct: {} },
      repeatReads: { native: repeats(), ptc: repeats(), all: repeats() },
      sessionsWithToolCalls: 0, firstSixAllRunCode: 0,
    },
    multiplier: { appendedChars: 0, rereadChars: 0, factor: 0, sessionsAtLeast20Steps: 0, perSession: stats([]) },
    tokens: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0 },
  }
}

/**
 * Count one session's events at or after `sinceMs`.
 * @param {ReturnType<emptyReport>} report - the report to add to.
 * @param {Record<string, unknown>[]} events - the whole log, header first.
 * @param {number} sinceMs - the window's start.
 * @param {object} collectors - the per-sample arrays the caller reduces afterwards.
 */
function countSession(report, events, sinceMs, c) {
  const fresh = events.filter(event => typeof event.time === 'number' && event.time >= sinceMs)
  if (fresh.length === 0) return
  const native = new Map() // callId -> tool name
  const ptc = new Map() // subCallId -> tool name
  const appended = [] // { step, size }: every tool answer, paired or not
  const pushes = [] // { step, chars, overviewChars, overviewChanged, changed }
  const readsByPath = { native: new Map(), ptc: new Map() }
  const sequence = [] // the native tool calls, in order
  let previous // the previous snapshot's sections, name -> text
  let lastOverview
  let step = 0
  let sawOverview = false
  let calledGraph = false
  let sawNative = false
  let sawPtc = false
  let repushesHere = 0
  let graphCallsHere = 0

  const graphCall = name => {
    calledGraph = true
    graphCallsHere += 1
    report.adoption.byTool[GRAPH_TOOLS.includes(name) ? name : 'other'].calls += 1
  }
  const recordAnswer = (row, isError) => {
    if (isError === true) row.errors += 1
  }
  const readPath = (map, args) => {
    const path = typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : typeof args.filePath === 'string' ? args.filePath : '?'
    map.set(path, (map.get(path) ?? 0) + 1)
  }

  for (const event of fresh) {
    const data = isRecord(event.data) ? event.data : {}
    if (event.type === 'step/start') {
      step += 1
    } else if (event.type === 'tool/call') {
      const name = toolName(data)
      sawNative = true
      native.set(String(data.callId), name)
      sequence.push(name)
      if (ANSWER_TOOLS.includes(name)) report.answers[name].native.calls += 1
      if (READ_TOOLS.has(name)) {
        report.explore.reads.native.calls += 1
        if (hasRange(callArguments(data))) report.explore.reads.native.withRange += 1
        readPath(readsByPath.native, callArguments(data))
      }
      if (GRAPH_TOOL.test(name)) graphCall(name)
    } else if (event.type === 'tool/ptc-dispatch-start') {
      const name = toolName(data)
      sawPtc = true
      ptc.set(String(data.subCallId), name)
      if (ANSWER_TOOLS.includes(name)) report.answers[name].ptc.calls += 1
      if (READ_TOOLS.has(name)) {
        report.explore.reads.ptc.calls += 1
        if (hasRange(data.arguments)) report.explore.reads.ptc.withRange += 1
        readPath(readsByPath.ptc, isRecord(data.arguments) ? data.arguments : {})
      }
      if (GRAPH_TOOL.test(name)) graphCall(name)
    } else if (event.type === 'tool/result') {
      const message = isRecord(data.message) ? data.message : {}
      const size = textOf(message.content).length
      appended.push({ step, size })
      // An answer whose call predates --since has no name here: it still
      // counts toward the multiplier, and toward no tool. One call may also
      // log two results (measured: 85 run_code calls with a pair), so a tool's
      // answers may outnumber its calls by a little.
      const name = native.get(String(message.toolCallId))
      if (name === undefined) continue
      const isError = message.isError === true
      if (ANSWER_TOOLS.includes(name)) {
        recordAnswer(report.answers[name].native, isError)
        c.answerSizes[name].native.push(size)
      }
      if (READ_TOOLS.has(name)) c.readSizes.native.push(size)
      if (GRAPH_TOOL.test(name)) {
        recordAnswer(report.adoption.byTool[GRAPH_TOOLS.includes(name) ? name : 'other'], isError)
        c.graphSizes[GRAPH_TOOLS.includes(name) ? name : 'other'].push(size)
      }
    } else if (event.type === 'tool/ptc-dispatch') {
      const size = textOf(data.content).length
      appended.push({ step, size })
      const name = ptc.get(String(data.subCallId))
      if (name === undefined) continue
      const isError = data.isError === true
      if (ANSWER_TOOLS.includes(name)) {
        recordAnswer(report.answers[name].ptc, isError)
        c.answerSizes[name].ptc.push(size)
      }
      if (READ_TOOLS.has(name)) c.readSizes.ptc.push(size)
      if (GRAPH_TOOL.test(name)) {
        recordAnswer(report.adoption.byTool[GRAPH_TOOLS.includes(name) ? name : 'other'], isError)
        c.graphSizes[GRAPH_TOOLS.includes(name) ? name : 'other'].push(size)
      }
    } else if (event.type === 'assistant/message') {
      const usage = isRecord(data.usage) ? data.usage : {}
      for (const key of TOKEN_KEYS) {
        const value = Number(usage[key])
        if (Number.isFinite(value)) report.tokens[key] += value
      }
    } else if (event.type === 'user/message' && isRecord(data.source) && data.source.kind === 'runtime-context') {
      const sections = Array.isArray(data.source.sections) ? data.source.sections : []
      const current = new Map(sections.filter(isRecord).map(section => [String(section.name), typeof section.text === 'string' ? section.text : '']))
      const text = textOf(data.content)
      const overview = current.get(OVERVIEW)
      const hasOverview = overview !== undefined && overview !== ''
      if (previous !== undefined) {
        // A re-push: the second snapshot of the session onward. The first
        // snapshot is the context being sent, not sent again.
        repushesHere += 1
        report.snapshots.repushes += 1
        c.snapshotChars.push(text.length)
        const changed = [...new Set([...current.keys(), ...previous.keys()])].filter(name => current.get(name) !== previous.get(name))
        if (hasOverview) {
          report.snapshots.repushesWithOverview += 1
          c.snapshotCharsWithOverview.push(text.length)
          const overviewChanged = changed.includes(OVERVIEW)
          pushes.push({ step, chars: text.length, overviewChars: overview.length, overviewChanged, changed: changed.filter(name => name !== OVERVIEW) })
          if (overviewChanged && lastOverview !== undefined && overview !== lastOverview) {
            report.snapshots.versionsCompared += 1
            // A multiset difference, so a line inserted above ten unchanged
            // lines is one change, not eleven.
            const { added, removed } = multisetDiff(lastOverview.split('\n'), overview.split('\n'))
            const touched = new Set()
            for (const line of added) { touched.add(lineClass(line)); c.lineClassLines[lineClass(line)] += 1 }
            for (const line of removed) { touched.add(lineClass(line)); c.lineClassLines[lineClass(line)] += 1 }
            for (const name of touched) c.lineClassVersions[name] += 1
          }
        }
      }
      if (hasOverview) {
        sawOverview = true
        lastOverview = overview
        c.overviewChars.push(overview.length)
      }
      previous = current
    }
  }

  report.adoption.sessions += 1
  report.adoption.steps += step
  report.adoption.graphToolCalls += graphCallsHere
  if (sawOverview) report.adoption.sessionsWithOverview += 1
  if (calledGraph) report.adoption.sessionsWithGraphTool += 1
  report.explore.mode[sawNative && sawPtc ? 'both' : sawNative ? 'nativeOnly' : sawPtc ? 'ptcOnly' : 'neither'] += 1
  if (repushesHere > 0) c.repushesPerSession.push(repushesHere)
  // Every session with an overview, zero re-pushes included: the count is
  // "how often does a session that got an overview get it again".
  if (sawOverview) c.repushesPerOverviewSession.push(repushesHere)

  // The bill of each re-push under this session's own multiplier: every step
  // after the push reads the whole snapshot again.
  for (const push of pushes) {
    const later = Math.max(0, step - push.step)
    if (push.overviewChanged) {
      report.snapshots.overviewChanged += 1
      report.snapshots.overviewChangedRereadChars += push.chars * later
    } else {
      report.snapshots.otherOnly += 1
      if (push.changed.length === 0) report.snapshots.unchanged += 1
      report.snapshots.otherOnlyRereadChars += push.chars * later
      report.snapshots.overviewShareOfOtherOnlyRereadChars += push.overviewChars * later
    }
    for (const name of push.changed) {
      const key = CONTRIBUTION_NAME.test(name) ? name : 'other'
      c.partners.set(key, (c.partners.get(key) ?? 0) + 1)
    }
  }

  // The multiplier: chars appended by a tool answer x the steps that came after it.
  let reread = 0
  let appendedChars = 0
  for (const entry of appended) {
    appendedChars += entry.size
    reread += entry.size * Math.max(0, step - entry.step)
  }
  report.multiplier.appendedChars += appendedChars
  report.multiplier.rereadChars += reread
  if (step >= 20 && appendedChars > 0) {
    report.multiplier.sessionsAtLeast20Steps += 1
    // One decimal: the number is a ratio, and the text report prints it bare.
    c.multipliers.push(Math.round((reread / appendedChars) * 10) / 10)
  }

  // Re-reading: the second read of a path onward, per call form and together.
  const combined = new Map()
  for (const kind of ['native', 'ptc']) {
    for (const [path, count] of readsByPath[kind]) combined.set(path, (combined.get(path) ?? 0) + count)
  }
  for (const [kind, map] of [['native', readsByPath.native], ['ptc', readsByPath.ptc], ['all', combined]]) {
    const row = report.explore.repeatReads[kind]
    for (const count of map.values()) {
      row.reads += count
      row.paths += 1
      row.repeats += Math.max(0, count - 1)
      row.maxReadsOfOnePath = Math.max(row.maxReadsOfOnePath, count)
    }
    if (map.size > 0) {
      const counts = [...map.values()]
      c.perSessionRepeats[kind].push(counts.reduce((total, count) => total + Math.max(0, count - 1), 0))
      c.perSessionMaxReads[kind].push(Math.max(...counts))
    }
  }

  // The opening sequence: native calls only — a sub-call sits inside a run_code
  // call the model already made.
  if (sequence.length > 0) {
    report.explore.sessionsWithToolCalls += 1
    if (sequence.length >= 6 && sequence.slice(0, 6).every(name => name === 'run_code')) report.explore.firstSixAllRunCode += 1
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toolName(data) {
  return typeof data.name === 'string' ? data.name : ''
}

/** A call's arguments, whether the log wrote them as an object or as JSON text. */
function callArguments(data) {
  const raw = data.arguments
  if (isRecord(raw)) return raw
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** Whether a read's arguments name a line range. */
function hasRange(args) {
  return RANGE_KEYS.some(key => key in args)
}

/**
 * The text of a content value, as the model receives it: the text blocks
 * joined; any other block (an image) by its JSON length, since the model pays
 * for it too; a plain string as itself.
 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(isRecord).map(block => (block.type === 'text' ? String(block.text ?? '') : JSON.stringify(block))).join('')
}

/** The multiset difference of two line lists: lines added, lines removed. */
function multisetDiff(before, after) {
  const remaining = new Map()
  for (const line of before) remaining.set(line, (remaining.get(line) ?? 0) + 1)
  const added = []
  for (const line of after) {
    const count = remaining.get(line) ?? 0
    if (count > 0) remaining.set(line, count - 1)
    else added.push(line)
  }
  const removed = [...remaining.entries()].flatMap(([line, count]) => Array.from({ length: count }, () => line))
  return { added, removed }
}

/**
 * The class of an overview line, by its head — the shape src/prompt.ts
 * writes. A `- ` row is a hub row when it carries a symbol id (`#<kind>:` in
 * it) and an entry row otherwise; the static guidance rows share the entry
 * class and never vary, so they show up only when a whole block appears.
 */
function lineClass(line) {
  if (/^Code graph for this project/u.test(line)) return 'headline'
  if (/^Code graph:/u.test(line)) return 'status'
  if (/^note:/u.test(line)) return 'note'
  if (/^Covers the project/u.test(line)) return 'scope'
  if (/^Top-level layout/u.test(line)) return 'layout'
  if (line.startsWith('- ')) return /#[^:]*:/u.test(line) ? 'hub' : 'entry'
  return 'other'
}

/** n / p50 / p90 / max / sum, the percentile taken as the nearest rank. */
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = p => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))])
  return { n: sorted.length, p50: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1] ?? 0, sum: sorted.reduce((total, value) => total + value, 0) }
}

/** How many values fall in each size band: `<=edge` up to each edge, then the rest. */
function bandsOf(values) {
  const bands = {}
  let low = -1
  for (const edge of SIZE_BANDS) {
    bands[low < 0 ? `<=${String(edge)}` : `${String(low + 1)}-${String(edge)}`] = values.filter(value => value <= edge && value > low).length
    low = edge
  }
  bands[`>${String(low)}`] = values.filter(value => value > low).length
  return bands
}

function pct(part, whole) {
  return whole === 0 ? 0 : Math.round((part / whole) * 100)
}

// ---------------------------------------------------------------------------
// The text report
// ---------------------------------------------------------------------------

/** A count large enough to read better in millions. */
function big(value) {
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : String(value)
}

/** `n=… p50=… p90=… max=…` of one distribution. */
function dist(row) {
  return `n=${String(row.n)} p50=${String(row.p50)} p90=${String(row.p90)} max=${String(row.max)}`
}

/** `key=value` items, largest count first. */
function ranked(entries) {
  return entries.map(entry => `${entry.name} ${String(entry.count)}`).join(', ')
}

/** The report as text: the same data as the JSON, one section per heading. */
function renderText(report) {
  const { scope, adoption, answers, snapshots: snap, explore, multiplier, tokens } = report
  const lines = [
    `usage-replay: kernel session logs (session.v4.jsonl.zstd)  since=${scope.since}`,
    `files=${String(scope.files)} parsed=${String(scope.parsed)} skipped=${String(scope.skipped)} truncated=${String(scope.truncated)} lines=${String(scope.lines)} unparsable=${String(scope.unparsable)}`,
    '',
    '== adoption',
    `sessions=${String(adoption.sessions)} steps=${String(adoption.steps)}`,
    `sessions whose runtime context carried a code-graph overview=${String(adoption.sessionsWithOverview)}`,
    `sessions that called a codegraph_* tool=${String(adoption.sessionsWithGraphTool)} (calls=${String(adoption.graphToolCalls)})`,
  ]
  for (const [name, row] of Object.entries(adoption.byTool)) {
    lines.push(`${name}: calls=${String(row.calls)} answers ${dist(row.answers)} errors=${String(row.errors)}`)
  }
  lines.push('', '== answers (chars): the file tools beside the graph, native and inside run_code')
  for (const [name, row] of Object.entries(answers)) {
    lines.push(`${name}: native calls=${String(row.native.calls)} answers ${dist(row.native.answers)} errors=${String(row.native.errors)} | in run_code calls=${String(row.ptc.calls)} answers ${dist(row.ptc.answers)} errors=${String(row.ptc.errors)} | all ${dist(row.all)}`)
  }
  lines.push(
    '',
    '== snapshots (runtime context): a re-push is any snapshot after the first',
    `re-pushes=${String(snap.repushes)}; carrying an overview=${String(snap.repushesWithOverview)} (overview text itself changed=${String(snap.overviewChanged)}, only other contributions changed=${String(snap.otherOnly)}, nothing changed=${String(snap.unchanged)})`,
    `re-pushes per session, sessions with a re-push: ${dist(snap.perSession)}`,
    `re-pushes per session, sessions with an overview: ${dist(snap.perSessionWithOverview)}`,
    `whole snapshot chars per re-push: ${dist(snap.snapshotChars)}; with an overview: ${dist(snap.snapshotCharsWithOverview)}`,
    `overview chars per snapshot: ${dist(snap.overviewChars)}`,
    `reread under each session's multiplier (chars x later steps): overview changed ${big(snap.overviewChangedRereadChars)}; only others changed ${big(snap.otherOnlyRereadChars)}, of which the overview rode along for ${big(snap.overviewShareOfOtherOnlyRereadChars)}`,
    `other contributions that changed alongside or instead (count): ${snap.changedPartners.length === 0 ? '(none)' : ranked(snap.changedPartners)}`,
    `overview versions compared=${String(snap.versionsCompared)}; line classes touched (versions / lines added or removed): ${Object.entries(snap.lineClasses).map(([name, row]) => `${name} ${String(row.versions)}/${String(row.lines)}`).join(', ')}`,
    '',
    '== explore: how the model reads',
    `sessions by call form: native only=${String(explore.mode.nativeOnly)} run_code only=${String(explore.mode.ptcOnly)} both=${String(explore.mode.both)} no tool call=${String(explore.mode.neither)}`,
    `reads native=${String(explore.reads.native.calls)} (with a line range=${String(explore.reads.native.withRange)}, ${String(explore.reads.withRangePct.native)}%); in run_code=${String(explore.reads.ptc.calls)} (with a line range=${String(explore.reads.ptc.withRange)}, ${String(explore.reads.withRangePct.ptc)}%); all=${String(explore.reads.allCalls)} (${String(explore.reads.withRangePct.all)}% with a range)`,
    `read answer chars: native ${dist(explore.reads.native.answers)}; in run_code ${dist(explore.reads.ptc.answers)}; all ${dist(explore.reads.all)}`,
    `read answer chars by band (all reads): ${Object.entries(explore.reads.bands).map(([band, count]) => `${band}: ${String(count)}`).join(' | ')}`,
    ...['native', 'ptc', 'all'].map(kind => {
      const row = explore.repeatReads[kind]
      return `repeat reads of one path in a session (${kind}): ${String(row.repeats)} of ${String(row.reads)} (${String(row.sharePct)}%), one path read at most ${String(row.maxReadsOfOnePath)} times; per session with reads: repeats ${dist(row.perSessionRepeats)}, most reads of one path ${dist(row.perSessionMaxReadsOfOnePath)}`
    }),
    `sessions with a tool call=${String(explore.sessionsWithToolCalls)}; first six calls all run_code=${String(explore.firstSixAllRunCode)}`,
    '',
    '== multiplier: every tool answer x the steps after it',
    `tool answer chars appended=${big(multiplier.appendedChars)}; reread by later steps, summed=${big(multiplier.rereadChars)} (x${multiplier.factor.toFixed(1)})`,
    `later rereads per appended char, sessions with >= 20 steps (${String(multiplier.sessionsAtLeast20Steps)}): ${dist(multiplier.perSession)}`,
    '',
    '== tokens (assistant/message usage, summed)',
    `inputTokens=${String(tokens.inputTokens)} cacheReadTokens=${String(tokens.cacheReadTokens)} outputTokens=${String(tokens.outputTokens)} totalTokens=${String(tokens.totalTokens)}`,
  )
  return lines.join('\n')
}
