#!/usr/bin/env node
/**
 * Replay the request-relevance rule (Z3) over real session logs and a real
 * memory root, and print how often it would attach cards.
 *
 *   node plugins/plugin-memory/scripts/relevance-replay.mjs --root <memory root> [--sessions <dir>] [--since YYYY-MM-DD]
 *
 * `--root` is the memory root (the two-level store); `--sessions` defaults to
 * `<DSH home>/sessions`. Only COUNTS are printed — which share of a project's
 * turns would get a card attached, and how many — never a message or a card:
 * both are the user's own text.
 *
 * Why this exists: the floor in `src/relevance.ts` (six shared distinctive
 * terms) was calibrated on one library, by reading every pair that fired. A
 * number without a way to re-measure it is a guess that happens to be right, so
 * anyone who moves the floor or the term rule re-runs this on the same library
 * and compares: the first calibration stood at 27 firing turns of 280 with
 * left-out cards (10%), 1.7 cards each. The replay goes through the SAME
 * functions the prompt provider does (`clipRequest`, `selectCards`,
 * `rankRelevantCards`), so a change to any of them shows up here.
 *
 * What it does NOT tell: whether the pairs that fire are on point. That took a
 * manual read of each one, and still does.
 *
 * Like `memory-health.mjs`, the source is bundled first (under `.test-dist/`,
 * gitignored): the rule lives in TypeScript next to the prompt path that uses
 * it, and a second JavaScript copy would be the drifting duplicate.
 */
import { buildSync } from 'esbuild'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { decompressFrames, listSessionLogs, parseEvents, parseSince } from '../../../scripts/lib/session-log.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')

function fail(message) {
  process.stderr.write(`relevance-replay: ${message}\n`)
  process.exit(2)
}

const argv = process.argv.slice(2)
let rootDir = ''
let sessionsDir = ''
let since
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg === '--root') {
    rootDir = argv[i + 1] ?? ''
    i += 1
  } else if (arg.startsWith('--root=')) rootDir = arg.slice('--root='.length)
  else if (arg === '--sessions') {
    sessionsDir = argv[i + 1] ?? ''
    i += 1
  } else if (arg.startsWith('--sessions=')) sessionsDir = arg.slice('--sessions='.length)
  else if (arg === '--since') {
    since = parseSince(argv[i + 1] ?? '')
    i += 1
  } else if (arg.startsWith('--since=')) since = parseSince(arg.slice('--since='.length))
  else fail('unknown argument; usage: --root <dir> [--sessions <dir>] [--since YYYY-MM-DD]')
}
if (rootDir === '') fail('--root <dir> is required (the memory root, not a project store)')
rootDir = resolve(rootDir)
sessionsDir = sessionsDir === '' ? join(homedir(), '.dsh', 'sessions') : resolve(sessionsDir)

const outDir = join(pluginRoot, '.test-dist')
const bundle = join(outDir, 'relevance-replay.bundle.mjs')
mkdirSync(outDir, { recursive: true })
buildSync({
  stdin: {
    contents: [
      "export { clipRequest, rankRelevantCards } from './src/relevance.ts'",
      "export { MAX_PROJECT_CHARS, selectCards } from './src/prompt.ts'",
      "export { MemoryStore, cardIsWithheld, projectSlug } from './src/memory-store.ts'",
    ].join('\n'),
    resolveDir: pluginRoot,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: bundle,
  logLevel: 'error',
})
const { MAX_PROJECT_CHARS, MemoryStore, cardIsWithheld, clipRequest, projectSlug, rankRelevantCards, selectCards } =
  await import(pathToFileURL(bundle).href)

const files = listSessionLogs(sessionsDir)
const stores = new Map()
const turnstile = { sessions: 0, turns: 0, withLeftOut: 0, attached: 0, cards: 0, oneCard: 0, twoCards: 0 }
const projects = new Set()
for (const file of files) {
  let decoded
  try { decoded = decompressFrames(readFileSync(file)) } catch { continue }
  const { events } = parseEvents(decoded.text)
  if (since !== undefined && typeof events[0]?.time === 'string' && Date.parse(events[0].time) < since.getTime()) continue
  const cwd = events[0]?.cwd
  if (typeof cwd !== 'string' || cwd === '') continue
  turnstile.sessions += 1
  const slug = projectSlug(cwd)
  if (!stores.has(slug)) {
    const dir = join(rootDir, 'projects', slug)
    let entry
    if (existsSync(dir)) {
      try {
        const store = new MemoryStore(dir)
        const cards = store.list().filter(card => !cardIsWithheld(card))
        const selected = new Set(selectCards(cards, MAX_PROJECT_CHARS, store.pinnedSet()).selected.map(card => card.name))
        entry = { cards, leftOut: cards.filter(card => !selected.has(card.name)) }
      } catch { entry = undefined }
    } else entry = undefined
    stores.set(slug, entry)
  }
  const store = stores.get(slug)
  if (store === undefined || store.cards.length === 0) continue
  projects.add(slug)
  for (const event of events) {
    // The request is what a person typed: every harness injection is logged
    // as a user/message too, under its own producer kind.
    if (event.type !== 'user/message' || event.data?.source?.kind !== 'user') continue
    const content = event.data?.content
    const request = clipRequest((Array.isArray(content) ? content : [])
      .filter(block => block?.type === 'text').map(block => block.text ?? '').join('\n'))
    if (request === '') continue
    turnstile.turns += 1
    if (store.leftOut.length === 0) continue
    turnstile.withLeftOut += 1
    const attached = rankRelevantCards(store.leftOut, store.cards, request).length
    if (attached === 0) continue
    turnstile.attached += 1
    turnstile.cards += attached
    if (attached === 1) turnstile.oneCard += 1
    else turnstile.twoCards += 1
  }
}
const share = turnstile.withLeftOut === 0 ? '0%' : `${Math.round(turnstile.attached / turnstile.withLeftOut * 100)}%`
process.stdout.write([
  `sessions read ${String(turnstile.sessions)}; projects with a readable, non-empty store ${String(projects.size)}; human turns ${String(turnstile.turns)}; of which with left-out cards ${String(turnstile.withLeftOut)}`,
  `attached on ${String(turnstile.attached)} turns (${share} of those), ${String(turnstile.cards)} cards; 1 card on ${String(turnstile.oneCard)} turns, 2 cards on ${String(turnstile.twoCards)}`,
  'counts only: whether the attached pairs are on point is a manual read',
  '',
].join('\n'))
