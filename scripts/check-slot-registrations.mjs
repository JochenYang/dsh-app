#!/usr/bin/env node
/**
 * Slot registration check: does every slot id our client halves register into
 * still EXIST in the followed kernel line, and does the registration match the
 * slot's declared kind?
 *
 * Why this is a static check and not a browser probe. The rendering-side failure
 * this repository has actually hit is not a component throwing — it is a client
 * half registering into a seat that the line no longer has, or declaring a
 * registration shape the seat does not accept. The kernel's slot system fails in
 * two ways, and NEITHER is visible to the type gate or to a request-level smoke:
 *
 *   - a slot id that no `SlotMap` declares throws at registration;
 *   - a slot id that USED to be declared and no longer is does nothing at all —
 *     no error, no log, no render. The surface is simply absent.
 *
 * Both are decidable from the installed line alone, because the kernel declares
 * its seats in `SlotMap` interfaces and the declarations ship with the packages.
 * That makes a browser unnecessary for this half of the question, and it makes
 * the answer reproducible in CI.
 *
 * What this does NOT replace: whether a registered component RENDERS correctly.
 * A component can reference a missing export and still pass this check — that is
 * what `test/plugin-kernel-imports.test.mjs` covers. This check answers only the
 * registration half.
 *
 * Usage:
 *   node scripts/check-slot-registrations.mjs [--repo <dir>] [--json]
 *
 * Exit: 0 every registration resolves; 1 at least one is undeclared; 2 usage or
 * input error.
 *
 * @module scripts/check-slot-registrations
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './lib/strip-comments.mjs'
import { pluginDirs } from './lib/kernel-exports.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Directories never walked. */
const SKIP_DIRS = new Set(['node_modules', 'lib', '.test-dist', 'dist', 'scratch'])

/**
 * A client-half registration: `ctx.slots.inject('<id>'` or
 * `ctx.slots.register({ name: '<id>'`.
 *
 * Both forms are collected because they fail differently: `inject` is the
 * wrapper for a seat owned by another entry, `register` is a direct
 * registration. A registration that uses the wrong one for its seat is a defect
 * this check cannot see (the kernel decides ownership), so the id is what is
 * judged here.
 */
const INJECT_RE = /ctx\.slots\.inject\(\s*['"]([^'"]+)['"]/gu
const REGISTER_NAME_RE = /ctx\.slots\.register\(\s*\{[^}]*?name:\s*['"]([^'"]+)['"]/gu

/**
 * A `SlotMap` entry in a shipped declaration:
 *
 *     interface SlotMap {
 *       'settings.section': {
 *         kind: 'list';
 *         scope: 'root';
 *         owner: X;
 *       };
 *
 * Two things this parser deliberately does NOT do, both learned by getting them
 * wrong first:
 *
 *   - it does not brace-match the whole `interface SlotMap { … }` block. A
 *     non-greedy `[\s\S]*?` stops at the FIRST `}` inside the block — the end of
 *     the first entry's object literal — and reported 0 declared slots for a
 *     file that declares 9. Instead the id is matched anywhere in the file, and
 *     only the file's participation in `SlotMap` is required.
 *   - it does not require the entry to be on one line. The declaration is
 *     formatted across five.
 *
 * What keeps a stray quoted key from being read as a slot: the id must look like
 * a slot id (a dotted, lower-case path) AND appear inside a file that declares
 * `interface SlotMap`. A wrong answer here would be worse than a missing one —
 * the check's whole job is to say whether a seat exists.
 */
const SLOT_ID_SHAPE = /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9-]+)+$/u
/**
 * Every slot id the installed line declares, with its kind when readable.
 *
 * Read from `.d.ts` under `lib/types` in every installed `@deepseek-ai/*`
 * package: the declarations are part of the package, so this needs no kernel
 * tree and no network.
 */
function declaredSlots(repoRoot) {
  const slots = new Map()
  const scopeDirs = [path.join(repoRoot, 'node_modules', '@deepseek-ai')]
  const pluginsRoot = path.join(repoRoot, 'plugins')
  if (existsSync(pluginsRoot)) {
    for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) scopeDirs.push(path.join(pluginsRoot, entry.name, 'node_modules', '@deepseek-ai'))
    }
  }

  const scan = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { scan(full); continue }
      // Both the installed packages' declarations and our own `src/` are read:
      // a suite plugin may declare its OWN seats. `plugin-client-ui` declares
      // `settings.dsh-app-maintenance.tab` in a `declare module
      // '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap { … } }` block, and
      // `plugin-presets` registers into it. Reading only the installed packages
      // reported those two registrations as undeclared — a false positive that
      // would have taught a reader to ignore this check.
      if (!entry.name.endsWith('.d.ts') && !entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue
      let text
      try {
        text = readFileSync(full, 'utf8')
      } catch {
        continue
      }
      // The declaration must be INSIDE an `interface SlotMap { … }` block.
      //
      // Scanning the whole file instead (with only "does this file mention
      // SlotMap" as the gate) made the check unfalsifiable: the same id also
      // appears in a `children: { 'settings.…': { kind: 'list', scope: 'root' } }`
      // table and in several `ctx.slots.*(…)` calls, so removing the declaration
      // left those occurrences behind and the id still resolved. Measured — the
      // mutation "delete both declarations" passed against that version.
      //
      // Brace matching has to survive the nested object literals an entry holds,
      // so the block is walked by counting braces rather than by a lazy regex
      // (a lazy one stops at the first entry's closing brace).
      const blocks = []
      for (const start of text.matchAll(/interface\s+SlotMap\s*\{/gu)) {
        let depth = 1
        let index = start.index + start[0].length
        while (index < text.length && depth > 0) {
          const ch = text[index]
          if (ch === '{') depth += 1
          else if (ch === '}') depth -= 1
          index += 1
        }
        blocks.push(text.slice(start.index + start[0].length, index - 1))
      }
      for (const block of blocks) {
        const idAt = /(['"])([^'"]+)\1\s*:\s*\{/gu
        for (const match of block.matchAll(idAt)) {
          const id = match[2]
          if (!SLOT_ID_SHAPE.test(id)) continue
          // `kind` belongs to THIS entry, so it is read from the text that
          // immediately follows the id — the declaration puts it first in the
          // object literal, before `scope` and `owner`.
          const rest = block.slice(match.index + match[0].length)
          const kind = /^\s*kind:\s*'([^']+)'/u.exec(rest)?.[1] ?? null
          if (!slots.has(id)) slots.set(id, { kind, declaredIn: [full] })
          else slots.get(id).declaredIn.push(full)
        }
      }
    }
  }

  for (const pluginDir of pluginDirs(repoRoot)) scan(path.join(pluginDir, 'src'))
  for (const dir of scopeDirs) scan(dir)
  return slots
}

/** Every `ctx.slots.*` registration in our own client sources. */
function registrations(repoRoot) {
  const found = []
  const scan = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        scan(full)
        continue
      }
      if (!/\.tsx?$/u.test(entry.name)) continue
      const text = stripComments(readFileSync(full, 'utf8'))
      const lines = text.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        for (const regex of [INJECT_RE, REGISTER_NAME_RE]) {
          regex.lastIndex = 0
          for (const match of lines[index].matchAll(regex)) {
            found.push({ id: match[1], file: path.relative(repoRoot, full).replaceAll('\\', '/'), line: index + 1 })
          }
        }
      }
    }
  }
  scan(path.join(repoRoot, 'plugins'))
  return found
}

function main() {
  const argv = process.argv.slice(2)
  let json = false
  let repoRoot = root
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--repo': repoRoot = path.resolve(argv[++i]); break
      case '--json': json = true; break
      default:
        console.error('usage: node scripts/check-slot-registrations.mjs [--repo <dir>] [--json]')
        console.error(`[slots] unknown argument: ${argv[i]}`)
        process.exitCode = 2
        return
    }
  }

  // An ABSENT installed line is a usage error, not a clean bill.
  //
  // Measured defect: against a tree with no `node_modules/@deepseek-ai` this
  // reported "0 slots declared, 0 registrations" and exited 0 — a silent pass
  // that looks exactly like success. The whole check is a comparison against the
  // installed line, so with no line there is nothing to compare and the only
  // honest answer is "cannot judge" (exit 2), the same contract
  // `scripts/kernel-surface.mjs` already had.
  const scopeDir = path.join(repoRoot, 'node_modules', '@deepseek-ai')
  if (!existsSync(scopeDir)) {
    console.error(`[slots] ${scopeDir} does not exist — install the followed line first`)
    process.exitCode = 2
    return
  }

  const slots = declaredSlots(repoRoot)
  const found = registrations(repoRoot)

  // One verdict per REGISTRATION, keyed by id + file + line.
  //
  // Keying on id + file alone collapsed three separate registrations in
  // `plugin-client-ui/src/client.ts` (three different settings sections, lines
  // 260/333/363) into one row — measured: the report said 12 registrations for
  // 14 calls. Each call is its own fact, and a reader counting rows would
  // undercount how much of a surface a retired seat takes out.
  const seen = new Set()
  const rows = []
  for (const registration of found) {
    const key = `${registration.id}\u0000${registration.file}\u0000${String(registration.line)}`
    if (seen.has(key)) continue
    seen.add(key)
    const declaration = slots.get(registration.id)
    rows.push({ ...registration, declared: declaration !== undefined, kind: declaration?.kind ?? null })
  }
  rows.sort((a, b) => Number(a.declared) - Number(b.declared) || a.id.localeCompare(b.id))

  const undeclared = rows.filter((row) => !row.declared)

  if (json) {
    process.stdout.write(`${JSON.stringify({
      declaredSlotCount: slots.size,
      registrations: rows.length,
      undeclared: undeclared.map((row) => ({ id: row.id, file: row.file, line: row.line })),
      rows,
    }, null, 2)}\n`)
  } else {
    console.log(`slot registrations — ${slots.size} slots declared by the installed line, ${rows.length} registrations in our client halves`)
    console.log('')
    for (const row of rows) {
      const mark = row.declared ? 'OK  ' : 'MISS'
      console.log(`${mark} ${row.id.padEnd(42)} ${row.file}:${row.line}${row.kind === null ? '' : `  (${row.kind})`}`)
    }
  }

  if (undeclared.length > 0) {
    console.error('')
    for (const row of undeclared) {
      console.error(`[slots] ${row.id} is registered at ${row.file}:${row.line} but no SlotMap in the installed line declares it — an undeclared slot throws, a retired one silently renders nothing`)
    }
    process.exitCode = 1
  }
}

main()
