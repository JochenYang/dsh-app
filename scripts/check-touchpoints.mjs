#!/usr/bin/env node
/**
 * Touchpoint scan: which of OUR surfaces does a kernel-line move touch?
 *
 * This is the executable half of `docs/agents/kernel-line-regression.md` §1. It
 * answers one question — "which of the seven touchpoint classes does this
 * repository actually use, and where" — and deliberately answers nothing else.
 *
 * What it is NOT:
 *
 *   - it is not a compatibility verdict. A hit is a place to look; zero hits in
 *     a class mean only that the current patterns did not match. The doc's own
 *     wording ("not detected by the current patterns") is the contract.
 *   - it is not a gate by default. Run without `--check` it reports and exits 0
 *     whatever it finds; the `--check` mode exists so a caller can decide that
 *     an EMPTY class is the failure (a pattern table that matches nothing has
 *     gone stale, which is the one thing this file can prove about itself).
 *
 * Why the report is a table of counts plus locations rather than a pass/fail:
 * the seven classes are how a human organises the read of an upstream change
 * set. Replacing that judgement with a threshold would make the scan look like
 * evidence it cannot be.
 *
 * Design constraints, matching the other checks in this directory:
 *
 *   - zero dependencies beyond Node built-ins and the repository's own helpers;
 *   - read-only: it never writes, and it has no output-file option;
 *   - no network and no kernel tree, so it belongs in the fast CI gate;
 *   - comments are stripped before matching, so a file that merely DOCUMENTS a
 *     touchpoint does not count as using one. `stripComments` preserves line
 *     numbers, which is what lets the report cite `file:line`.
 *
 * Usage:
 *   node scripts/check-touchpoints.mjs [--repo <dir>] [--class <id|slug>]
 *        [--max-hits <n>] [--json] [--check]
 *
 * Exit: 0 report produced (or, with --check, every class matched something);
 *       1 a class matched nothing under --check; 2 usage or input error.
 *
 * @module scripts/check-touchpoints
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './lib/strip-comments.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PATTERNS_FILE = path.join(root, 'scripts', 'touchpoint-patterns.json')

/**
 * Directories walked for hits, in report priority order.
 *
 * `plugins/` and `src/` are the shipped surfaces; `scripts/` and `test/` are the
 * tooling that breaks in the same way when a host contract moves (a probe that
 * spawns a child inherits the same argv contract a plugin does). Generated and
 * vendored trees are excluded below rather than filtered per file.
 */
const SCAN_ROOTS = ['plugins', 'src', 'scripts', 'test']

/**
 * Directory names never descended into.
 *
 * `.test-dist` and `lib` are build outputs that mirror sources — counting them
 * would double every hit and point the reader at a generated file. `node_modules`
 * is a dependency tree, not our code. `scratch` is gitignored working state.
 */
const SKIP_DIRS = new Set(['node_modules', 'lib', 'dist', '.test-dist', 'scratch', '.git', 'coverage', 'release', 'runtime-dist', 'bundled-kernel', 'repo'])

/**
 * Extensions worth reading. Markdown is deliberately absent: prose ABOUT a
 * touchpoint is not a touchpoint, and including it would make this report cite
 * documentation instead of code.
 */
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.yml', '.yaml'])

/** Files larger than this are skipped: a 5 MB bundle is not a place to read. */
const MAX_FILE_BYTES = 1024 * 1024

/**
 * Files matched by name regardless of extension — the composition overlays and
 * lockfiles are where several classes actually live.
 */
/**
 * Files matched by name regardless of extension — the composition overlays and
 * manifests are where several classes actually live.
 */
const ALWAYS_SCAN_NAMES = new Set(['dsh-app.patch.yml', 'cordis.patch.yml', 'package.json'])

/**
 * Files never read, even though their extension is scannable.
 *
 * Lockfiles are install residue, not a surface we author: a plugin's local
 * `package-lock.json` is gitignored and regenerated on every install, so citing
 * it would point the reader at a file that does not exist in a fresh checkout.
 *
 * The pattern table is excluded because it MATCHES ITSELF — its entries are the
 * very regex sources being searched for, so a scan that includes it reports the
 * scanner instead of the code. That is noise in the one class the reader trusts
 * least (`composition-rows`), and it grew the report by 22 lines.
 */
const SKIP_FILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'touchpoint-patterns.json'])

/** Parse `--flag value` / `--flag` pairs, rejecting unknown flags loudly. */
function parseArgs(argv) {
  const args = { maxHits: 12, json: false, check: false, class: null }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    switch (token) {
      case '--repo': args.repo = argv[++i]; break
      case '--class': args.class = argv[++i]; break
      case '--max-hits': args.maxHits = Number(argv[++i]); break
      case '--json': args.json = true; break
      case '--check': args.check = true; break
      default: throw new Error(`unknown argument: ${token}`)
    }
  }
  if (args.repo === undefined) args.repo = root
  if (!Number.isFinite(args.maxHits) || args.maxHits < 0) throw new Error('--max-hits must be a non-negative number')
  if (args.class !== null && args.class === '') throw new Error('--class needs a value')
  return args
}

/** Every scannable file under `dir`, as repo-relative POSIX paths. */
function walk(dir, repoRoot, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(full, repoRoot, out)
      continue
    }
    if (!entry.isFile()) continue
    const ext = path.extname(entry.name)
    if (SKIP_FILES.has(entry.name)) continue
    if (!SCAN_EXTENSIONS.has(ext) && !ALWAYS_SCAN_NAMES.has(entry.name)) continue
    let size
    try {
      size = statSync(full).size
    } catch {
      continue
    }
    if (size > MAX_FILE_BYTES) continue
    out.push(path.relative(repoRoot, full).replaceAll('\\', '/'))
  }
  return out
}

/**
 * Scan one file against every class, returning `{ classId, line, pattern }` hits.
 *
 * Comments are stripped first so a comment that NAMES a touchpoint (this file
 * is full of them) does not register as a use of one. Line numbers survive the
 * strip, so `line` is the line in the real file.
 */
/**
 * Blank out YAML full-line comments, keeping line numbers.
 *
 * `stripComments` is a JavaScript scanner: it knows `//` and block comments and
 * nothing about `#`. A composition overlay is mostly prose explaining why each
 * row is what it is, so without this pass the scan reports the EXPLANATION of a
 * touchpoint as a use of one — measured on this tree, 10 of the 38 yml hits were
 * full-line comments, including `# ... ctx.get('profileContext') ...` in
 * `plugins/dsh-app.patch.yml`.
 *
 * Only a line whose first non-space character is `#` is removed. A `#` further
 * in is left alone: in YAML it is a comment only after whitespace, and the
 * strings this repository matches on (`'@dsh-app/plugin-brand'`, `a#b`) must not
 * be truncated. This is the conservative subset — it cannot produce a false
 * negative, which is the direction that matters for a scan whose whole job is
 * to not miss a surface.
 */
function stripYamlComments(source) {
  return source
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line))
    .join('\n')
}

/**
 * Scan one file against every class, returning `{ classId, line, pattern }` hits.
 *
 * Comments are stripped first so a file that merely DOCUMENTS a touchpoint does
 * not register as using one. Line numbers survive the strip, so `line` is the
 * line in the real file.
 */
function scanFile(text, classes, { yaml = false } = {}) {
  const stripped = yaml ? stripYamlComments(stripComments(text)) : stripComments(text)
  const lines = stripped.split('\n')
  const hits = []
  for (const klass of classes) {
    for (const patternSource of klass.patterns) {
      let regex
      try {
        regex = new RegExp(patternSource, 'u')
      } catch (error) {
        throw new Error(`class ${klass.id} (${klass.slug}) has an invalid pattern ${JSON.stringify(patternSource)}: ${error.message}`)
      }
      for (let index = 0; index < lines.length; index += 1) {
        if (regex.test(lines[index])) hits.push({ classId: klass.id, line: index + 1, pattern: patternSource })
      }
    }
  }
  return hits
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`usage: node scripts/check-touchpoints.mjs [--repo <dir>] [--class <id|slug>] [--max-hits <n>] [--json] [--check]`)
    console.error(`[touchpoints] ${error.message}`)
    process.exitCode = 2
    return
  }

  const repoRoot = path.resolve(args.repo)
  const table = JSON.parse(readFileSync(PATTERNS_FILE, 'utf8'))
  let classes = table.classes
  if (args.class !== null) {
    classes = classes.filter((klass) => String(klass.id) === args.class || klass.slug === args.class)
    if (classes.length === 0) {
      console.error(`[touchpoints] no class matches ${JSON.stringify(args.class)}; known: ${table.classes.map((k) => `${k.id}:${k.slug}`).join(', ')}`)
      process.exitCode = 2
      return
    }
  }

  const files = SCAN_ROOTS.flatMap((entry) => {
    const dir = path.join(repoRoot, entry)
    return existsSync(dir) ? walk(dir, repoRoot) : []
  })

  const perClass = new Map(classes.map((klass) => [klass.id, { klass, hits: [] }]))
  for (const relative of files) {
    let text
    try {
      text = readFileSync(path.join(repoRoot, relative), 'utf8')
    } catch {
      continue
    }
    for (const hit of scanFile(text, classes, { yaml: /\.(?:yml|yaml)$/u.test(relative) })) {
      const bucket = perClass.get(hit.classId)
      if (bucket !== undefined) bucket.hits.push({ file: relative, line: hit.line, pattern: hit.pattern })
    }
  }

  const rows = [...perClass.values()].map(({ klass, hits }) => {
    // One entry per file:line, keeping the first pattern that matched, so a line
    // that satisfies three patterns is not reported three times.
    const seen = new Set()
    const unique = []
    for (const hit of hits) {
      const key = `${hit.file}:${hit.line}`
      if (seen.has(key)) continue
      seen.add(key)
      unique.push(hit)
    }
    // Shipped surfaces first: a hit in plugins/ or src/ is what a line move
    // actually breaks, and burying it under test helpers wastes the reader.
    const rank = (file) => (file.startsWith('plugins/') || file.startsWith('src/') ? 0 : 1)
    unique.sort((a, b) => rank(a.file) - rank(b.file) || a.file.localeCompare(b.file) || a.line - b.line)
    return { klass, total: unique.length, shown: unique.slice(0, args.maxHits) }
  })

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      schema: table.schema,
      scannedFiles: files.length,
      classes: rows.map(({ klass, total, shown }) => ({
        id: klass.id, slug: klass.slug, name: klass.name, hits: total, locations: shown,
      })),
    }, null, 2)}\n`)
  } else {
    console.log(`touchpoint scan — ${files.length} files under ${SCAN_ROOTS.join(', ')}`)
    console.log('(a hit is a place to look, not a defect; zero hits mean only that the patterns did not match)')
    console.log('')
    for (const { klass, total, shown } of rows) {
      const flag = total === 0 ? 'none' : String(total)
      console.log(`#${klass.id} ${klass.name} [${klass.slug}] — ${flag}`)
      if (total === 0) {
        console.log(`      ${klass.why}`)
        continue
      }
      for (const hit of shown) console.log(`      ${hit.file}:${hit.line}`)
      if (total > shown.length) console.log(`      … ${total - shown.length} more (raise --max-hits to see them)`)
    }
  }

  // `--check` asserts only what this file can actually prove about itself: every
  // class still matches something. A class at zero means the pattern table has
  // drifted away from the code, not that the surface is unused — the scan is
  // heuristic, so an empty class is a maintenance signal, never a clean bill.
  if (args.check) {
    const empty = rows.filter(({ total }) => total === 0)
    if (empty.length > 0) {
      console.error('')
      for (const { klass } of empty) {
        console.error(`[touchpoints] class #${klass.id} (${klass.slug}) matched nothing — the patterns have gone stale against this tree`)
      }
      process.exitCode = 1
    }
  }
}

main()
