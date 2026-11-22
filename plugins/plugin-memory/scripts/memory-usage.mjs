#!/usr/bin/env node
/**
 * How the three memory tools are actually used, counted from the kernel's own
 * session logs. The report prints COUNTS and bucket names only — never a
 * message, a tool argument, a card body, a topic key or a directory path (the
 * directory it read is named on stderr, not in the report).
 *
 *   node plugins/plugin-memory/scripts/memory-usage.mjs [--since YYYY-MM-DD] [--root <dir>]
 *
 *   --since   count events from this date on (UTC midnight; default: the whole log)
 *   --root    the sessions directory (default: $DSH_HOME/sessions, else ~/.dsh/sessions)
 *
 * A root that does not exist is a legitimate state (a kernel that never ran
 * here): the script prints zero counts and exits 0, so a caller never has to
 * tell "nothing to count" from "could not read". An argument it cannot parse
 * is the one thing that exits 2.
 *
 * ## What it relies on
 *
 * The kernel's session-log FORMAT — not anything this plugin owns: v4 logs,
 * one JSON event per line, stored as MULTI-FRAME zstd (one frame per write).
 * The reader, the event types and the privacy boundary are documented in
 * `scripts/lib/session-log.mjs`. When the kernel changes that format the
 * counts change silently: check `parsed` against `files` first.
 *
 * ## What it is for
 *
 * The plugin's own `toolStats` (/status, the settings page) answer the same
 * questions from the day counting began. This script answers them for the
 * history BEFORE that, and from a source the plugin does not write — which is
 * what a before/after comparison needs.
 *
 * Needs Node 22.15+ (`node:zlib` zstd support).
 */
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { aggregate, formatUsage, listSessionLogs, parseSince } from './lib/session-log.mjs'

const USAGE = 'usage: node plugins/plugin-memory/scripts/memory-usage.mjs [--since YYYY-MM-DD] [--root <dir>]'

function fail(message) {
  process.stderr.write(`memory-usage: ${message}\n`)
  process.exit(2)
}

/** Where the kernel keeps its logs on this machine. */
function defaultRoot() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'sessions')
}

const argv = process.argv.slice(2)
let root = ''
let since = ''
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg === '--help' || arg === '-h') {
    process.stdout.write(`${USAGE}\n`)
    process.exit(0)
  } else if (arg === '--since') {
    since = argv[i + 1] ?? ''
    i += 1
  } else if (arg.startsWith('--since=')) {
    since = arg.slice('--since='.length)
  } else if (arg === '--root') {
    root = argv[i + 1] ?? ''
    i += 1
  } else if (arg.startsWith('--root=')) {
    root = arg.slice('--root='.length)
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
root = resolve(root === '' ? defaultRoot() : root)
// A missing root is "nothing to count"; a file where the directory should be
// is a caller mistake, and walking it would only throw deeper in.
if (existsSync(root) && !statSync(root).isDirectory()) fail(`--root must be a directory, got a file: ${root}`)

// The report on stdout carries counts and bucket names only, so that a
// redirect of it stays free of this machine's paths; where it read from goes
// to stderr, where the person at the console still sees it.
process.stderr.write(`memory-usage: reading ${root}\n`)
const usage = aggregate(listSessionLogs(root), sinceMs)
process.stdout.write(`${formatUsage(usage, { since: since === '' ? 'beginning' : since })}\n`)
