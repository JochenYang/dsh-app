/**
 * What the three tools SAY, as pure functions over their canonical values.
 *
 * Why extracted. The renderers used to be closures inside `defineTool`, so the only
 * way to assert a sentence was to grep the source file — and that is how one defect
 * survived a suite: the render named `referencing.length` "file(s)", and a source
 * guard could only prove the template was gone, not that the answer read correctly.
 * The Model's whole exposure to this plugin is this text; a text bug is the bug.
 *
 * A renderer is pure: args + value in, content blocks out. Nothing here reads a
 * graph, a queue or a clock, so every claim it makes is decided by the answer it was
 * handed — which is the property that makes the tests below meaningful.
 *
 * @module @dsh-app/plugin-codegraph/tool-text
 */

import { formatSymbol, type ContextResult, type FindResult, type ImpactResult, type RelatedGroup } from './query.ts'

/** The block shape the kernel's `render` returns. */
export interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

/** Wrap lines as the single text block every tool answer is. */
function block(lines: readonly string[]): TextBlock[] {
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * The label for one relationship group.
 *
 * EVERY kind gets its own words, and an unknown kind gets a neutral one. The render
 * used to collapse them: `type_refs` was "mentioned in a signature", `extends` was
 * "derived from this", and EVERYTHING ELSE — including `implements`, `exports` and
 * any kind added later — was printed as "implements this". `exports` is the one that
 * mattered: its rows are the FILE that publishes the symbol (an `exports` edge starts
 * at a file node), so "N implements this" named a relationship that does not exist
 * and attributed it to a file. A reader debugging a type hierarchy was told a module
 * implements it.
 *
 * @param kind - the edge kind of the group.
 * @returns the heading, without the row count.
 */
export function relationLabel(kind: string): string {
  switch (kind) {
    case 'extends': return 'derived from this (subclasses)'
    case 'implements': return 'implements this'
    case 'type_refs': return 'mentioned in a signature'
    // `exports` rows are FILES, not declarations: the edge starts at the module
    // that publishes the symbol. "exported from" is the relation a reader can act on.
    case 'exports': return 'exported from this module'
    default: return `related by ${kind === '' ? 'an unnamed relation' : kind}`
  }
}

/**
 * Render one relationship group, saying so when IT was cut.
 *
 * The cut is per group, not per answer. Before this, `relatedTo`'s single boolean was
 * merged into `truncated`, the render warned only about `references`, and a group cut
 * at 40 rows with 300 behind it printed 40 rows under a heading with no count — a
 * sample presented as the set.
 */
function relationLines(group: RelatedGroup): string[] {
  const head = `${relationLabel(group.kind)} (${String(group.rows.length)}${group.total === undefined ? '' : ` of ${String(group.total)}`}):`
  return [
    head,
    ...group.rows.map(row => `- ${row.path}:${String(row.line)}${row.name === undefined ? '' : ` (${row.name})`}`),
    ...(group.truncated
      ? [`TRUNCATED: this "${group.kind}" list is a sample${group.total === undefined ? '' : ` — ${String(Math.max(0, group.total - group.rows.length))} more exist`}, not the complete set.`]
      : []),
  ]
}

/**
 * Render one `codegraph_impact` answer.
 *
 * @param args - the parsed call arguments, for the ambiguity sentence.
 * @param result - the canonical value the tool produced.
 * @returns the text content the model reads.
 */
export function renderImpact(args: unknown, result: ImpactResult): TextBlock[] {
  const selector = typeof (args as { symbol?: unknown } | undefined)?.symbol === 'string'
    ? (args as { symbol: string }).symbol
    : ''
  if (result.target === undefined) {
    if (result.candidates.length > 0) {
      // An ambiguous name is NOT an absent one, and the sentence has to say which.
      //
      // It used to say "no reference edges were built for it", which stopped being
      // true when `parse.ts`'s `linkTargets` started linking to every declaration of
      // a shared name (up to ten): the edges exist, this selector simply names
      // several targets. Saying otherwise taught the model to conclude "nothing calls
      // this", which is the one wrong conclusion the tool exists to prevent.
      const lines = [
        `codegraph_impact: "${selector}" is declared ${String(result.ambiguity)} time(s), so this answer cannot pick one target — the reference edges exist, but they belong to several distinct declarations. Pass one of these ids to ask about exactly one:`,
        ...result.candidates.map(candidate => `- ${formatSymbol(candidate)} (id: ${candidate.id})`),
        'An ambiguous name is not an absent one: this answer says nothing about how many callers exist for any single one of these. Run `codegraph_impact` on each id above, or verify with a text search, before changing anything.',
      ]
      return block(lines)
    }
    return block([`codegraph_impact: no symbol named that in this project${result.note === undefined ? '' : `\nnote: ${result.note}`}`])
  }

  // THE LIST COUNTS. `lists` is present on every answer this plugin builds; the
  // fallbacks exist so a hand-constructed value (a test, an older consumer) still
  // renders, and they derive from the arrays rather than asserting completeness.
  const referencesShown = result.lists?.references.shown ?? result.referencing.length
  const referencesTotal = result.lists?.references.total ?? result.total
  const referencesCut = result.lists?.references.truncated ?? result.truncated
  const importsShown = result.lists?.imports.shown ?? result.imports.length
  const importsTotal = result.lists?.imports.total ?? importsShown
  // Only `lists` knows whether the imports list was cut; a hand-built value without it
  // has no way to claim a cut, and claiming none is the honest default.
  const importsCut = result.lists?.imports.truncated ?? false

  // TWO numbers, each labelled with what it actually counts. This line used to read
  // `referenced from ${rows.length} file(s)` where rows were EDGES, so a symbol with
  // 664 call sites across 110 files was announced as "664 file(s)".
  const referrerFiles = new Set(result.referencing.map(ref => ref.path)).size
  const lines = [
    `codegraph_impact: ${formatSymbol(result.target)}`,
    ...(result.note === undefined ? [] : [`note: ${result.note}`]),
    ...(referencesCut
      ? [
          `referenced from ${String(referencesTotal)} reference(s) — ${String(referencesShown)} shown, across ${String(referrerFiles)} file(s):`,
          ...result.referencing.map(ref => `- ${ref.path}:${String(ref.line)}`),
          `TRUNCATED: ${String(Math.max(0, referencesTotal - referencesShown))} more reference(s) exist. This is a SAMPLE, not the complete list — verify with a text search before concluding anything about callers.`,
        ]
      : [
          `referenced from ${String(referencesTotal)} reference(s) across ${String(referrerFiles)} file(s):`,
          ...result.referencing.map(ref => `- ${ref.path}:${String(ref.line)}`),
        ]),
    // The forward direction, with its OWN cut. It used to print up to 40 paths with
    // no count and no warning, so a file importing 300 modules listed 40 as if that
    // were all of them.
    ...(result.imports.length === 0
      ? []
      : [
          `its file imports (${String(importsShown)}${importsCut ? ` of ${String(importsTotal)}` : ''}):`,
          ...result.imports.map(path => `- ${path}`),
          ...(importsCut
            ? [`TRUNCATED: the imports list is a sample — ${String(Math.max(0, importsTotal - importsShown))} more import(s) exist. Do not read it as the file's complete dependency set.`]
            : []),
        ]),
    // The other relationships, each under its own heading and each reporting its own
    // cut. A class that implements an interface does not call it, so these are not
    // callers — and "who implements this" is the question a reader has about an
    // interface.
    ...result.related.flatMap(relationLines),
    // An empty list is the one answer that reads as "safe to change", and it is also
    // the answer name-only resolution produces for a call through an interface, a
    // dynamic dispatch, or a variable forwarding path. Said every time, not only when
    // something was truncated.
    ...(result.referencing.length === 0 && result.total === 0
      ? ['No direct callers found. That is NOT "safe to change": a call through an interface, a dynamic dispatch or a variable holds no name to resolve, so it leaves no edge. Verify with a text search.']
      : []),
  ]
  return block(lines)
}

/**
 * Render one `codegraph_find` answer.
 *
 * @param result - the canonical value the tool produced.
 * @returns the text content the model reads.
 */
export function renderFind(result: FindResult): TextBlock[] {
  // The count goes ON the row, and the advice goes LAST. A caller count is what tells
  // the model whether the next question is cheap or expensive: at 7 matches a text
  // search is the right tool, at 482 it costs ~15k tokens and a judgement per line.
  const lines = result.symbols.map((symbol) => {
    const row = `- ${formatSymbol(symbol)} — ${String(symbol.references)} call site(s)`
    return symbol.references > 20
      ? `${row} (large: \`codegraph_impact("${symbol.id}")\` is cheaper than searching)`
      : row
  })
  const head = `codegraph_find: ${String(result.symbols.length)} match(es)${result.truncated ? ' (truncated)' : ''}`
  return block([head, ...(result.note === undefined ? [] : [`note: ${result.note}`]), ...lines])
}

/**
 * Render one `codegraph_context` answer.
 *
 * @param result - the canonical value the tool produced.
 * @param maxRows - the row limit the answer was cut at, for the truncation sentence.
 * @returns the text content the model reads.
 */
export function renderContext(result: ContextResult, maxRows: number): TextBlock[] {
  if (result.file !== undefined) {
    // The outline, rendered as an outline: one line per declaration with its caller
    // count, so "which of these is the public surface" is readable without asking
    // again. The ids are printed because this list is the one a reader expands from.
    const lines = [
      `codegraph_context: ${result.file.path} declares ${String(result.file.symbols.length)} symbol(s)${result.truncated ? ' (TRUNCATED — more exist)' : ''}`,
      ...(result.note === undefined ? [] : [`note: ${result.note}`]),
      // Exported first (the query orders them so) and marked, because "what does this
      // module expose" is the question this branch exists for.
      ...result.file.symbols.map(entry => {
        const parent = entry.parent === undefined ? '' : `${entry.parent}.`
        const mark = entry.exported ? ' [exported]' : ''
        return `- ${entry.kind} ${parent}${entry.name}:${String(entry.line)} — ${String(entry.references)} call site(s)${mark} (id: ${entry.id})`
      }),
      ...(result.file.reExports.length === 0
        ? []
        : ['re-exports these modules whole:', ...result.file.reExports.map(path => `- ${path}`)]),
      ...(result.imports.length === 0 ? [] : ['imports:', ...result.imports.map(path => `- ${path}`)]),
      'Pass any id above as `symbol` to expand it, or use `codegraph_impact` for what a change would touch.',
    ]
    return block(lines)
  }
  if (result.overview !== undefined) {
    const o = result.overview
    const lines = [
      `codegraph_context: project overview — ${String(o.files)} files, ${String(o.symbols)} symbols, ${String(o.edges)} edges${o.truncated ? ' (lists truncated)' : ''}`,
      ...(result.note === undefined ? [] : [`note: ${result.note}`]),
      `languages: ${o.byLanguage.map(entry => `${entry.lang} ${String(entry.files)}`).join(', ')}`,
      `entry candidates (${String(o.entryCandidates.length)}) — nothing imports these:`,
      ...o.entryCandidates.map(entry => `- ${entry.path} (${String(entry.symbols)} symbol(s))${entry.symbol === undefined ? '' : ` starts at ${entry.symbol.kind} ${entry.symbol.name}:${String(entry.symbol.line)}`}`),
      `most referenced (${String(o.hubs.length)}):`,
      // The ID, not just the name: this line is the invitation to expand a hub, and a
      // name is not always a selector (`resolveSymbol` refuses a shared one).
      ...o.hubs.map(hub => `- ${hub.symbol.id} — ${String(hub.references)} call site(s)`),
      'Pass one of those ids as `symbol` to expand it, or a file path for its outline.',
    ]
    return block(lines)
  }
  if (result.symbol === undefined) {
    return block([`codegraph_context: no unambiguous symbol matched${result.note === undefined ? '' : `\nnote: ${result.note}`}`])
  }
  const lines = [
    `codegraph_context: ${formatSymbol(result.symbol)}`,
    ...(result.note === undefined ? [] : [`note: ${result.note}`]),
    `same file (${String(result.siblings.length)}):`,
    ...result.siblings.map(symbol => `- ${formatSymbol(symbol)}`),
    ...(result.calls.length === 0 ? [] : ['calls made from here:', ...result.calls.map(edge => `- ${edge.name ?? '?'} at line ${String(edge.line)}`)]),
    ...(result.calledBy.length === 0 ? [] : ['called by:', ...result.calledBy.map(edge => `- ${edge.path ?? '?'}:${String(edge.line)}`)]),
    ...(result.imports.length === 0 ? [] : ['imports:', ...result.imports.map(path => `- ${path}`)]),
    ...(result.documents.length === 0 ? [] : ['described in:', ...result.documents.map(doc => `- ${doc.path}:${String(doc.line)}`)]),
    // The symbol branch's lists share one boolean, so the sentence names no count. It
    // is still an unmistakable statement that the answer is partial, which is the
    // property that matters; `impact` is where per-list counts decide a model's next
    // step, and there each list reports its own.
    ...(result.truncated === true ? [`TRUNCATED: at least one list was cut at ${String(maxRows)} rows. Treat these as a sample, not the whole neighbourhood.`] : []),
  ]
  return block(lines)
}
