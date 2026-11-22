/**
 * Reader and aggregator for the kernel's session logs — the engine behind
 * `scripts/memory-usage.mjs`, kept apart from the argument handling so the
 * multi-frame walk and the counting can be tested on a constructed file.
 *
 * ## What this depends on: the kernel's log format, not this plugin's
 *
 *   - the file name `session.v4.jsonl.zstd`, anywhere under the sessions root;
 *   - one JSON event per line, the first being a header (it carries no `time`);
 *   - `time` is epoch ms;
 *   - MULTI-FRAME zstd: the kernel appends one frame per write, and
 *     `zstdDecompressSync` over a whole buffer stops after the FIRST frame
 *     (measured: 9.8 MB / 5312 frames -> one line). The frames are walked with
 *     the decompressor's own accounting — `engine.bytesWritten` is the length
 *     of the one frame it consumed — not by parsing the zstd frame header here;
 *   - a tool call is logged two ways: natively as `tool/call` (paired with
 *     `tool/result` through `message.toolCallId`, whose `arguments` is a JSON
 *     string), or inside run_code as `tool/ptc-dispatch-start` (paired with
 *     `tool/ptc-dispatch` through `subCallId`, whose `arguments` is an object);
 *   - a tool's answer is its JSON payload: the text block of a native result's
 *     `message.content`, or the content blocks of a ptc dispatch.
 *
 * A kernel change to any of these silently changes or zeroes the counts.
 * Compare `parsed` with `files`, and `unparsed` with the totals, before
 * trusting a drop; a format change shows up there first.
 *
 * ## Privacy boundary
 *
 * Nothing here returns, and `formatUsage` never prints, a message, a card
 * body, a topic key or a directory path. Tool arguments are read for ONE
 * property each — whether `topic` or `query` is a non-empty string — and
 * dropped. Result payloads are reduced to counts, to fixed bucket names, and
 * to a refusal reason ONLY when it is a stable code (or one of a few fixed
 * word reasons); anything else — a sentence, a value with content embedded in
 * it — is counted under `other` and never printed.
 *
 * @module plugin-memory/scripts/lib/session-log
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** zstd frame magic, little-endian view of 0x28 0xB5 0x2F 0xFD. */
const ZSTD_MAGIC = 0x28b52ffd
const MAGIC_BYTES = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** The kernel's session log file name. */
const SESSION_LOG = /^session\.v4\.jsonl\.zstd$/u

/** The three tools this plugin registers; every other tool is only counted as "a call". */
const MEMORY_TOOLS = new Set(['memory_save', 'memory_recall', 'memory_forget'])

/** A stable reason code (`content-too-long`, `scope-global-removed`, `credential-refused`). */
const CODE = /^[a-z0-9][a-z0-9._-]*$/u
/** The word reasons the tools write as plain text, with no code: a FIXED
 *  list, so a bucket name can never be a value the model sent. */
const WORD_REASONS = new Set(['empty content', 'empty match', 'disabled'])

/**
 * The heads of the refusal SENTENCES the tools write, for the logs that
 * predate stable reason codes. Only the head is matched and only the bucket
 * name is kept: the rest of such a sentence carries a count, or a value the
 * model sent (`duplicate-of: topic "…"`), and neither is ever printed. A
 * reworded sentence falls to `other`, where the drift is visible.
 */
const REASON_HEADS = [
  ['duplicate-of', /^duplicate-of\b/u],
  ['content-too-long', /^content too long\b/iu],
  ['summary-too-long', /^summary too long\b/iu],
  ['summary-required', /^summary is required\b/iu],
  ['empty-content', /^empty content$/iu],
  // The tool's two credential sentences: `内容可能包含密钥或凭据，拒绝保存；…`
  // and `content looks like it carries a credential; refusing to persist`.
  // No space after 内容 — an earlier head had one and booked every such
  // refusal as `other`.
  ['credential', /^(?:content|summary) looks like it carries a credential|^(?:内容|summary)可能包含密钥/u],
  ['invalid-topic-key', /^(?:invalid topic key|topic must contain)\b/iu],
  ['unknown-category', /^unknown category\b/iu],
  ['invalid-domain', /^invalid domain\b/iu],
]

/**
 * Decompress a multi-frame zstd file.
 * @param {Buffer} buffer - the whole file.
 * @returns {{ text: string, frames: number, truncated: boolean }} every frame
 *   that decoded, joined; `truncated` when bytes were skipped or a frame would
 *   not decode (a crash mid-write leaves a partial last frame) — the frames
 *   before it are kept.
 */
export function decompressFrames(buffer) {
  const parts = []
  let at = 0
  let truncated = false
  while (at < buffer.length) {
    if (at + 4 > buffer.length || buffer.readUInt32BE(at) !== ZSTD_MAGIC) {
      // Not a frame start (padding, a skippable frame, a torn write): look for
      // the next magic number; none left means the tail is not recoverable.
      truncated = true
      const next = buffer.indexOf(MAGIC_BYTES, at)
      if (next < 0) break
      at = next
      continue
    }
    let decoded
    try {
      decoded = zstdDecompressSync(buffer.subarray(at), { info: true })
    } catch {
      truncated = true
      break
    }
    const consumed = decoded.engine.bytesWritten
    if (consumed <= 0) throw new Error(`zstd frame at offset ${String(at)} consumed no input`)
    parts.push(decoded.buffer)
    at += consumed
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: parts.length, truncated }
}

/**
 * Split decoded text into events.
 * @param {string} text - the decoded log.
 * @returns {{ events: Record<string, unknown>[], lines: number, unparsable: number }} the
 *   events that parsed, and the line counts.
 */
export function parseEvents(text) {
  const events = []
  let lines = 0
  let unparsable = 0
  for (const line of text.split('\n')) {
    if (line === '') continue
    lines += 1
    try {
      const event = JSON.parse(line)
      if (isRecord(event)) events.push(event)
      else unparsable += 1
    } catch {
      unparsable += 1
    }
  }
  return { events, lines, unparsable }
}

/**
 * Every session log under a root.
 * @param {string} root - the sessions directory.
 * @returns {string[]} the log files, sorted; empty when the root does not exist.
 *   A directory that cannot be listed is skipped — on stderr, so a count that
 *   came out low has a visible reason — and the rest of the tree still counts.
 */
export function listSessionLogs(root) {
  if (!existsSync(root)) return []
  const files = []
  const walk = dir => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      process.stderr.write(`memory-usage: skipped a directory that could not be listed: ${dir}\n`)
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (SESSION_LOG.test(entry.name)) files.push(full)
    }
  }
  walk(root)
  return files.sort()
}

/** A fresh, all-zero tally. */
export function emptyUsage() {
  return {
    files: 0, parsed: 0, unreadable: 0, truncated: 0, lines: 0, unparsable: 0,
    sessionsWithTurns: 0, turns: 0, userMessages: 0,
    sessionsWithMemory: 0, memoryCalls: 0, nativeCalls: 0, ptcCalls: 0,
    byTool: { memory_save: 0, memory_recall: 0, memory_forget: 0 },
    recall: {
      mode: { topic: 0, query: 0, 'list-all': 0 },
      results: { 'topic-not-found': 0, '0 cards': 0, '1 card': 0, '2-5 cards': 0, '6-12 cards': 0, '>12 cards': 0 },
      refusals: {}, errors: 0, unparsed: 0,
    },
    save: {
      outcomes: { created: 0, updated: 0, unchanged: 0, other: 0 },
      refusals: {}, duplicate: 0, related: 0, errors: 0, unparsed: 0,
    },
    forget: {
      removedCards: 0, callsRemovingNothing: 0, refusals: {}, errors: 0, unparsed: 0,
    },
  }
}

/**
 * Tally every log under a root.
 * @param {string[]} files - the log files (`listSessionLogs`).
 * @param {number} sinceMs - count events at or after this epoch ms (0 = all).
 * @returns {ReturnType<emptyUsage>} the tally.
 */
export function aggregate(files, sinceMs = 0) {
  const usage = emptyUsage()
  for (const file of files) {
    usage.files += 1
    let decoded
    try {
      decoded = decompressFrames(readFileSync(file))
    } catch {
      usage.unreadable += 1
      continue
    }
    // No frame decoded: not a log this reader understands, not an empty one.
    if (decoded.frames === 0) {
      usage.unreadable += 1
      continue
    }
    if (decoded.truncated) usage.truncated += 1
    usage.parsed += 1
    const { events, lines, unparsable } = parseEvents(decoded.text)
    usage.lines += lines
    usage.unparsable += unparsable
    countSession(usage, events, sinceMs)
  }
  return usage
}

/**
 * Parse `--since`: a calendar date, read as UTC midnight (the dates the log
 * itself is quoted in).
 * @param {string} value - `YYYY-MM-DD`.
 * @returns {number} epoch ms.
 * @throws {Error} on any other shape.
 */
export function parseSince(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error(`--since must be YYYY-MM-DD, got "${value}"`)
  const ms = Date.parse(`${value}T00:00:00Z`)
  if (!Number.isFinite(ms)) throw new Error(`--since is not a real date: "${value}"`)
  return ms
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bump(bag, key) {
  bag[key] = (bag[key] ?? 0) + 1
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/** The tool name an event names ('' when it names none). */
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

/** Which form a recall took. */
function recallMode(arguments_) {
  if (nonEmpty(arguments_.topic)) return 'topic'
  if (nonEmpty(arguments_.query)) return 'query'
  return 'list-all'
}

/**
 * The bucket a refusal counts under: its stable code, else the known head of
 * its sentence, else one of the fixed word reasons, else `other`. A sentence —
 * or a value with content embedded — never gets printed, so it never gets its
 * own bucket.
 */
function refusalBucket(payload) {
  if (typeof payload.code === 'string' && CODE.test(payload.code)) return payload.code
  const reason = typeof payload.reason === 'string' ? payload.reason : ''
  for (const [bucket, head] of REASON_HEADS) {
    if (head.test(reason)) return bucket
  }
  if (WORD_REASONS.has(reason)) return reason
  return 'other'
}

/** The size bucket of a card list. */
function sizeBucket(size) {
  if (size === 0) return '0 cards'
  if (size === 1) return '1 card'
  if (size <= 5) return '2-5 cards'
  if (size <= 12) return '6-12 cards'
  return '>12 cards'
}

/**
 * A tool's JSON payload behind its content blocks.
 * @param {unknown} content - the native result's `message.content`, or a ptc dispatch's `content`.
 * @returns {Record<string, unknown> | undefined} the payload object, or undefined.
 */
function payloadOf(content) {
  let value = content
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  if (Array.isArray(value)) {
    const text = value
      .filter(isRecord)
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .filter(part => typeof part === 'string')
      .join('\n')
    try {
      value = JSON.parse(text)
    } catch {
      return undefined
    }
  }
  return isRecord(value) ? value : undefined
}

/** Count one call of one memory tool. */
function countCall(usage, name, data) {
  usage.memoryCalls += 1
  bump(usage.byTool, name)
  if (name === 'memory_recall') bump(usage.recall.mode, recallMode(callArguments(data)))
}

/** Count one answered call. */
function countResult(usage, name, isError, payload) {
  if (name === 'memory_save') {
    if (isError) { usage.save.errors += 1; return }
    if (!isRecord(payload)) { usage.save.unparsed += 1; return }
    if (payload.saved === true) {
      const op = payload.op
      bump(usage.save.outcomes, op === 'created' || op === 'updated' || op === 'unchanged' ? op : 'other')
      if (Array.isArray(payload.related) && payload.related.length > 0) usage.save.related += 1
      return
    }
    const bucket = refusalBucket(payload)
    bump(usage.save.refusals, bucket)
    if (bucket === 'duplicate-of') usage.save.duplicate += 1
    return
  }
  if (name === 'memory_recall') {
    if (isError) { usage.recall.errors += 1; return }
    if (!isRecord(payload)) { usage.recall.unparsed += 1; return }
    // A recall answers `{ project: <view> }`; an older log may hold the view
    // at the top level. Read whichever is there.
    const view = isRecord(payload.project) ? payload.project : payload
    if (view.found === false) { bump(usage.recall.results, 'topic-not-found'); return }
    // A multi-card answer carries `cards`: a keyword search, a listing, or a
    // topic-key FALLBACK (which also says `found: true`). The array is the
    // size — reading `found` first booked every such fallback as "1 card".
    if (Array.isArray(view.cards)) {
      bump(usage.recall.results, sizeBucket(view.cards.length))
      return
    }
    if (view.found === true) { bump(usage.recall.results, '1 card'); return }
    // Only a payload that says why is a refusal; anything else is a shape
    // this reader does not know yet, and must stay visible as such.
    if (payload.code !== undefined || payload.reason !== undefined) bump(usage.recall.refusals, refusalBucket(payload))
    else usage.recall.unparsed += 1
    return
  }
  // memory_forget
  if (isError) { usage.forget.errors += 1; return }
  if (!isRecord(payload)) { usage.forget.unparsed += 1; return }
  if (typeof payload.forgotten === 'number' && payload.code === undefined && payload.reason === undefined) {
    usage.forget.removedCards += payload.forgotten
    if (payload.forgotten === 0) usage.forget.callsRemovingNothing += 1
    return
  }
  bump(usage.forget.refusals, refusalBucket(payload))
}

/** Count one session's events at or after `sinceMs`. */
function countSession(usage, events, sinceMs) {
  const fresh = events.filter(event => typeof event.time === 'number' && event.time >= sinceMs)
  const turns = fresh.filter(event => event.type === 'turn/start').length
  if (turns > 0) usage.sessionsWithTurns += 1
  usage.turns += turns
  usage.userMessages += fresh.filter(event => event.type === 'user/message').length
  const native = new Map() // callId -> tool name
  const ptc = new Map() // subCallId -> tool name
  const before = usage.memoryCalls
  for (const event of fresh) {
    const data = isRecord(event.data) ? event.data : {}
    if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') {
      if (event.type === 'tool/call') usage.nativeCalls += 1
      else usage.ptcCalls += 1
      const name = toolName(data)
      if (event.type === 'tool/call') {
        if (data.callId !== undefined) native.set(String(data.callId), name)
      } else if (data.subCallId !== undefined) {
        ptc.set(String(data.subCallId), name)
      }
      if (MEMORY_TOOLS.has(name)) countCall(usage, name, data)
    }
  }
  if (usage.memoryCalls === before) return
  usage.sessionsWithMemory += 1
  // Pair each answer with its call inside THIS session only.
  for (const event of fresh) {
    const data = isRecord(event.data) ? event.data : {}
    if (event.type === 'tool/result') {
      const message = isRecord(data.message) ? data.message : {}
      if (message.toolCallId === undefined) continue
      const name = native.get(String(message.toolCallId))
      if (name === undefined || !MEMORY_TOOLS.has(name)) continue
      countResult(usage, name, message.isError === true, payloadOf(message.content))
    } else if (event.type === 'tool/ptc-dispatch') {
      if (data.subCallId === undefined) continue
      const name = ptc.get(String(data.subCallId))
      if (name === undefined || !MEMORY_TOOLS.has(name)) continue
      countResult(usage, name, data.isError === true, payloadOf(data.content))
    }
  }
}

/**
 * `key=value` items of one bag.
 * @param {Record<string, number>} bag - the counts.
 * @param {boolean} ranked - largest count first, then by key (for a bag whose
 *   keys are open, like reason codes); otherwise the bag's own key order, so
 *   two runs of the same shape line up.
 * @returns {string} the items, space-separated.
 */
function histogram(bag, ranked = false) {
  const entries = Object.entries(bag)
  if (ranked) entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return entries.map(([key, value]) => `${key}=${String(value)}`).join(' ')
}

/**
 * The tally as text: counts and bucket names only. The directory that was
 * read is not among them — the CLI says it on stderr.
 * @param {ReturnType<emptyUsage>} usage - the tally.
 * @param {{ since: string }} scope - what was read.
 * @returns {string} the report, one line per group.
 */
export function formatUsage(usage, scope) {
  const recallEmpty = usage.recall.results['0 cards'] + usage.recall.results['topic-not-found']
  const saveRefused = Object.values(usage.save.refusals).reduce((sum, value) => sum + value, 0)
  const forgetRefused = Object.values(usage.forget.refusals).reduce((sum, value) => sum + value, 0)
  const refusals = bag => (Object.keys(bag).length === 0 ? '(none)' : histogram(bag, true))
  return [
    `memory-usage: kernel session logs (session.v4.jsonl.zstd)  since=${scope.since}`,
    `files=${String(usage.files)} parsed=${String(usage.parsed)} unreadable=${String(usage.unreadable)} truncated=${String(usage.truncated)} lines=${String(usage.lines)} unparsable=${String(usage.unparsable)}`,
    `sessions with turns=${String(usage.sessionsWithTurns)} turns=${String(usage.turns)} user messages=${String(usage.userMessages)}`,
    `memory tool calls=${String(usage.memoryCalls)} (native+ptc) in ${String(usage.sessionsWithMemory)} sessions; of all tool calls: native=${String(usage.nativeCalls)} ptc=${String(usage.ptcCalls)}`,
    `by tool: ${histogram(usage.byTool)}`,
    `recall by mode: ${histogram(usage.recall.mode)}`,
    `recall results: ${histogram(usage.recall.results)} (empty=${String(recallEmpty)})`,
    `recall refusals: ${refusals(usage.recall.refusals)}`,
    `recall tool errors=${String(usage.recall.errors)} unparsed=${String(usage.recall.unparsed)}`,
    `save outcomes: ${histogram(usage.save.outcomes)} (refused=${String(saveRefused)})`,
    `save refusals by reason: ${refusals(usage.save.refusals)}`,
    `save similarity gate: duplicate refusals=${String(usage.save.duplicate)} related hints=${String(usage.save.related)}`,
    `save tool errors=${String(usage.save.errors)} unparsed=${String(usage.save.unparsed)}`,
    `forget: cards removed=${String(usage.forget.removedCards)} calls removing nothing=${String(usage.forget.callsRemovingNothing)} refusals=${String(forgetRefused)}`,
    `forget refusals by reason: ${refusals(usage.forget.refusals)}`,
    `forget tool errors=${String(usage.forget.errors)} unparsed=${String(usage.forget.unparsed)}`,
  ].join('\n')
}
