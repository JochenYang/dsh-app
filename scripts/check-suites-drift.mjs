#!/usr/bin/env node
/**
 * Suite-drift gate: do the five copies of the suite roster still agree?
 *
 * The suite roster — which plugins this product ships — is written down five
 * times, because five different consumers read it and none of them can import
 * the others:
 *
 *   1. `plugins/dsh-app.patch.yml` — the loader rows the composed tree applies
 *      (the desktop host reads no `--patch` argument and no home layer, so this
 *      file is the composition);
 *   2. `scripts/kernel-line.mjs` (`SUITE_PLUGINS`) — the package names
 *      `build-runtime.mjs` npm-installs and links into the runtime closure;
 *   3. `src/main/brand-suite.ts` (`SUITE_PLUGIN_DIRS`) — the directories the
 *      shell links into the shared fallback and the booted profile at every
 *      start;
 *   4. `scripts/smoke-suite.mjs` (`SUITE_DIRS`) — the directories the smoke
 *      probe links and then asserts are present;
 *   5. `.github/workflows/release.yml` — the pre-build loop that installs and
 *      builds each plugin before the runtime step copies `lib/`.
 *
 * AGENTS.md requires all five to be updated in ONE commit. Nothing enforced
 * that: the failure is asymmetric and silent in both directions — a row in the
 * overlay whose package the runtime does not carry fails the whole tree
 * ("ERR_MODULE_NOT_FOUND" → no window), while a plugin present in the runtime
 * but missing from the overlay ships dead weight that no settings page ever
 * reaches. `check-plugin-graph.mjs` already compares `SUITE_PLUGINS` against the
 * plugin directories ON DISK, in both directions, and that is a different
 * question: it cannot see a copy that agrees with the disk but not with the
 * other copies.
 *
 * WHAT THE VERDICT IS, AND WHAT IT IS NOT
 *
 * The verdict is about MEMBERSHIP: every copy must name the same set of
 * plugins. That is the fact the five copies share, and the only one whose
 * violation breaks something.
 *
 * ORDER is reported but is deliberately not fatal. No consumer of these lists
 * depends on the order — `computeSuiteVersion` sorts before hashing, the install
 * and link loops are order-free, and the only ordered consumer is the loader,
 * which keys rows by id — so failing CI on a pure reorder would demand five
 * files be edited for no behavioural reason. The order difference is printed so
 * a reader sees it rather than being told it never happened.
 *
 * A DUPLICATE name inside one copy counts as drift too: a copy-pasted insert row
 * is how that copy stops describing a set.
 *
 * "COULD NOT READ" IS RED, NEVER GREEN
 *
 * Every source is read by a narrow rule matching how it is actually written,
 * and a source is REFUSED — exit 2, never an empty list — in three cases:
 *
 *   1. its marker is absent (a renamed constant, a rewritten declaration);
 *   2. it yields no roster entry at all;
 *   3. it writes an ENTRY-SHAPED line the rule did not read.
 *
 * The third is the one a drift gate most easily loses to in silence, and the
 * reason it is written down here: a row moved into another legal YAML shape
 * (`- name: …` inline, a flow mapping, a value on the following line) or a
 * list item re-quoted leaves the reader with a SHORTER list that still agrees
 * with the other four. A gate that reads nothing looks exactly like a gate that
 * finds nothing — and so does a gate that read seventeen rows out of eighteen.
 *
 * The rules are, per source (see the readers below for the exact shapes, and
 * for what each one counts as "entry-shaped"):
 *   - overlay: the `name:` fields of entries inside a top-level `- insert:`
 *     block, where "an entry's own field" is decided by INDENTATION — an
 *     entry's fields sit at a fixed offset from its `- `, a nested `config:`
 *     block's keys sit deeper. What separates the suite rows from the two
 *     upstream `@deepseek-ai/…` schedule rows the same file inserts is the
 *     VALUE's SCOPE, never which `- insert:` block a row sits in;
 *   - kernel: `SUITE_PLUGINS` IMPORTED from `scripts/kernel-line.mjs` — the
 *     exported value is the authority, so it is not re-parsed as text. The
 *     module's text is read only to attach a line number to each entry;
 *   - brand / smoke: the single-quoted entries of a `const`/`export const`
 *     array literal, located by its own declaration text. Any other
 *     comma-separated piece of that array's body is refused;
 *   - release: the one `for <var> in …; do` line whose items all start with
 *     `plugin-` (the workflow has nine other such loops, over platform cells,
 *     release asset names and retry counters, which the `plugin-` rule excludes;
 *     the rule below also refuses the AMBIGUOUS case of two roster-shaped loops,
 *     so a new one fails loudly instead of being silently picked over).
 *
 * `--repo` is deliberately absent: source 2 is an imported module, so pointing
 * this gate at a foreign tree would compare that tree's four text copies against
 * THIS tree's compiled-in values. The gate answers about the repository it
 * ships in. `--root <dir>` is the narrower seam the test suite uses: it moves
 * where the four text sources are READ FROM (a throwaway tree), and nothing
 * else — source 2's entries still come from the module imported here.
 *
 * Usage:
 *   node scripts/check-suites-drift.mjs [--check] [--json] [--root <dir>]
 *
 * Exit: 0 report produced (with `--check`: no drift); 1 drift under `--check`;
 *       2 a source could not be read, or usage error.
 *
 * @module scripts/check-suites-drift
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SUITE_PLUGINS } from './kernel-line.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** The npm scope the suite plugins live under. */
const SUITE_SCOPE = '@dsh-app/'

/**
 * A top-level `- insert:` row of an overlay. Anchored at column zero on purpose:
 * an indented `- insert:` would be a nested composition, whose names are
 * resolved by whoever mounts it and are not part of this roster.
 */
const INSERT_ROW = /^- insert:\s*$/u

/**
 * An entry's `name:` field inside an insert block: quoted with either quote
 * kind, or a bare scalar.
 *
 * The leading `\s+` keeps a COLUMN-ZERO `name:` — a top-level key of the
 * document, not a field of an entry — out of the read. A nested `name:` still
 * matches this pattern whatever its indentation, so what keeps a `config:`
 * block's own `name:` key out of the read is the indentation comparison in
 * {@link readOverlayRoster}, not this pattern. See that function for the
 * discriminator and why it is indentation rather than the key's name.
 */
const NAME_FIELD = /^\s+name:[ \t]*(?:'([^']*)'|"([^"]*)"|([^\s'"]+))/u

/**
 * A sequence item of an overlay: the `- `, its indentation, and what follows.
 * The indentation is captured because it is what separates an ENTRY's own
 * fields from a nested `config:` block's fields.
 */
const ITEM_ROW = /^(\s*)-\s*(.*)$/u

/**
 * The start of a `name:` key whatever its value's shape — including the shapes
 * {@link NAME_FIELD} refuses, which is exactly what makes it the detector for
 * an entry this reader could not read.
 */
const NAME_KEY = /^\s*name\s*:/u

/**
 * What a BARE (unquoted) `name:` value may look like: a package name, i.e.
 * `@scope/name` or `name`. A bare scalar that is not one of these is YAML
 * syntax rather than a value — an anchor or alias (`&suite`, `*ref`) or a block
 * scalar indicator (`|`, `>`) — and the name it stands for is not on the line
 * the reader is looking at. Reading such a token as the entry's name drops the
 * row in silence, which is what {@link readOverlayRoster} refuses over.
 */
const BARE_NAME = /^[@A-Za-z0-9._/-]+$/u

/**
 * A shell `for <var> in <items>; do` line. Used only to locate the release
 * workflow's pre-build loop; which of the file's loops is the roster is decided
 * by the `plugin-…` rule in {@link readReleaseLoop}, not by this pattern.
 */
const FOR_IN = /^\s*for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([^;]*);\s*do\s*$/u

/** The declaration text that opens `SUITE_PLUGINS` (for line numbers only). */
const KERNEL_MARKER = 'export const SUITE_PLUGINS = ['

/** The declaration text that opens `SUITE_PLUGIN_DIRS`. */
const BRAND_MARKER = 'export const SUITE_PLUGIN_DIRS = ['

/** The declaration text that opens `SUITE_DIRS`. */
const SMOKE_MARKER = 'const SUITE_DIRS = ['

/** 1-based line number of the character at `offset`. */
function lineAt(text, offset) {
  let line = 1
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === '\n') line += 1
  }
  return line
}

/** How many columns of whitespace a line starts with. */
function indentationOf(line) {
  return /^\s*/u.exec(line)[0].length
}

/** A reader's answer: the entries it found, and `problem: null` for "read fine". */
function read(entries, declLine) {
  return { entries, declLine, problem: null }
}

/** An empty answer, with the reason the source could not be read. */
function unreadable(problem) {
  return { entries: [], declLine: null, problem }
}

/**
 * The suite rows an overlay's top-level `- insert:` blocks name, with lines.
 *
 * A blank line and a full-line comment NEITHER enter nor leave a block: YAML
 * gives them no structure, and the overlay is mostly prose explaining its rows.
 * Every other column-zero line ends the block, because that is where the next
 * top-level row (or the next top-level key) begins.
 *
 * Only `@dsh-app/…` names become entries. The same file also inserts two
 * upstream `@deepseek-ai/…` schedule rows, which are upstream packages the
 * runtime already carries and not suite plugins — including them would make
 * every run report drift against the four roster copies. Which rows are whose
 * is decided by the VALUE's scope, never by which `- insert:` block they sit in
 * or in what order the blocks appear.
 *
 * SCOPE IS THE ONLY THING THIS READER DROPS A ROW FOR, and the two things that
 * could hide a row behind it are both refused instead:
 *
 *   - a name that lost its scope is at least still a NAME, so the comparison
 *     reports the missing name as drift rather than a shorter list;
 *   - a row written in a shape this reader cannot read at all (an inline
 *     `- name: …`, a flow mapping `- {…}`, a `name:` whose value sits on the
 *     next line or behind an anchor/alias/block indicator) yields no name at
 *     all and would otherwise leave the reader with a shorter list that still
 *     agrees with the other four. Every such line is collected and the whole
 *     source is refused — see `misshapen`.
 *
 * That last rule is on the SHAPE, not on the value's scope: a missed row whose
 * value turns out to be `@deepseek-ai/…` would have been excludable, but the
 * reader cannot see the value in every refused shape (a `name:` with its value
 * on the next line names nothing at all), and guessing which missed rows do not
 * matter is how a drift gate starts reading less than it says. The cost is a
 * one-line fix in a file this gate is about.
 *
 * AN ENTRY'S OWN FIELDS ARE TOLD FROM A NESTED `config:` BLOCK'S BY INDENTATION.
 * The entry items of a block sit at one indentation (`    - id: brand`), their
 * own fields exactly two columns deeper (`      name: …`), and a nested block's
 * keys at least two columns deeper again (`        name: …` inside `config:`).
 * So a `name:` key at the items' field indentation is the ENTRY's name, and one
 * deeper than that is a config key that merely happens to be called `name` —
 * which is why the test is on the indentation and not on the key. That deeper
 * key is neither read as an entry nor counted as a missed one.
 *
 * @param text - the overlay's content.
 */
export function readOverlayRoster(text) {
  const entries = []
  const misshapen = []
  let inInsert = false
  let blockAt = 0
  let suiteBlockAt = null
  let itemIndent = null
  let fieldIndent = null
  // Split on either ending: the overlay is a CRLF file on a Windows checkout and
  // an LF one in CI, and every pattern below is anchored to a whole line.
  const lines = text.split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    const line = index + 1
    if (raw.trim() === '' || raw.startsWith('#')) continue
    if (INSERT_ROW.test(raw)) {
      inInsert = true
      blockAt = line
      itemIndent = null
      fieldIndent = null
      continue
    }
    if (!/^\s/u.test(raw)) {
      inInsert = false
      continue
    }
    if (!inInsert) continue

    const item = ITEM_ROW.exec(raw)
    if (item !== null) {
      const indent = item[1].length
      // The block's FIRST item sets the entry indentation, and therefore where
      // the entries' own fields sit. A later `- ` deeper than that is a nested
      // sequence inside some row's config, not an entry of the roster.
      if (itemIndent === null) {
        itemIndent = indent
        fieldIndent = indent + 2
      }
      if (indent !== itemIndent) continue
      const rest = item[2].trim()
      // An empty rest is a block-style item (`- id: brand`), whose fields are
      // the lines below it; anything else on the item line is a shape this
      // reader does not read — an inline field (`- name: …`, `- id: x, name: …`)
      // or a flow mapping (`- {…}`) — so the row would vanish from the set.
      if (rest !== '' && (rest.startsWith('{') || NAME_KEY.test(rest) || /[,{]\s*name\s*:/u.test(rest))) {
        misshapen.push({ line, text: raw.trim() })
      }
      continue
    }

    // A field line of the entry above it. Deeper lines are a nested `config:`
    // block's own keys (see the JSDoc): not an entry, and not a missed one.
    if (fieldIndent === null || indentationOf(raw) !== fieldIndent) continue
    if (!NAME_KEY.test(raw)) continue
    const match = NAME_FIELD.exec(raw)
    if (match === null) {
      misshapen.push({ line, text: raw.trim() })
      continue
    }
    // A quoted value is the entry's name, whatever it says — an unscoped one is
    // a row this reader is right to leave out. A BARE one has to look like a
    // package name, or it is YAML syntax standing for a value elsewhere (see
    // {@link BARE_NAME}), and reading it as the name would drop the row.
    if (match[3] !== undefined && !BARE_NAME.test(match[3])) {
      misshapen.push({ line, text: raw.trim() })
      continue
    }
    const token = match[1] ?? match[2] ?? match[3] ?? ''
    if (!token.startsWith(SUITE_SCOPE)) continue
    // The locator names the block the SUITE rows are in, not the file's last
    // `- insert:` — the overlay also inserts two upstream schedule rows further
    // down, and citing THAT block would send a reader to the wrong rows. Which
    // rows are the suite's is decided by the scope above, not by block order.
    if (suiteBlockAt === null) suiteBlockAt = blockAt
    entries.push({ token, line })
  }
  if (misshapen.length > 0) {
    const [first] = misshapen
    const also = misshapen.length > 1 ? `, and ${misshapen.length - 1} more like it` : ''
    return unreadable(`the overlay writes ${misshapen.length} entry-shaped line(s) this reader does not accept (line ${first.line}: \`${first.text}\`${also}) — a row the gate cannot read is red, not absent`)
  }
  if (entries.length === 0) {
    return unreadable('no top-level `- insert:` row names an `@dsh-app/…` package — the overlay rows were rewritten in a shape this reader does not accept')
  }
  return read(entries, suiteBlockAt)
}

/**
 * Replace every comment in an array body with spaces of the SAME LENGTH, so an
 * offset into the result still addresses the original text — and so a comma
 * inside a trailing `// …` stops being a separator. String literals are copied
 * through untouched, so a `//` inside one is not read as a comment.
 */
function blankComments(body) {
  let out = ''
  let index = 0
  while (index < body.length) {
    const pair = body.slice(index, index + 2)
    if (pair === '//' || pair === '/*') {
      const end = pair === '//' ? body.indexOf('\n', index) : body.indexOf('*/', index + 2)
      const stop = end === -1 ? body.length : end + (pair === '/*' ? 2 : 0)
      out += ' '.repeat(stop - index)
      index = stop
      continue
    }
    if (body[index] === "'") {
      const end = body.indexOf("'", index + 1)
      const stop = end === -1 ? body.length : end + 1
      out += body.slice(index, stop)
      index = stop
      continue
    }
    out += body[index]
    index += 1
  }
  return out
}

/** A comma-separated array body, split into pieces each keeping its offset. */
function commaPieces(body) {
  const pieces = []
  let start = 0
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== ',') continue
    pieces.push({ text: body.slice(start, index), at: start })
    start = index + 1
  }
  pieces.push({ text: body.slice(start), at: start })
  return pieces
}

/**
 * The single-quoted entries of the array literal opened by `marker`.
 *
 * Narrow by construction: the marker is the declaration text itself, so a
 * renamed or reformatted declaration fails rather than reading as "this copy
 * lists nothing", and the body is everything up to the FIRST `]`.
 *
 * The body is then split on commas and EVERY piece has to be exactly one
 * single-quoted string. A piece in any other shape — a double-quoted or
 * backticked string, a bare word, a spread, two strings on one line — yields no
 * entry, and reading past it would hand back a SHORTER list that still agrees
 * with the other four copies. That is the "could not read is red" case, so such
 * a piece refuses the whole source instead.
 *
 * Two limits are accepted rather than engineered around:
 *
 *   - a `]` inside a string would end the body early. These lists hold package
 *     and directory names, which cannot contain one;
 *   - a single-quoted token becomes an entry WHATEVER IT SAYS. A non-plugin
 *     value (a stray string, a second array) is then a name no other copy
 *     carries, which reads as drift. That is a false failure a reader resolves
 *     in seconds — the alternative, filtering tokens by the `plugin-…` shape,
 *     would silently drop a name and report agreement.
 *
 * @param text - the source file's content.
 * @param marker - the declaration text including its `[`, e.g. `const X = [`.
 */
export function readBracketArray(text, marker) {
  const at = text.indexOf(marker)
  if (at === -1) return unreadable(`\`${marker}\` was not found — the declaration was renamed or reformatted`)
  const open = at + marker.length
  const close = text.indexOf(']', open)
  if (close === -1) return unreadable(`the array opened by \`${marker}\` has no closing \`]\``)
  const body = blankComments(text.slice(open, close))
  const entries = []
  const misshapen = []
  for (const piece of commaPieces(body)) {
    const value = piece.text.trim()
    if (value === '') continue
    const line = lineAt(text, open + piece.at + (piece.text.length - piece.text.trimStart().length))
    const quoted = /^'([^']*)'$/u.exec(value)
    if (quoted === null) {
      misshapen.push({ line, text: value })
      continue
    }
    entries.push({ token: quoted[1], line })
  }
  if (misshapen.length > 0) {
    const [first] = misshapen
    const also = misshapen.length > 1 ? `, and ${misshapen.length - 1} more like it` : ''
    return unreadable(`the array opened by \`${marker}\` holds ${misshapen.length} comma-separated piece(s) this reader does not accept (line ${first.line}: \`${first.text}\`${also}) — only single-quoted entries are read`)
  }
  if (entries.length === 0) {
    return unreadable(`the array opened by \`${marker}\` names no single-quoted entry`)
  }
  return read(entries, lineAt(text, at))
}

/**
 * The plugin list the release workflow's pre-build loop iterates.
 *
 * The workflow has ten `for … in …; do` loops; nine iterate platform cells
 * (`win32-x64 …`), release asset names or retry counters, and exactly one
 * iterates plugin directories. The `plugin-` prefix is what tells them apart,
 * and the rule demands exactly one match: two roster-shaped loops would make
 * "which list is the roster" undefined, and guessing one of them is how a gate
 * starts checking the wrong thing.
 *
 * The zero-match branch is also this source's completeness assertion: a roster
 * moved into another shape (a bash array, a `$(…)`, a single-token variable)
 * matches no loop at all, and is refused rather than read as an empty roster.
 *
 * @param text - the workflow's content.
 */
export function readReleaseLoop(text) {
  const lines = text.split('\n')
  const matches = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = FOR_IN.exec(lines[index])
    if (match === null) continue
    const items = (match[2] ?? '').trim().split(/\s+/u).filter((token) => token !== '')
    if (items.length === 0 || !items.every((token) => token.startsWith('plugin-'))) continue
    matches.push({ items, line: index + 1 })
  }
  if (matches.length === 0) {
    return unreadable('no `for … in plugin-…; do` loop was found — the pre-build loop was removed or rewritten')
  }
  if (matches.length > 1) {
    return unreadable(`${matches.length} loops iterate a \`plugin-…\` list (lines ${matches.map((match) => match.line).join(', ')}), so which one is the roster is ambiguous`)
  }
  const [only] = matches
  return read(only.items.map((token) => ({ token, line: only.line })), only.line)
}

/**
 * `SUITE_PLUGINS`, imported rather than re-parsed.
 *
 * The exported value is the authority — the same value `build-runtime.mjs`
 * installs from — so reading it as text would let a formatting change move the
 * gate's opinion away from what the build actually does. The file's text is
 * read for one thing only: the line each entry sits on, so a finding can cite
 * `file:line`. An entry the text does not carry keeps the declaration's line,
 * which still points the reader at the array.
 *
 * @param text - `scripts/kernel-line.mjs` as text.
 */
function kernelSource(text) {
  if (SUITE_PLUGINS.length === 0) return unreadable('SUITE_PLUGINS is exported but empty')
  const at = text.indexOf(KERNEL_MARKER)
  const declLine = at === -1 ? null : lineAt(text, at)
  const lines = text.split('\n')
  const entries = SUITE_PLUGINS.map((token) => {
    const found = lines.findIndex((line) => line.includes(`'${token}'`))
    return { token, line: found === -1 ? declLine : found + 1 }
  })
  return read(entries, declLine)
}

/**
 * The five copies, with the reader that knows each one's shape.
 *
 * `what` is part of the report because the answer to "which copy drifted" is
 * useless without "which fact that copy holds": `plugin-effort` in a loader row
 * and in an npm-install list are the same fact used two ways, and a reader is
 * deciding where to fix it.
 */
const SOURCES = [
  {
    id: 'overlay',
    file: 'plugins/dsh-app.patch.yml',
    what: 'the `- insert:` rows naming `@dsh-app/…` packages',
    read: readOverlayRoster,
  },
  {
    id: 'kernel',
    file: 'scripts/kernel-line.mjs',
    what: 'SUITE_PLUGINS (imported)',
    read: kernelSource,
  },
  {
    id: 'brand',
    file: 'src/main/brand-suite.ts',
    what: 'SUITE_PLUGIN_DIRS',
    read: (text) => readBracketArray(text, BRAND_MARKER),
  },
  {
    id: 'smoke',
    file: 'scripts/smoke-suite.mjs',
    what: 'SUITE_DIRS',
    read: (text) => readBracketArray(text, SMOKE_MARKER),
  },
  {
    id: 'release',
    file: '.github/workflows/release.yml',
    what: 'the pre-build `for … in plugin-…; do` loop',
    read: readReleaseLoop,
  },
]

/** Read every source, recording a read failure as a `problem` rather than a throw. */
export function loadSources(repoRoot = root) {
  return SOURCES.map((source) => {
    let text
    try {
      text = readFileSync(path.join(repoRoot, source.file), 'utf8')
    } catch (error) {
      return {
        id: source.id,
        file: source.file,
        what: source.what,
        ...unreadable(`cannot be read: ${error instanceof Error ? error.message : String(error)}`),
      }
    }
    return { id: source.id, file: source.file, what: source.what, ...source.read(text) }
  })
}

/** The directory name a roster token speaks in, whichever form it was written in. */
export function dirNameOf(token) {
  return token.startsWith(SUITE_SCOPE) ? token.slice(SUITE_SCOPE.length) : token
}

/** Whether two lists hold the same names in the same order. */
function sameList(left, right) {
  return left.length === right.length && left.every((name, index) => name === right[index])
}

/**
 * Compare the copies against each other.
 *
 * Every copy is a PEER: no copy is the reference, so a finding names the name
 * and both sides — the copies that carry it (`file:line` of the entry) and the
 * copies that do not (`file:line` of the array or loop that should have held
 * it). Naming a "correct" copy would be a product decision, not a fact this
 * check can read off the tree, and it would hide half the fix: an entry added
 * to one copy and missing from four reads identically to the reverse.
 *
 * @param sources - readers' answers, each `{ id, file, entries, declLine }`.
 */
export function compareRosters(sources) {
  const lists = sources.map((source) => ({
    source,
    names: source.entries.map((entry) => dirNameOf(entry.token)),
  }))

  // The names to report on, in first-appearance order across the copies, so the
  // report reads in the same order as the files a reader will open.
  const names = []
  for (const { names: list } of lists) {
    for (const name of list) if (!names.includes(name)) names.push(name)
  }

  const drift = []
  for (const name of names) {
    const present = []
    const absent = []
    for (const { source, names: list } of lists) {
      if (!list.includes(name)) {
        absent.push(source)
        continue
      }
      const entry = source.entries.find((candidate) => dirNameOf(candidate.token) === name)
      present.push({ source, token: entry?.token, line: entry?.line })
    }
    if (absent.length > 0) drift.push({ kind: 'membership', name, present, absent })
  }

  for (const { source, names: list } of lists) {
    const seen = new Set()
    const repeated = []
    for (const name of list) {
      if (seen.has(name) && !repeated.includes(name)) repeated.push(name)
      seen.add(name)
    }
    if (repeated.length > 0) drift.push({ kind: 'duplicate', name: repeated.join(', '), source })
  }

  // Reported, never fatal: see the module header for why no consumer of these
  // lists depends on their order. Computed only when membership already agrees —
  // a copy that is missing a name is trivially "in a different order", and
  // printing that beside the real finding is noise on the one report a reader
  // acts on.
  const order = drift.length > 0
    ? []
    : lists
      .slice(1)
      .filter(({ names: list }) => !sameList(list, lists[0].names))
      .map(({ source }) => source)

  return { ok: drift.length === 0, names, drift, order }
}

/** The `file:line` a finding should cite for one copy. */
function locate(source, line = null) {
  const at = line ?? source.declLine
  return at === null ? source.file : `${source.file}:${at}`
}

/**
 * The gate's exit code.
 *
 * Extracted from {@link main} because the ORDER of the three answers is the part
 * that must not be got wrong, and this is the only place it is decided:
 *
 *   - an unreadable source is 2 whatever else is true — including "no drift
 *     among the copies that could be read", which is the answer that would
 *     otherwise be reported and believed;
 *   - real drift is 1 only under `--check`. Without it the run reports and
 *     exits 0, like the other checks in this directory: a reader asking "what do
 *     the five copies say" is not a caller asking for a verdict;
 *   - otherwise 0.
 *
 * @param input.unreadable - whether any source failed to read.
 * @param input.ok - whether the readable copies agree.
 * @param input.check - whether the caller asked for a verdict.
 */
export function exitCodeFor({ unreadable, ok, check }) {
  if (unreadable) return 2
  if (check && !ok) return 1
  return 0
}

function parseArgs(argv) {
  const args = { check: false, json: false, root }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--check') { args.check = true; continue }
    if (token === '--json') { args.json = true; continue }
    if (token === '--root') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('--root needs the directory to read the copies from')
      args.root = value
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${token}`)
  }
  return args
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error('usage: node scripts/check-suites-drift.mjs [--check] [--json] [--root <dir>]')
    console.error(`[suites-drift] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
    return
  }

  const sources = loadSources(args.root)
  const problems = sources.filter((source) => source.problem !== null)
  const verdict = compareRosters(sources)
  // A source that could not be read has no names, so comparing it reports every
  // other copy's names as "absent" from a copy the report has already said was
  // never read: two statements contradicting each other in one report. The
  // membership findings are the part that is not a fact when a copy is missing,
  // so they are withheld in BOTH output modes, and the unreadable copy is what
  // the reader is told about.
  const readable = problems.length === 0
  const drift = readable ? verdict.drift : []
  const order = readable ? verdict.order : []

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      sources: sources.map((source) => ({
        id: source.id, file: source.file, what: source.what, entries: source.entries.length,
        declLine: source.declLine, problem: source.problem ?? null,
      })),
      names: verdict.names.length,
      ok: verdict.ok,
      drift,
      order: order.map((source) => source.id),
      unreadable: problems.map((source) => `${source.id} (${source.file}): ${String(source.problem)}`),
    }, null, 2)}\n`)
  } else {
    console.log(`suite drift check — ${sources.length} copies of the suite roster`)
    console.log('')
    for (const source of sources) {
      const count = source.problem === null ? String(source.entries.length) : '--'
      console.log(`  ${source.id.padEnd(8)} ${locate(source).padEnd(48)} ${count.padStart(2)}  ${source.what}`)
    }
    console.log('')
    if (readable) {
      console.log(`${verdict.names.length} distinct names across the ${sources.length} copies`)
    }
    if (readable && verdict.ok) {
      console.log('no drift: every copy names the same set of plugins')
    }
    if (drift.length > 0) {
      console.log('')
      for (const finding of drift) {
        if (finding.kind === 'duplicate') {
          console.log(`[drift] ${finding.name} is listed twice by ${finding.source.id} (${locate(finding.source)})`)
          continue
        }
        console.log(`[drift] ${finding.name}`)
        for (const hit of finding.present) console.log(`      present  ${hit.source.id.padEnd(8)} ${locate(hit.source, hit.line)}  ${hit.token ?? ''}`)
        for (const source of finding.absent) console.log(`      absent   ${source.id.padEnd(8)} ${locate(source)}`)
      }
    }
    if (order.length > 0) {
      console.log('')
      console.log('(note, not a failure: these copies list the same names in a different order — no consumer reads the order)')
      for (const source of order) console.log(`      ${source.id.padEnd(8)} ${locate(source)}`)
    }
  }

  // A source that could not be read is never a pass — not by exit code and not
  // by the report above, which withheld its membership findings for the same
  // reason: the gate would otherwise answer about the roster when the fact it
  // could not establish is about the reader.
  if (problems.length > 0) {
    console.error('')
    console.error(`[suites-drift] ${problems.length} of the ${sources.length} copies could not be read, so their membership is not a fact — the drift section is withheld:`)
    for (const source of problems) {
      console.error(`[suites-drift]   ${source.id} (${source.file}) — ${String(source.problem)}`)
    }
  } else if (args.check && !verdict.ok) {
    console.error('')
    for (const finding of drift) {
      if (finding.kind === 'duplicate') {
        console.error(`[suites-drift] ${finding.name} is listed twice by ${finding.source.file} — update all five copies in one commit`)
        continue
      }
      console.error(`[suites-drift] ${finding.name} is named by ${finding.present.length} of the ${sources.length} copies and not by: ${finding.absent.map((source) => `${source.id} (${locate(source)})`).join(', ')} — update all five copies in one commit`)
    }
  }

  process.exitCode = exitCodeFor({ unreadable: problems.length > 0, ok: verdict.ok, check: args.check })
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) main()
