#!/usr/bin/env node
/**
 * Calibrate the request pre-fetch gate (plan item R1): for every message a
 * person wrote, how often does it name something the code graph can resolve —
 * a file path the graph holds, or an identifier with exactly one declaration —
 * and how big would the bounded "starter pack" for those be? COUNTS and sizes
 * only: no token and no message text is ever printed.
 *
 *   node plugins/plugin-codegraph/scripts/prefetch-replay.mjs [--sessions <dir>] [--since YYYY-MM-DD] [--json]
 *
 *   --sessions   the sessions directory (default: <DSH home>/sessions; the DSH
 *                home is $DSH_HOME, else ~/.dsh)
 *   --since      count messages from this date on (UTC midnight; default: the whole log)
 *   --json       the same data as one JSON object instead of the text report
 *
 * Exit codes: 0 (even when nothing was found to count), 2 for an argument it
 * cannot parse or a sessions directory it cannot read. The directory it read
 * is named on stderr, never in the report.
 *
 * ## Why this exists
 *
 * `docs/plans/codegraph-understanding-and-cost.md` decides to attach a pack
 * to a request only when the message names a held file or a UNIQUELY declared
 * identifier, on the strength of four numbers this script reproduces: the
 * share of messages carrying a code-shaped token, the strict gate's hit rate
 * overall and split by message length, the identifier/path hit split, and
 * the projected pack size. Move the token rule, the uniqueness rule, the
 * 14-token cap or the length threshold, and compare against a previous run.
 *
 * ## What it prints, and what it never does
 *
 * Counts, rates and sizes in characters. A token — a path, an identifier — is
 * looked up and dropped; it is never written out. The only strings in the
 * report are the fixed row names.
 *
 * ## What it relies on
 *
 *   - the kernel's session-log FORMAT (multi-frame zstd; the header's `cwd`
 *     is the session's project, verbatim), read with the repository root's
 *     `scripts/lib/session-log.mjs`;
 *   - the plugin's graph layout: `<DSH home>/storages/dsh-app-plugin-codegraph/
 *     projects/<sha256(cwd)[:32]>/graph.db`, the key `graphPathFor` in
 *     src/index.ts derives; `files.path` holds project-relative POSIX paths,
 *     `symbols.name` the declared names. Each graph is opened READ-ONLY: the
 *     running kernel owns it, and a replay must never write into it.
 *
 * A session whose project has no graph now, or whose graph will not open, is
 * counted and skipped — it says nothing about the gate, which only fires
 * against a ready graph. Needs a Node with `node:sqlite` (unflagged since
 * 22.13). Writes nothing.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { decompressFrames, listSessionLogs, parseEvents, parseSince } from '../../../scripts/lib/session-log.mjs'

const USAGE = 'usage: node plugins/plugin-codegraph/scripts/prefetch-replay.mjs [--sessions <dir>] [--since YYYY-MM-DD] [--json]'

/** Where the plugin keeps its graphs, under the DSH home. */
const GRAPH_STORAGE = join('storages', 'dsh-app-plugin-codegraph')
/** Tokens looked up per message, after deduplication (the gate's own cap). */
const MAX_TOKENS_PER_MESSAGE = 14
/** A message shorter than this is a nudge ("ok", "go on"), not a request: not counted. */
const MIN_MESSAGE_CHARS = 8
/** The plan's length split: a long request against a short remark. */
const LONG_MESSAGE_CHARS = 600
/** The projected pack, in characters: a fixed overhead, then one row per resolved file and per resolved symbol, capped. */
const PACK_OVERHEAD_CHARS = 160
const PACK_FILE_CHARS = 300
const PACK_SYMBOL_CHARS = 220
const PACK_MAX_FILES = 3
const PACK_MAX_SYMBOLS = 3

/**
 * Code-shaped tokens: a path with a code or document extension, a camelCase /
 * PascalCase identifier, a snake_case identifier, a SCREAMING_SNAKE_CASE constant.
 * The same five alternatives as `src/prefetch.ts` (which explains two things this
 * copy leaves out: the lookbehind, since no drive letter reaches it here, and why
 * a hump is `[a-z0-9]*` and not `[a-zA-Z0-9]*` — the latter re-partitions on
 * failure and blows up exponentially). English prose words and Chinese text
 * yield nothing.
 */
const TOKEN = /(?:[\w.-]+\/)*[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|vue|svelte|json|ya?ml|md|css|scss|py|go|rs|java|kt|swift|cs|rb|php|c|cc|cpp|h|hpp|sh|ps1)\b|\b[a-z]+(?:[A-Z][a-z0-9]*)+\b|\b[A-Z][a-z]+(?:[A-Z][a-z0-9]*)+\b|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/gu
/** The extensions that make a bare word a path. */
const EXT = /\.(?:tsx?|jsx?|mjs|cjs|vue|svelte|json|ya?ml|md|css|scss|py|go|rs|java|kt|swift|cs|rb|php|c|cc|cpp|h|hpp|sh|ps1)$/u
/**
 * Product names the identifier patterns match and no project declares. They
 * are mention-worthy, not look-up-able; counting them as "a code-shaped token"
 * would inflate that share with messages that name nothing of the project's.
 */
const STOP = new Set(['DeepSeek', 'GitHub', 'PowerShell', 'TypeScript', 'JavaScript', 'ZCode', 'Markdown', 'OpenAI'])

function fail(message) {
  process.stderr.write(`prefetch-replay: ${message}\n`)
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
const home = resolveDshHome()
const root = resolve(sessionsDir === '' ? join(home, 'sessions') : sessionsDir)
if (!existsSync(root)) fail(`--sessions does not exist: ${root}`)
if (!statSync(root).isDirectory()) fail(`--sessions must be a directory, got a file: ${root}`)

// The report on stdout carries counts only; where it read from goes to stderr.
process.stderr.write(`prefetch-replay: reading ${root}; graphs under ${join(home, GRAPH_STORAGE)}\n`)
const report = replay(listSessionLogs(root), sinceMs, since === '' ? 'beginning' : since, home)
process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${renderText(report)}\n`)

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

/**
 * Calibrate the gate over every log under a root.
 * @param {string[]} files - the log files (`listSessionLogs`).
 * @param {number} sinceMs - count events at or after this epoch ms (0 = all).
 * @param {string} sinceLabel - `YYYY-MM-DD`, or `beginning` for the whole log.
 * @param {string} home - the DSH home, under which the graphs live.
 * @returns {object} the report.
 */
function replay(files, sinceMs, sinceLabel, home) {
  const report = emptyReport(sinceLabel)
  const graphs = new Map() // cwd -> { db, statements } | { reason }
  const tokensPer = []
  const consideredPer = []
  const resolvedPer = []
  const packChars = []
  try {
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
        report.scope.skipped += 1
        process.stderr.write(`prefetch-replay: skipped a log that could not be decoded: ${file} (${error instanceof Error ? error.message : String(error)})\n`)
        continue
      }
      report.scope.parsed += 1
      const fresh = events.filter(event => typeof event.time === 'number' && event.time >= sinceMs)
      if (fresh.length === 0) continue
      report.sessions.total += 1
      const header = isRecord(events[0]) ? events[0] : {}
      const cwd = typeof header.cwd === 'string' ? header.cwd : ''
      if (cwd === '') {
        report.sessions.noCwd += 1
        continue
      }
      if (!graphs.has(cwd)) graphs.set(cwd, openGraphFor(cwd, home))
      const graph = graphs.get(cwd)
      if (graph.reason === 'missing') { report.sessions.noGraph += 1; continue }
      if (graph.reason === 'failed') { report.sessions.openFailed += 1; continue }
      report.sessions.withGraph += 1
      countSession(report, fresh, cwd, graph, { tokensPer, consideredPer, resolvedPer, packChars })
    }
  } finally {
    // Opened read-only, but a handle is a handle: every one is closed, also on a throw.
    for (const graph of graphs.values()) graph.db?.close()
  }
  if (report.scope.skipped > 0) process.stderr.write(`prefetch-replay: skipped ${String(report.scope.skipped)} log(s) that could not be decoded\n`)

  report.messages.tokensPerMessage = stats(tokensPer)
  report.messages.consideredPerMessage = stats(consideredPer)
  report.messages.resolvedPerMessage = stats(resolvedPer)
  report.messages.tokenPct = pct(report.messages.withToken, report.messages.count)
  report.messages.pathPct = pct(report.messages.withPath, report.messages.count)
  report.messages.uniqueNamePct = pct(report.messages.withUniqueName, report.messages.count)
  report.messages.strictPct = pct(report.messages.strictHits, report.messages.count)
  for (const group of Object.values(report.groups)) {
    group.strictPct = pct(group.strict, group.messages)
    group.loosePct = pct(group.loose, group.messages)
  }
  report.packChars.stats = stats(packChars)
  return report
}

/** A fresh report, every count zero. */
function emptyReport(sinceLabel) {
  const group = () => ({ messages: 0, strict: 0, strictPct: 0, loose: 0, loosePct: 0 })
  return {
    scope: { since: sinceLabel, files: 0, parsed: 0, skipped: 0, truncated: 0, lines: 0, unparsable: 0 },
    sessions: { total: 0, withGraph: 0, noGraph: 0, openFailed: 0, noCwd: 0 },
    messages: {
      count: 0, tooShort: 0, withToken: 0, withPath: 0, withUniqueName: 0, strictHits: 0,
      tokenPct: 0, pathPct: 0, uniqueNamePct: 0, strictPct: 0,
      tokensPerMessage: stats([]), consideredPerMessage: stats([]), resolvedPerMessage: stats([]),
    },
    groups: { long: group(), short: group() },
    tokens: { path: 0, absolutePath: 0, pathHit: 0, pathMiss: 0, identifier: 0, unique: 0, shared: 0, none: 0 },
    packChars: {
      basis: `estimate: ${String(PACK_OVERHEAD_CHARS)} overhead + ${String(PACK_FILE_CHARS)} per file (at most ${String(PACK_MAX_FILES)}) + ${String(PACK_SYMBOL_CHARS)} per symbol (at most ${String(PACK_MAX_SYMBOLS)})`,
      stats: stats([]),
    },
  }
}

/**
 * Resolve the code-shaped tokens of one session's human messages.
 * @param {ReturnType<emptyReport>} report - the report to add to.
 * @param {Record<string, unknown>[]} fresh - the session's events in the window.
 * @param {string} cwd - the session's project, verbatim from the header.
 * @param {{ db: DatabaseSync, statements: object }} graph - the open graph.
 * @param {object} c - the per-message samples the caller reduces afterwards.
 */
function countSession(report, fresh, cwd, graph, c) {
  const { statements } = graph
  // The project prefix as an absolute token would carry it: forward slashes, lower case.
  const projectPrefix = `${cwd.replace(/\\/gu, '/').toLowerCase()}/`
  for (const event of fresh) {
    if (event.type !== 'user/message') continue
    const data = isRecord(event.data) ? event.data : {}
    if (!isRecord(data.source) || data.source.kind !== 'user') continue
    const text = textOf(data.content)
    if (text.trim().length < MIN_MESSAGE_CHARS) {
      report.messages.tooShort += 1
      continue
    }
    report.messages.count += 1
    const group = text.length >= LONG_MESSAGE_CHARS ? report.groups.long : report.groups.short
    group.messages += 1
    const tokens = [...new Set((text.match(TOKEN) ?? []).map(token => token.replace(/\\/gu, '/').replace(/^(?:\.\/)+/u, '')))]
      .filter(token => !STOP.has(token))
    if (tokens.length === 0) continue
    report.messages.withToken += 1
    c.tokensPer.push(tokens.length)
    const considered = tokens.slice(0, MAX_TOKENS_PER_MESSAGE)
    c.consideredPer.push(considered.length)
    let paths = 0
    const names = []
    let shared = 0
    for (const token of considered) {
      if (token.includes('/') || EXT.test(token)) {
        report.tokens.path += 1
        let relative = token
        if (/^[A-Za-z]:\//u.test(token) || token.startsWith('/')) {
          report.tokens.absolutePath += 1
          // Inside the project: the project-relative path. Outside it: the bare
          // name, which the unique-suffix rule below may still place.
          relative = token.toLowerCase().startsWith(projectPrefix) ? token.slice(projectPrefix.length) : token.slice(token.lastIndexOf('/') + 1)
        }
        const bare = relative.slice(relative.lastIndexOf('/') + 1)
        const exact = statements.fileByPath.get(relative)
        const hits = exact !== undefined ? 1 : Number(statements.fileBySuffix.get(bare, `%/${escapeLike(bare)}`).n)
        if (hits === 1) {
          paths += 1
          report.tokens.pathHit += 1
        } else {
          report.tokens.pathMiss += 1
        }
      } else {
        report.tokens.identifier += 1
        const hit = statements.symbolByName.get(token)
        const declared = Number(hit?.n ?? 0)
        if (declared === 1) {
          names.push(String(hit.id))
          report.tokens.unique += 1
        } else if (declared > 1) {
          shared += 1
          report.tokens.shared += 1
        } else {
          report.tokens.none += 1
        }
      }
    }
    if (paths > 0) report.messages.withPath += 1
    if (names.length > 0) report.messages.withUniqueName += 1
    c.resolvedPer.push(paths + names.length)
    const strict = paths > 0 || names.length > 0
    if (strict) group.strict += 1
    if (strict || shared > 0) group.loose += 1
    if (!strict) continue
    report.messages.strictHits += 1
    c.packChars.push(PACK_OVERHEAD_CHARS + Math.min(paths, PACK_MAX_FILES) * PACK_FILE_CHARS + Math.min(names.length, PACK_MAX_SYMBOLS) * PACK_SYMBOL_CHARS)
  }
}

/**
 * Open one project's graph read-only, or say why there is none to read.
 * @param {string} cwd - the session's project, verbatim.
 * @param {string} home - the DSH home.
 * @returns {{ db?: DatabaseSync, statements?: object, reason?: 'missing' | 'failed' }} the
 *   handle with its prepared statements, or the reason it is absent.
 */
function openGraphFor(cwd, home) {
  // The same derivation as `graphPathFor` in src/index.ts.
  const key = createHash('sha256').update(cwd).digest('hex').slice(0, 32)
  const file = join(home, GRAPH_STORAGE, 'projects', key, 'graph.db')
  if (!existsSync(file)) return { reason: 'missing' }
  let db
  try {
    db = new DatabaseSync(file, { readOnly: true })
    // A file that is not a database opens lazily; prove the tables are there.
    db.prepare('SELECT 1 FROM files LIMIT 1').get()
    db.prepare('SELECT 1 FROM symbols LIMIT 1').get()
  } catch (error) {
    try { db?.close() } catch { /* already closed by the failed open */ }
    process.stderr.write(`prefetch-replay: a graph could not be opened: ${file} (${error instanceof Error ? error.message : String(error)})\n`)
    return { reason: 'failed' }
  }
  return {
    db,
    statements: {
      fileByPath: db.prepare('SELECT 1 AS one FROM files WHERE path = ? LIMIT 1'),
      // Exactly one file ends in this name: a suffix match that two files share
      // names neither. ESCAPE keeps a `_` or `%` in a name literal.
      fileBySuffix: db.prepare("SELECT COUNT(*) AS n FROM files WHERE path = ? OR path LIKE ? ESCAPE '\\'"),
      symbolByName: db.prepare('SELECT COUNT(*) AS n, MIN(id) AS id FROM symbols WHERE name = ?'),
    },
  }
}

/** `%`, `_` and `\` as themselves, for a LIKE pattern. */
function escapeLike(text) {
  return text.replace(/[\\%_]/gu, match => `\\${match}`)
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The text blocks of a content value, joined; anything else counts as empty. */
function textOf(content) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  return content.filter(isRecord).filter(block => block.type === 'text').map(block => String(block.text ?? '')).join('\n')
}

/** n / p50 / p90 / max / sum, the percentile taken as the nearest rank. */
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = p => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))])
  return { n: sorted.length, p50: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1] ?? 0, sum: sorted.reduce((total, value) => total + value, 0) }
}

function pct(part, whole) {
  return whole === 0 ? 0 : Math.round((part / whole) * 100)
}

// ---------------------------------------------------------------------------
// The text report
// ---------------------------------------------------------------------------

/** `n=… p50=… p90=… max=…` of one distribution. */
function dist(row) {
  return `n=${String(row.n)} p50=${String(row.p50)} p90=${String(row.p90)} max=${String(row.max)}`
}

/** The report as text: the same data as the JSON. */
function renderText(report) {
  const { scope, sessions, messages, groups, tokens, packChars } = report
  return [
    `prefetch-replay: kernel session logs (session.v4.jsonl.zstd)  since=${scope.since}`,
    `files=${String(scope.files)} parsed=${String(scope.parsed)} skipped=${String(scope.skipped)} truncated=${String(scope.truncated)} lines=${String(scope.lines)} unparsable=${String(scope.unparsable)}`,
    `sessions total=${String(sessions.total)}; with a graph on disk now=${String(sessions.withGraph)}; without a graph=${String(sessions.noGraph)}; graph failed to open=${String(sessions.openFailed)}; without a cwd=${String(sessions.noCwd)}`,
    `human messages=${String(messages.count)} (shorter than ${String(MIN_MESSAGE_CHARS)} chars, not counted: ${String(messages.tooShort)})`,
    `  carrying a code-shaped token=${String(messages.withToken)} (${String(messages.tokenPct)}%); tokens per such message ${dist(messages.tokensPerMessage)}; looked up per message (first ${String(MAX_TOKENS_PER_MESSAGE)}) ${dist(messages.consideredPerMessage)}`,
    `  naming a file the graph holds=${String(messages.withPath)} (${String(messages.pathPct)}%)`,
    `  naming an identifier with exactly one declaration=${String(messages.withUniqueName)} (${String(messages.uniqueNamePct)}%)`,
    `  strict gate (either)=${String(messages.strictHits)} (${String(messages.strictPct)}%); resolved per such message ${dist(messages.resolvedPerMessage)}`,
    `  long messages (>= ${String(LONG_MESSAGE_CHARS)} chars)=${String(groups.long.messages)}: strict gate ${String(groups.long.strict)} (${String(groups.long.strictPct)}%), loose gate (also a shared identifier) ${String(groups.long.loose)} (${String(groups.long.loosePct)}%)`,
    `  short messages=${String(groups.short.messages)}: strict gate ${String(groups.short.strict)} (${String(groups.short.strictPct)}%), loose gate ${String(groups.short.loose)} (${String(groups.short.loosePct)}%)`,
    `tokens looked up (first ${String(MAX_TOKENS_PER_MESSAGE)} per message): ${Object.entries(tokens).map(([key, value]) => `${key} ${String(value)}`).join(', ')}`,
    `projected pack for a strictly resolving message (chars; ${packChars.basis}): ${dist(packChars.stats)}`,
  ].join('\n')
}
