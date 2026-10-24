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

## 4. The four ways this can be quietly wrong

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

**Two surfaces reporting one concept with different numbers.** The most recent
member, and the hardest to notice because neither answer is wrong on its own:

| surface | used to say | counts |
|---|---|---|
| the overview's hub row | `203 referrer(s)` | `COUNT(DISTINCT src)` — distinct calling symbols |
| `codegraph_impact` | 664 rows | reference EDGES |
| `codegraph_impact`'s render | `referenced from 664 file(s)` | reference EDGES, labelled "files" |

Measured on one real function: **203 / 664 / 110 files**. Three labels, two
quantities, one symbol. The model reads 203 in its context, asks the tool, gets 664,
and has no way to tell which is real — while the render calls the same 664 "files",
which is a third number again (110).

Truncation at least carries a signal. This carries none: every number looks like an
answer. The rule that follows is narrow and absolute — **a count is published with
the noun of the thing it counts, and the same concept uses the same noun
everywhere**. Both are now `call site(s)` / `reference(s)`, and
`referencesTo`-style edge counts are labelled as edges, never as files.

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

That walk is **deferred past activation** (`ctx.effect` + `setTimeout(0)`): reading
each graph takes an exclusive SQLite lock, and on a machine whose graph was
mid-pass it blocked the kernel's event loop — the window went dead with an empty
settings pane and a view stuck on "loading". Restoring a list is not worth a
millisecond of that, and a graph this process cannot read must not stop the plugin
from loading.

## 5a. Deleting a graph

The settings page's delete action (`action: 'forget'`) removes one project's whole
directory under `projects/` — `graph.db` plus the WAL and SHM sidecars beside it.
Three steps, each for a measured reason:

1. **close the open handle first** — Windows refuses to delete a file another
   handle holds, so deleting before closing fails with EBUSY;
2. **drop the queue entry** — otherwise the settings list keeps showing the
   project, and the next `graphFor` re-creates an empty database at the same path;
3. **remove the directory through `removeTree`**, never `rmSync({recursive:true})`
   — the sync call descends through a junction
   (`test/recursive-delete-guard.test.mjs` holds the contrast).

The directory comes from `graphFileFor`, which hashes the cwd, and the route
refuses any cwd the queue never opened — the same fence `reindex` has. Without it
a request body would choose which directory gets deleted.

This exists because nothing else ever removes a graph: a project dropped from the
workspace leaves its directory behind forever, and the space is real (124 MB for
two projects on this machine).

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

### 7a. A failed pass must not lose edges permanently

Phase 1 commits each changed file's `mtime`/`size`/`hash`; phase 2 builds its
reference edges in batches (the yielding above is why). A failure part-way through
phase 2 therefore rolls back only the batch in flight — every earlier batch stays,
**and so do the `files` rows from phase 1**. The next pass then compares mtime,
sees "unchanged", skips the file, and the `references` edges that phase 1's range
delete already removed are never rebuilt. The graph reports `current` while
under-reporting every caller of those files.

The old single-transaction phase 2 got this for free; batching it is what re-opened
the hole. The recovery is now explicit: a failed pass deletes the stat-cache row of
every file still pending (`forgetStatCache` in `indexer.ts`), so the next pass
re-parses them. Only the `files` row goes — the symbols stay, so a lookup still
answers while the edges are being repaired.

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
- **One count per symbol.** The hub row names the **edge** count, not
  `COUNT(DISTINCT src)`. Measured: the distinct-source count was 203 for a symbol
  whose `codegraph_impact` answer carries 664 rows, so the overview named a number
  a third of what the tool it invites the model to call would say — and the model
  cannot tell which to trust. The edge count is what the tool reports and what its
  row limit applies to, so "664 call site(s)" and "TRUNCATED at 40" describe one
  list. Two numbers for one concept is worse than either number alone.

### 8a. Why the overview is pushed, not offered

The tools are reachable and were correctly described, and a real session still
answered "where does this project start" with `glob` + `read` eight times. Its own
reasoning recorded the failure precisely:

    I should use codegraph_find / codegraph_context to find entry points.
    Plan:
    1. glob package.json, read root package.json
    2. Look at packages/coding-agent package.json bin field
    3. Find main entry file (src/main.ts? cli.ts?) and trace initialization.

The model thought of the tool and then dropped it while listing the plan. A tool
description is an **instruction**, and an instruction loses to the "explore = list
directories, read files" prior at exactly that step. Adding more description cannot
fix it — the model had already quoted the description.

So the overview is registered as runtime context (`ctx.systemPrompt.context`), not
as another tool. It is the **answer** rather than an instruction, and it arrives
before the plan exists: counts, language split, entry candidates and hubs are
already in context, so "what is this project" has nothing left to explore.

Three properties make it safe to run on every turn:

- **Bounded** — five entry candidates, five hubs, three languages, ~14 lines. This
  is context spent on every turn; an unbounded list would cost more than the reading
  it saves.
- **Silent when it cannot back itself up** — no graph, an empty graph or an
  `indexing` graph contributes `''`. "0 files" would read as a fact about the
  project rather than about the pass. A `failed` pass says so with its recorded
  reason instead of asserting a shape: it is terminal until a human retries, so any
  shape it left has no bounded age.
- **Evaluated per assembly** — a fresh graph, a re-index or a new session all land
  without a restart.

The overview reports `stale` one observation late: the queue's state flips only
after a tool call or a pass noticed HEAD moved, because deciding staleness is async
(`await gitHead`) and the context provider must return synchronously.

The five states are decided in `prompt.ts`'s `overviewContextText`, a pure function,
so the matrix is testable without a Context, a queue or a database — `apply` only
reads cwd/status/meta/overview and calls it.

An entry candidate's "starts at" symbol prefers a function or a class over whatever
declares first: measured, line order answered `type EvalCliOptions`,
`variable scriptDir` and `variable AUTH_FILE` — true, and useless as "begin here".

The `note` argument to `renderOverviewContext` is where the freshness warning rides,
and it is the only channel that carries one: the block itself asserts a project's
shape, so it must also say when that shape was cut by the file budget. That argument
was passed a literal `undefined` when the block was first wired, which made the one
warning channel dead — the block claimed a complete graph and could not be warned
about. Deciding `stale` is NOT done here: `text` must be synchronous while that
needs `await gitHead(cwd)`, so staleness is reported by the tools, which do the
check on every call.

### 8b. A cut list must say it was cut

`referencesTo`, `callsOf`, `calledBy`, `importsOf` and `documentsFor` used a bare
`LIMIT` with no `+1` and no `truncated` flag, while `findSymbols` and
`projectOverview` reported their own truncation. Measured on a real project, the
most-referenced function has **664** inbound references; `codegraph_impact` answered
40 of them with no signal. The failure is the one that silently produces wrong code
rather than a wrong answer: the model reads 40 rows, concludes it has every caller,
and edits the symbol.

Both tool results now carry `truncated`, and the rendered text says so in words —
a schema field alone is not enough, because a model that never reads it still acts
on the sample. The rule the whole plugin follows: an incomplete answer must be
unmistakably incomplete.

### 8c. What the graph is FOR, in evidence

The plugin is not a step every task must pass through. It is the cheapest path when
the question is **structural**, and the wrong tool when keyword search already
answers it. Three independent sources agree, and one of them explains a measurement
that looked like a defect:

- **Aider's repo map** — same approach (tree-sitter symbols, graph ranking, a token
  budget). Its stated benefit is that a map "alone may give it enough context to
  solve many tasks", and that the model uses it to decide *which files* to read.
  That is exactly what our overview injection does: measured on a real session, the
  model read the overview and then read specific files instead of scanning.
- **Structural vs semantic retrieval** — text search scores **6.5%** on refactor
  queries ("list the methods of class X") and **0–10%** on "list this file's
  symbols", because a definition does not name its container and a symbol is not a
  keyword. This is `fileOutline`'s reason to exist.
- **CodeCompass (arXiv 2602.20048)** — a graph tool's design purpose is structural
  dependencies, and **0 of 30 structural-task trials invoked it**, while **31 of 31**
  hidden-dependency trials did. Adoption rose from 0/30 to 31/31 after the checklist
  moved to the END of the prompt. Two lessons are implemented here: the overview's
  triggers sit last, and they name the QUESTION rather than saying "consider using".

So "did the model call a codegraph tool" is a diagnostic, not a success metric. A
rename task where `grep` wins is the tool being correctly not chosen — the plugin
earns its place on "who calls this", "what does this file define", and "what is this
symbol's neighbourhood", which keyword search cannot answer at all.

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
