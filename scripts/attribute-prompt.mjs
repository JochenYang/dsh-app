#!/usr/bin/env node
/**
 * Attribute the assembled system prompt to its OWNERS, not just to sizes.
 *
 * `diagnose-prompt-size.mjs` ranks blocks and cannot say who wrote them. This one
 * classifies every block against a roster of known prompt owners (the kernel's
 * own sections, this suite's sections, the user's rule file, memory cards, the
 * workbench/office skills), so a size complaint turns into a decision:
 * something to turn off, something to trim, or something that is doing its job.
 *
 * Usage:
 *   node scripts/attribute-prompt.mjs --session <dir> [--top 14]
 *   node scripts/attribute-prompt.mjs --prompt-file <file>   # a raw prompt dump
 */

import { readFileSync, existsSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import path from 'node:path'

function argValue(flag) {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : undefined
}

const topN = Number(argValue('--top') ?? '14')

function decodeFrames(buffer) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  let at = 0
  while ((at = buffer.indexOf(MAGIC, at)) !== -1) {
    starts.push(at)
    at += MAGIC.length
  }
  const parts = []
  for (let k = 0; k < starts.length; k += 1) {
    try {
      parts.push(zstdDecompressSync(buffer.subarray(starts[k], starts[k + 1] ?? buffer.length)).toString('utf8'))
    } catch {
      // A partial trailing frame is normal.
    }
  }
  return parts.join('')
}

/** The largest assembled prompt in a session record, or one given directly. */
function loadPrompt() {
  const promptFile = argValue('--prompt-file')
  if (promptFile !== undefined) return readFileSync(promptFile, 'utf8')
  const sessionDir = argValue('--session')
  if (sessionDir === undefined) {
    console.error('attribute: pass --session <dir> or --prompt-file <file>')
    process.exit(2)
  }
  const zstdFile = path.join(sessionDir, 'session.v4.jsonl.zstd')
  const plainFile = path.join(sessionDir, 'session.v4.jsonl')
  const raw = existsSync(plainFile) ? readFileSync(plainFile, 'utf8') : decodeFrames(readFileSync(zstdFile))
  const events = raw.split('\n').filter(l => l.trim() !== '').map((l) => {
    try { return JSON.parse(l) } catch { return undefined }
  }).filter(Boolean)
  let best = ''
  const walk = (value, depth = 0) => {
    if (depth > 8) return
    if (typeof value === 'string') {
      if (value.length > best.length && /HARNESS|You are|# /u.test(value.slice(0, 3000))) best = value
      return
    }
    if (Array.isArray(value)) { for (const v of value) walk(v, depth + 1); return }
    if (value !== null && typeof value === 'object') { for (const v of Object.values(value)) walk(v, depth + 1) }
  }
  for (const event of events) walk(event)
  if (best === '') {
    console.error('attribute: no assembled prompt found in this record')
    process.exit(2)
  }
  return best
}

const prompt = loadPrompt()
const blocks = prompt.split(/\n{2,}/u).map(text => ({ text, size: text.length }))
const total = prompt.length

/**
 * Known prompt owners, most specific first. A block is attributed to the first
 * entry that matches; the order matters because several markers co-occur.
 */
const OWNERS = [
  ['PTC / run_code SDK (kernel dsh-tools)', /interface ToolArgsMap|interface ToolOutputMap|Program-only SDK bindings|run_code.*only tool you can call directly/su],
  ['Subagent SDK / run_code for children', /Delegated child|delegating agent/su],
  ['This suite: batch (swarm)', /When a request decomposes into multiple independent/u],
  ['This suite: Agent Teams trigger', /Agent Teams is the right tool when/u],
  ['Kernel: Agent Teams policy', /Agent Teams is available in this session/u],
  ['Kernel: harness identity', /^HARNESS_IDENTITY|DeepSeek Harness/su],
  ['User rules: AGENTS.md', /角色与沟通|安全底线|最小正确|高风险前置确认|成长建议/u],
  ['User rules: memory cards', /###\s.+\s\[lesson\]|SAVE what is durable yourself/su],
  ['Skills inventory', /SKILL\.md|^available skills|skill pack/su],
  ['MCP tool descriptions', /mcp__|MCP server/iu],
  ['Kernel: memory / curator guidance', /NEVER save: credentials/u],
  ['Kernel: card presentation', /Write the card text/u],
  ['Kernel: verification policy', /Before you claim work is done/u],
  ['Kernel: editing conventions', /HASH│content|`edit`: `HASH`/u],
  ['Kernel: PDF / office skill', /PDF \/ 报告请求/u],
  ['PTC runtime: preset declaration', /preset-rsi-dev|This session runs THIS preset/u],
  ['Kernel: goal policy', /create_goal may infer goal intent/u],
  ['Kernel: plugin_manager guidance', /Use plugin_manager for persistent bundle/u],
  ['Kernel: web GUI environment', /DeepSeek Harness Web GUI at/u],
  ['Presets authoring guidance', /Presets are `@deepseek-ai\/dsh-agent-preset` declaration rows/u],
]

const buckets = new Map()
let unattributed = 0
for (const block of blocks) {
  const owner = OWNERS.find(([, pattern]) => pattern.test(block.text))
  const key = owner === undefined ? 'UNATTRIBUTED (no known owner)' : owner[0]
  if (owner === undefined) unattributed += block.size
  const bucket = buckets.get(key) ?? { size: 0, blocks: 0, largest: '' }
  bucket.size += block.size
  bucket.blocks += 1
  if (block.size > bucket.largest.length) bucket.largest = block.text.split('\n')[0].slice(0, 90)
  buckets.set(key, bucket)
}

const ranked = [...buckets.entries()].sort((a, b) => b[1].size - a[1].size)
console.log(`attribute: assembled prompt = ${total} chars (~${(total / 1024).toFixed(1)}K) across ${blocks.length} blocks\n`)
console.log('  chars   share   blocks  owner')
for (const [owner, info] of ranked) {
  const share = ((info.size / total) * 100).toFixed(1).padStart(5)
  console.log(`${String(info.size).padStart(8)}  ${share}%  ${String(info.blocks).padStart(6)}  ${owner}`)
}
console.log('')
console.log('top blocks overall:')
for (const block of [...blocks].sort((a, b) => b.size - a.size).slice(0, topN)) {
  const share = ((block.size / total) * 100).toFixed(1).padStart(5)
  const owner = OWNERS.find(([, p]) => p.test(block.text))?.[0] ?? 'UNATTRIBUTED'
  console.log(`${String(block.size).padStart(8)}  ${share}%  [${owner}]`)
  console.log(`          ${block.text.split('\n')[0].replace(/\s+/gu, ' ').slice(0, 100)}`)
}
if (unattributed > 0) console.log(`\nunattributed: ${unattributed} chars (${((unattributed / total) * 100).toFixed(1)}%)`)
