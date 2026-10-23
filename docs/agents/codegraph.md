# codegraph — the code knowledge graph

`plugins/plugin-codegraph` keeps one SQLite graph per project: the files, the
symbols they declare, the edges between them, and the prose that names them. It
exists so a model can ask "where is X", "what breaks if I change X" and "what do I
need to know about X" without reading the whole tree.

This file is the map: what the graph holds, which decision each module owns, and
the three ways it can be quietly wrong.

## 1. What the graph holds

Four tables, one schema version (`SCHEMA_VERSION` in `src/store.ts`; a mismatch
rebuilds rather than migrates, because a graph is derived data).

| Table | One row is | Key |
|---|---|---|
| `files` | a file the pass looked at, with its stat cache | `path` |
| `symbols` | a declaration | `id` = `<path>#<kind>:<parent>.<name>` |
| `edges` | a relation between two nodes | `(src, dst, kind)` |
| `meta` | the project's own state | one row |

`edges.src` / `edges.dst` are NODE ids, and a node is one of three things:

- `file:<path>` — the file itself (`imports`, `contains`, a call at file scope);
- a symbol id — a declaration;
- `doc:<path>#<line>` — a line of prose (`documents` edges only).

Two properties of symbol ids matter and both were paid for:

- **No line number.** Re-formatting a file must not invalidate every reference to
  its symbols.
- **An ordinal for overloads** (`…#m#1`). The id is a primary key, so two
  same-named methods on one class collided and failed the whole file's write.

## 2. Which module decides what

| Module | Owns | Never does |
|---|---|---|
| `src/store.ts` | the schema, and `replaceFile` / `forgetFile` as the only writers | read the disk |
| `src/languages.ts` | which extensions map to which grammar, and the download + sha512 check | parse |
| `src/parse.ts` | the per-language extraction tables (`GRAMMAR_SHAPES`) | touch the disk |
| `src/docs.ts` | which symbols a document NAMES | parse markdown |
| `src/indexer.ts` | the walk, the incremental comparison, the three phases | write SQL |
| `src/query.ts` | every read the three tools perform | own state |
| `src/routes.ts` | the settings page's and the pages' HTTP surface | compute index state |
| `src/client/page.tsx` | the sidebar page: every project, then one project's graph | own a second copy of the graph surface (it reuses `GraphPanel`) |
| `src/index.ts` | tool registration and the composition | — |

`store.ts` is the only module that writes SQL and `indexer.ts` is the only module
that reads the disk, which is what makes each one testable without the other.

## 3. The pass, in three phases

`indexProject` runs one pass. The split is not cosmetic — each phase exists
because the next needs its result.

1. **Files → symbols.** Every changed file is parsed and `replaceFile` writes its
   symbols plus its `contains` edges. A document is stored here too, with no
   symbols, because the row is the stat cache that stops a re-read every pass.
2. **Calls and imports.** Resolved against the finished symbol table, in one
   transaction. A call edge starts at the SYMBOL that contains the call, or at the
   file when the call is at file scope.
3. **Documents.** Each changed document is scanned for the symbols it names, and
   each mention becomes a `documents` edge. Its own transaction for the same
   reason phase 2 has one.

Phases 2 and 3 must be transactional and separate from phase 1: their file rows
are already committed, so the next pass would SKIP those files and the edges would
be lost permanently rather than retried.

Every 64 files the pass yields to the event loop. Without it a 20 000-file pass
holds the kernel's loop for its whole duration and no tool call can ever observe
the `indexing` state — the state machine would be unreachable in practice.

## 4. The three ways this can be quietly wrong

These are the failure modes the code is shaped around. Each one produces a
plausible answer that is wrong, which is worse than an error.

**A truncated walk read as a complete one.** The walk stops at `MAX_FILES`, and an
unreadable root reads as zero files. Either way the removal pass must NOT run:
"everything else is gone" is a catastrophic conclusion from a partial scan. The
skip is persisted (`removalSkipped`) and reported, never silent.

**A missing language read as "no symbols here".** A grammar that is not installed,
or one with no extraction shape, answers `LANGUAGE_UNSUPPORTED` and is counted —
but the two counts are SEPARATE (`meta.missingLanguage` versus `meta.noRules`).
Collapsing them told users "N files skipped because the language is not installed"
for projects whose only gap was a `.css` file, so the settings page asked them to
download something that would not help. Measured on this machine: every skipped
file belonged to a language that was already installed.

**An ambiguous name resolved to one match.** A call target that resolves to two or
more declarations produces NO edge. The graph under-reports; it never guesses.

Two smaller versions of the same principle: one document line naming a symbol
three times is ONE edge (three would inflate counts without adding a place to
read), and a document mentions only names the graph already declares (otherwise
every English word is an edge).

## 5. Restoring the project list

The queue keeps its project list in memory, so a restart used to show only the
project a session happened to open — five graphs could be on disk with one
visible. At activation the plugin now walks `storages/.../projects/` and adopts
every graph that carries `meta.cwd` (the directory name is a hash of the root and
cannot be reversed). It reads metadata only; no pass is queued.

## 6. When a pass runs

Three triggers, and they share one queue:

1. **A session enters a project** (`session/created`) — covers a new session AND a
   resumed one, so an old session reopened after install still gets indexed. The
   graph used to be built only when a tool was called, which left the settings
   page and the view empty for every project the user had not queried.
2. **A tool is called** in a project with no current graph.
3. **The settings page or the view asks** — the re-index action, and a stale read.

`queue.request` is idempotent while a project is queued or running, so several
sessions on one project cost one pass. A failure is recorded on the project and
reported by the settings page; the `session/created` listener swallows it there
and only there, because a rejected promise inside session creation would surface
as a broken session.

## 7. Staying out of the kernel's way

The index runs on the KERNEL's event loop, so a phase that never yields does not
just make the graph slow — it freezes the whole UI. Measured on a 1771-file
project before these fixes: a first pass held the loop for **241 seconds**, during
which the window stopped answering, the settings pane came up empty and "new
session" did nothing. The user-visible symptom is indistinguishable from losing
every setting.

Four rules follow, each paid for:

- **Yield by TIME, not by file count.** A fixed "every 64 files" bound is not a
  bound: 64 files that each need a parse and a transaction is seconds. The pass
  yields after 8ms of work, whatever the files weigh.
- **Commit in batches.** Phase 2 commits every 50 files and phase 3 every 25
  documents, with a `setImmediate` between batches, so one long phase cannot hold
  the loop for its duration.
- **A mention points at ONE declaration.** This was the single largest cost: a
  real project's documents produced 103,334 mentions, and at 20 targets each that
  is two million inserts. The scan itself is cheap (117ms for the same documents);
  the fan-out is what cost 64 seconds.
- **Re-derive document edges only when the answer can change** — a document whose
  bytes moved, or a source file that added or retired symbols. A second pass over
  an unchanged tree costs **93ms** instead of tens of seconds.

After the fixes, the same project: first pass **17.9s** (longest stall 3.0s),
second pass **93ms** (longest stall 64ms).
## 8. The three tools, and the question that names no symbol

`codegraph_find` (where is X declared), `codegraph_impact` (who uses X) and
`codegraph_context` (what is X's neighbourhood) split by the QUESTION asked, not
by the data touched — three tools is prompt budget the model spends on every turn.

The first two need a name and always will. `codegraph_context` used to require one
too, which made the plugin unreachable for the question it was built to answer:
"what is this project, where does it start" names no symbol, so the model had
nothing to pass and fell back to listing directories and reading files. Measured
in a real session with the graph already built: one orientation question produced
`working_directory`, a file search and four reads. `symbol` is now optional, and
omitting it answers a **project overview** from the graph's own shape — counts,
the language split, the files nothing imports, and the most-referenced symbols.

Two ordering rules in that overview were paid for by looking at real output on a
1771-file monorepo, not by reasoning about it:

- **Test, example and script files rank last** (not out). A test is imported by
  nothing, so in-degree alone filled every row with `*.test.ts`. Dropping them
  would answer an empty list for a test-heavy project, so they stay, demoted.
- **A conventional entry filename outranks symbol count.** The real CLI there is
  imported by its own `bun/cli.ts` wrapper, so it has in-degree one and never
  appeared — while a 371-symbol HTML template did.
- **Hubs are top-level declarations only, and never a `variable`.** The unguarded
  query answered `.filter` (975 referrers), `.trim` (512) and `.includes` (476):
  built-in method names matching variables the parser recorded.

## 9. Freshness

Every tool answer carries it, and the three values mean different things to a
model: `current` — trust it; `stale` — the working tree moved, trust then refresh;
`indexing` — wait, this is a first touch. `unindexed` exists in the store type but
no tool answer emits it, because the first call queues a pass.

`isStale` compares the stored git HEAD to a fresh one and is deliberately
three-state: no repository on either side means "cannot prove", which must NOT
read as stale — a pass writes `''` again and the graph would rebuild forever.

## 10. What it does not do

Stated here because the tool descriptions promise exactly this and no more:

- **Name resolution only.** No types, no scopes, no shadowing. A method called on
  an object of unknown type is a name match, and an ambiguous one is dropped.
- **No data flow, no control flow.** The graph is a structural index, not a
  program analysis.
- **Documents are not parsed.** No section tree, no anchors, no link following.
  A mention is a line number, which is what lets a reader open the sentence.
- **The graph is derived.** Delete it and the next pass rebuilds it; nothing else
  in the app depends on it existing.

## 11. Where the tests are blind

Three layers, each blind to something:

- **The plugin suites** (`plugins/plugin-codegraph/tests/`) read code. A CSS rule
  that computes to the wrong layout, or a component that renders a different DOM
  than the stylesheet shapes, passes all of them.
- **`scripts/probe-codegraph-langs.cjs`** measures the RENDERED language row in
  Chromium: the action shares a line with the name at the grid's 240px floor, the
  name is not truncated, and cards in one grid keep one height. It boots no
  kernel, so it proves the stylesheet against a row it builds itself — its last
  three assertions read `section.tsx` for exactly that reason, because a
  layout measurement cannot see which JSX produced the DOM it measured.
- **Nothing automated** covers the settings page inside a real client. That needs
  a packaged runtime (`scripts/probe-settings-nav.cjs` is the shape) and is the
  manual step before a release.

**A fourth, narrower gap worth knowing.** `tests/parse.test.ts` has one case per
extraction-table row, and each runs a REAL grammar: a node name the grammar does
not produce yields no symbol and the case fails. That covers the nine bundled
languages on every run. The four on-demand tables (`rust`, `ruby`, `php`, `bash`)
are verified only where their wasm is present, because the repository ships no
second copy of a download.

CI closes that gap instead of accepting it: `ci.yml` runs
`plugins/plugin-codegraph/scripts/fetch-ci-grammars.mjs` before the plugin suites
and points `DSH_APP_CODEGRAPH_GRAMMARS` at what it fetched. The script goes
through the product's own `downloadGrammar`, so the recorded sha512 and the wasm
magic check apply to those bytes exactly as they do to a user's, and a fetch
failure is fatal rather than a quiet fallback to skips. A local run without that
variable prints **16 skips** — visible in the count, never silent — and
`DSH_APP_CODEGRAPH_GRAMMARS=<dir>` runs all 233.
