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

`edges.src` / `edges.dst` are NODE ids, and a node is one of two things:

- `file:<path>` — the file itself (`imports`, `contains`, a call at file scope);
- a symbol id — a declaration (including `documents`, whose target is a file node
  carrying the mention's line in its own `line` column).

Two properties of symbol ids matter and both were paid for:

- **No line number.** Re-formatting a file must not invalidate every reference to
  its symbols.
- **An ordinal for overloads** (`…#m#1`). The id is a primary key, so two
  same-named methods on one class collided and failed the whole file's write.

Seven edge kinds, each answering a question the others cannot:

| kind | from → to | answers |
|---|---|---|
| `contains` | file → symbol | what does this file declare |
| `references` | declaration → declaration | who uses this (a call or a use) |
| `imports` | file → file | what does this file pull in |
| `documents` | symbol → file | where is this described in prose |
| `extends` | type → type | what is this built on |
| `implements` | class → interface | what contract does this satisfy |
| `type_refs` | declaration → type | whose signature depends on this type |

The last three were added later and each closes a question the graph could not
answer. **Implementing is not calling**, so `impact` on an interface used to find
only the places that NAMED it, never the classes that implement it — the question a
reader actually has about an interface. **A signature is not a call** either:
`function f(x: Foo)` never calls `Foo`, yet changing `Foo` breaks `f`, so without
`type_refs` the answer was a fraction of the damage. Measured on a 1613-file
project: 142 `extends`, 182 `implements` and 25,561 `type_refs`, for about one
second of extra index time.

## 2. Which module decides what

| Module | Owns | Never does |
|---|---|---|
| `src/store.ts` | the schema, and `replaceFile` / `forgetFile` as the only writers | read the disk |
| `src/languages.ts` | which extensions map to which grammar, and the download + sha512 check | parse |
| `src/parse.ts` | the per-language extraction tables (`GRAMMAR_SHAPES`) | touch the disk |
| `src/docs.ts` | which symbols a document NAMES | parse markdown |
| `src/indexer.ts` | the walk, the incremental comparison, the three phases, `projectChanged` (the read-only "did anything move" answer), and the pass's cancellation checkpoints | write SQL |
| `src/query.ts` | every read the three tools perform | own state |
| `src/routes.ts` | the settings page's and the pages' HTTP surface | compute index state |
| `src/client/page.tsx` | the sidebar page: every project, then one project's graph | own a second copy of the graph surface (it reuses `GraphPanel`) |
| `src/index.ts` | tool registration and the composition | — |
| `src/refresh.ts` | the debounce that turns a `tools/result` into one change CHECK per project | own a queue, a database, or a verdict |
| `src/tool-text.ts` | what the three tools SAY (`renderFind` / `renderImpact` / `renderContext`) | read a graph, a queue or a clock |
| `src/queue.ts` | serialisation, the state machine, the read-only change decision, the compensating pass a mid-pass change owes, and cancelling a deleted project's work | write to a graph, or decide staleness from Git |

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

**A partial scan read as "nothing changed".** The same two cases reach the freshness
check, and the first version answered `unchanged` for them — a claim about a
comparison it had not made. That was worse than the removal bug above because it is
silent: the project stayed `current` with no `removalSkipped` warning, so the model
was told the graph had been checked AND was complete. `projectChanged` now answers
`changed` whenever the walk was truncated or the root unreadable, which makes the
pass run, record `removalSkipped` (so every answer carries "deletions were not
verified") and remove nothing. `false` means one thing only: this call compared a
complete walk against the graph and found no difference.

**An unreadable root read as an empty project.** Related, and the reason the check
above cannot be "read the directory and see": `readdir` failing at the root and a
genuinely empty project both produce no files. The pass distinguishes them
(`rootUnreadable`), and the freshness check treats the unprovable case as work to do
rather than as a verdict.

**A missing language read as "no symbols here".** A grammar that is not installed,
or one with no extraction shape, answers `LANGUAGE_UNSUPPORTED` and is counted —
but the two counts are SEPARATE (`meta.missingLanguage` versus `meta.noRules`).
Collapsing them told users "N files skipped because the language is not installed"
for projects whose only gap was a `.css` file, so the settings page asked them to
download something that would not help. Measured on this machine: every skipped
file belonged to a language that was already installed.

**A shared name linked to one match.** A call target that resolves to several
declarations must not pick one — that would be a guess dressed as an answer. It must
not pick none either, and that was the defect: dropping it made a symbol declared
twice look like a symbol nobody calls. Measured, `streamWithDeltas` — declared in
production code and in a test harness — had thirteen real call sites and **zero**
edges, so `codegraph_impact` answered `referencing: []`, indistinguishable from
"nothing calls this". 53.2% of the project's reference edges hung off file nodes for
the same reason.

The rule now: link to **every** declaration of the name, up to `MAX_SHARED_TARGETS`
(10), and let the tool's candidates list do the disambiguation. Past ten the name is
not a name — `result` had 1325 declarations, and linking it produced 200,000+ edges
while burying the real callers, so those link to nothing. Measured after the change:
file-node share 53.2% → **36.5%**, first pass 17.9s → 25.6s, edges 54k → 203k.

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
Four steps, each for a measured reason:

0. **cancel the project's work and WAIT for it** — `queue.forget` aborts the pass in
   flight, fails every waiting job for that cwd, and resolves only after the aborted
   pass has settled. This step was missing, and its absence was a real defect: the
   function was synchronous while its comment claimed the delete waited, so closing the
   handle and removing the directory happened underneath a pass that was still writing —
   and an owed compensating pass then re-created the directory the user had just
   deleted, a removed project reappearing on disk. A tombstone (`removed`) keeps the
   delete authoritative for jobs already queued; `queue.request` lifts it, because an
   explicit re-index of a path the user chose is a new decision;
1. **close the open handle** — Windows refuses to delete a file another handle holds,
   so deleting before closing fails with EBUSY. `indexProject` is cancellable at its
   checkpoints, so step 0 is a real stop rather than a hope;
2. **drop the queue entry** (step 0 does it) — otherwise the settings list keeps
   showing the project, and the next `graphFor` re-creates an empty database at the
   same path. A `deleting` fence in `apply` also makes `graphFor` refuse the project
   during the window, so a concurrent tool call cannot open a fresh database either;
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

Four triggers, and they share one queue:

1. **A session enters a project** (`session/created`) — covers a new session AND a
   resumed one, so an old session reopened after install still gets indexed. The
   graph used to be built only when a tool was called, which left the settings
   page and the view empty for every project the user had not queried.
2. **A tool is called** in a project with no current graph.
3. **The settings page or the view asks** — the re-index action, and a stale read.
4. **A tool result reports a change** — any settled non-codegraph call in an
   indexed project, debounced per project. This is the one that covers an
   UNCOMMITTED edit; §9a has the reasoning and the compensating pass.

`queue.request` is idempotent while a project is queued or running, so several
sessions on one project cost one pass. Trigger 4 does not call it: it calls
`queue.observe` (mark a check owed, synchronously, so the next answer cannot say
`current`), then `queue.check` after the debounce — a READ-ONLY comparison that
schedules a pass only when it proves something moved. A check that arrives while a
pass is RUNNING records the debt instead, because that pass may already have read the
changed file, so the pump settles one compensating pass. §9a has the full state
machine. A failure is recorded on the project and reported by the settings page; the
`session/created` listener swallows it there and only there, because a rejected
promise inside session creation would surface as a broken session.

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
- **Silent when it cannot back itself up** — no graph, or a graph with no files,
  contributes `''`. "0 files" would read as a fact about the project rather than about
  the pass. An `indexing` pass contributes a BOUNDED STATUS instead (§8b-1): silence
  there read as "this project has no graph", in exactly the window a session asks its
  first orientation question. A `failed` pass says so with its recorded reason instead
  of asserting a shape: it is terminal until a human retries, so any shape it left has
  no bounded age.
- **Evaluated per assembly** — a fresh graph, a re-index or a new session all land
  without a restart.

The overview can report `stale` one observation late, and only for the HEAD half:
`text` must return synchronously while deciding staleness from Git needs
`await gitHead`. A change reported by a tool result is different — the queue records
it synchronously (`observe`), so the provider sees it on the next assembly.

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

**One boolean was still not enough, and the gap was in the render.** `impact` merges
three lists — `references`, `imports`, and the relationship groups — and the render
warned only when `referencing` was cut. A file that imports 300 modules printed 40
paths under a heading that reads as the complete dependency set, with
`truncated: true` sitting unread in the JSON. Same for a relationship group cut at 40
of 300: a sample presented as the set, in the list a reader consults before changing
an interface.

Each list now carries its own `{ shown, total, truncated }` (`ImpactResult.lists` for
the two top-level lists, and `RelatedGroup.total`/`truncated` per group, because the
groups are cut independently of each other), and each gets its own sentence. The
aggregate `truncated`/`total` stay — a consumer that only asks "is anything missing"
keeps working — but the render reads the per-list counts, because the aggregate cannot
say WHICH list. A total is only queried when a list was actually cut, so the common
answer still costs one statement.

`codegraph_context`'s symbol branch keeps one boolean and says "at least one list was
cut": it is an unmistakable statement of partiality, which is the property that
matters there. `impact` is where the counts decide a model's next step.

**A relationship's label is the relationship.** Every group used to render as
"implements this" unless it was `extends` or `type_refs` — and `exports` edges start
at a FILE node (the module that publishes the symbol), so the answer told a reader
that a module "implements" a function. Each of the four kinds now has its own
sentence, and an unknown kind names itself (`related by <kind>`) rather than borrowing
"implements": a kind added later must not silently inherit a meaning it does not have.

The renderers moved out of the `defineTool` closures into `src/tool-text.ts` as pure
functions for a reason: while they were closures the only assertion available was a
regular expression over the SOURCE, which proves a template is gone and never that the
sentence is right. Both defects above were invisible to that check.

### 8b-1. The overview's rows are queryable as printed

The block said "pass any id above", and the hub rows printed a kind, a name, a path
and a line — no id anywhere. `resolveSymbol` accepts an id or a UNIQUE name, and the
hub query admits names declared twice, so the instruction was unfollowable exactly on
the rows it pointed at. Hub rows now lead with the full symbol id (it already contains
kind, path and name, so it replaces that text rather than adding to it — copyable and
no longer), and entry rows keep the path, which is itself a valid selector
(`codegraph_context("<path>")` answers the file outline). No new tool, and no invented
selector syntax.

Two more sentences were wrong in the same block for a different reason:

- **"0 files" vs silence vs a status.** An `indexing` graph contributes a bounded
  status instead of `''`. Silence read as "this project has no graph" — in exactly the
  window a session asks its first orientation question, since a first pass on a real
  repository takes tens of seconds. It names no count: a partly-filled graph's number
  would be a fact about the pass stated as a fact about the project.
- **What the counts cover.** The headline now carries one line: the project's
  INDEXED files, the relations held (imports, calls, extends/implements, signature
  type references, docs), and that names are resolved statically — no type inference,
  no dynamic dispatch — so the source and the tests still decide. One line, because
  this text is spent on every turn.

The `memory_save` sentence is gone. This plugin owns no memory behaviour, the suite
ships with and without that plugin, and naming another plugin's tool is how one
plugin starts failing when the other is absent: the model calls a tool nothing
registered.

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
model: `current` — trust it; `stale` — the working tree moved (or the compensation
ceiling stopped), trust then refresh; `indexing` — the graph is not settled, so wait:
this is either a first touch or a pass/check in flight. `unindexed` exists in the store
type but no tool answer emits it, because the first call queues a pass. §9a's table is
the authoritative mapping from situation to value.

`isStale` compares the stored git HEAD to a fresh one and is deliberately
three-state: no repository on either side means "cannot prove", which must NOT
read as stale — a pass writes `''` again and the graph would rebuild forever.

### 9a. HEAD is not the working tree

That check is necessary and was not sufficient, and the gap produced the one
failure mode that looks authoritative rather than broken. A session's own edit
does **not** move HEAD, so an agent could write `src/util.ts`, ask
`codegraph_impact`, and receive an answer about the file from BEFORE the edit —
with `freshness: current` on it. There is no error to notice and no empty list to
be suspicious of; the answer is simply about the wrong bytes, which is worse than
no answer.

The graph is now refreshed from the event every way a session changes the tree
funnels through: **`tools/result`**, the kernel's emit for a settled call. That
covers a `write`/`edit`, a `shell` command that ran a formatter, a nested
`run_code` dispatch, and a plugin's own file-moving tool — the trigger is "some
tool settled in this project", never a list of tool NAMES. A name list covers the
three shapes somebody thought of and misses the fourth.

Three rules make that safe, and each is a module:

- **`refresh.ts`** owns the timing, and it schedules a QUESTION, not a verdict. The
  first result in a debounce window calls `queue.observe` synchronously (so the window
  is visible to the next tool answer) and arms one trailing check; later results join it
  rather than extending it, because extending would postpone the check for as long as
  tool calls keep arriving — which is a long turn, exactly when the graph is furthest
  behind. The scheduler holds no queue and no database, so the timing rules are tested
  against a hand-driven clock.
- **`queue.check`** owns the decision, and it is READ-ONLY. A tool result means a tool
  ran, not that a byte changed: `Read`, `Grep`, a passing test run and a build that
  rewrote identical bytes all produce results. So `check` asks the injected `changed`
  predicate — the same `mtime`/`size` comparison the pass itself uses, plus "a recorded
  file is gone" and "a file was never indexed" — and schedules a pass only when it
  answers yes. **A current graph stays `current` through a read-only stream**, and no
  pass runs; the first version marked `stale` on every result, which reported work
  nobody did AND (through the query re-arming path) kept the tree walking forever.
  A check that cannot read the tree falls through to a pass, so the real failure is
  recorded rather than reported as "unchanged" — and `projectChanged` itself answers
  `changed` for an unreadable root or a truncated walk (§4), because "unchanged" is a
  claim it could not make.
- **`queue` also owns the mid-pass case.** A pass already RUNNING may have read the
  files that just changed, so it finishes looking correct and would be reported
  `current`. A check that arrives mid-pass records that as owed and the pump settles
  exactly one compensating pass — coalesced, because the flag is a flag and not a count.
  A QUEUED pass owes nothing (it has not read anything yet), and a FAILED project is
  left alone: retrying a structural failure from a tool result is the spin the queue's
  header forbids. The compensation stops at a ceiling of four, past which the project
  reports `stale` with `awaitingRetry` set — and stays there until an EXPLICIT re-index,
  because a ceiling a check could re-arm would only mean "the chain resumes after any
  tool call".
- **`index.ts`** owns the join, and refuses two cases: a `codegraph_*` result (a query
  must never schedule the work that changes its own answer) and a project this process
  holds no graph for (`session/created` and the first tool call decide a project
  exists; a stray result must not create a graph directory for every cwd a session
  mentions). The listener never throws — a `tools/result` observer's failure is
  contained and logged, which is never useful.

**The three states a tool answer may report, and why `indexing` is one of them.**
`freshness` keeps its three-value enum; what changed is which one the window produces:

| the situation | the answer | why |
|---|---|---|
| a check ran and found nothing | `current` | proved, not assumed |
| a check ran and found work, or the queue is `stale` | `stale` | proved, and the pass is running |
| a result landed and the check has not answered | `indexing`, with a note that a check is running | neither `current` (unproved, and the defect this round is about) nor `stale` (claims work nobody proved) |

`freshnessOf` resolves that last row rather than guessing: it runs the SAME read-only
comparison (`projectChanged`) on the spot, so a query that lands inside the debounce
window answers `current` when nothing moved and `stale` when something did. That is why
a read-only session stays `current` instead of flapping.

`freshnessOf` keeps the HEAD check: it covers the other direction, a commit, pull or
checkout that moves the tree with no tool result in between. It no longer STARTS
anything for a `stale` entry — that branch used to call `refresh.notify`, so a model
asking twice kept the project walking, and a project at the compensation ceiling was
resurrected by a read. The queue already owns the work; the answer only reports it, and
`awaitingRetry` reaches the model as "re-index from the code graph settings page".

There is deliberately no filesystem watcher. A watcher is a resident handle per
project that multiplies across platforms, and the thing that needs to know is a
session, whose writes always arrive through this pipeline. An edit from an external
editor with no tool call in between is covered one observation late, on the next
tool call or the next HEAD move.

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
- **No behaviour.** It knows `A` references `B`. It does not know what `A` expects
  `B` to return, which of `B`'s errors `A` handles, or which assertion encodes the
  contract. "What breaks if I change this" is answered by reading the assertions,
  and the graph only narrows which files hold them.

### 10b. Known boundaries and residual risk

Each of these is measured, not hypothetical, and each is a deliberate line rather
than an unfinished one. Listed so a reader knows where an answer stops.

| boundary | consequence | why it stays |
|---|---|---|
| A name declared in several files links to all of them (up to ten) | a signature's type dependencies can read about twice the real count — `Model` has 364 annotations but 728 edges because two files declare it | under-reporting callers changes code silently; over-reporting is a row the reader can dismiss. Import-guided resolution is the next layer |
| `extends` / `implements` have shapes for the TypeScript/JavaScript family only | a Python, Go, Java, C# or Rust project answers these queries with nothing | each language needs its own node table; the grammars differ more here than for calls |
| A module's public surface stops at file → symbol | `export * from './x'` is a file→file edge, so "is this symbol part of the package API" is one hop away, not answered directly | deriving symbol-level publication across a re-export chain means re-scanning every exporting file whenever one changes — the W11b shape that lost edges before |
| A shared name's re-export resolves inside the named module only | an `export { x } from './y'` where `y` re-exports `x` from `z` links to nothing at the second hop | one hop is what the `from` clause states; following the chain needs import resolution for every step |
| The graph is rebuilt from scratch on a schema bump | the first launch after an upgrade shows `indexing` for ~30s | a derived graph is only as good as the pass that filled it; an interrupted rebuild leaves an empty graph that the next open repairs |

The last one has a sharp edge worth stating: an interrupted rebuild leaves a graph
with no rows, and nothing marks it as incomplete. The next open rebuilds it, so the
state is transient — but a query issued during it answers from an empty graph, and
`indexing` is the only signal.

### 10a. The five ways an answer is incomplete, and what each now says

Every one of these was measured, and each used to read as a complete answer.

| the situation | used to answer | now says |
|---|---|---|
| more references than the row limit | `40 rows`, `truncated: true` | `664 reference(s) — 40 shown`, plus the 624 that are missing |
| the sample came from three files out of a hundred | 40 rows, all from one file | 40 rows drawn one-per-file, so a sample looks like a sample |
| the name is declared several times, so no edge was ever built | "no unambiguous symbol matched" | the declarations that share it, their ids, and "ambiguity is not absence" |
| the call goes through an interface, a dispatch or a variable, so no edge exists | an empty list | "no direct callers found — that is NOT safe to change" |
| the symbol has hundreds of callers, so searching for them is expensive | the declaration only | `482 call site(s) — codegraph_impact is cheaper than searching` |

The second row is a different failure from the first: `truncated: true` was honest
about the cut and silent about the SHAPE. Measured, `impact` on a symbol with 664
call sites across 105 files returned 40 rows from **one** file — a sample that says
"the callers live here", which is false. The rows are now drawn one per source file
(`ROW_NUMBER() PARTITION BY src`), so 40 rows name 40 different places whenever 40
files exist.

The fourth one produced a wrong conclusion in a real session: `streamWithDeltas` is
declared in both `faux.ts` and a test harness, so all thirteen of its call sites were
dropped as ambiguous and `codegraph_impact` answered as if nothing called it. **An
empty list and an ambiguous name were the same sentence**, and only one of them means
"safe to look elsewhere". The edges are now built (see §4), and an ambiguous name
still says so with its candidates.

The fourth is a different kind of fix: not "the answer was incomplete" but "the reader
could not size the question". Measured, `streamWithDeltas` has 7 text matches (a search
is cheaper, and choosing it is correct) while `setResponses` has 482 — around 15k
tokens, and a definition-versus-call judgement on every line. The model searched both
times, because no answer said which was which.

The rule the tools now follow: a result that cannot be trusted says which way it is
untrustworthy, and names the next step.

### 10b. What this plugin is, in one sentence

A **code graph**: a static index of declarations and the name-resolved references
between them. It is not a knowledge graph and not a semantic one — it encodes "A
references B", never "A depends on what B returns". The three questions it owns are
*what does this file define*, *who references this symbol*, and *what is this
project's shape*; the one it does not own is *what breaks if I change this*, because
that answer lives in test assertions and in signatures the graph cannot see.

That boundary is why the model correctly picks `grep` for a function with seven
matches and no callers of consequence, and why the plugin now reports the caller count
in `codegraph_find`: choosing well needs the size of the question, not more
instructions.

### 10c. Unloading: the pass must stop before the handles close

The teardown has three steps and their ORDER is the whole contract:

1. `queue.dispose()` aborts every project's pass **and resolves only once they have
   settled**. It used to abort and return synchronously, so the next step closed graph
   handles underneath a phase 2 or phase 3 that was still committing batches — or running
   its recovery path, `forgetStatCache`, which opens a transaction of its own. The result
   was a write against a closed database, or a write spanning a reload;
2. the tools and routes come down (a route left registered after unload collides on the
   next mount, which lands on the boot audit rather than on a warning);
3. only then are the graphs closed.

A third detail is inside step 1 itself: `dispose` **collects each project's running
promise before it aborts**, because aborting first runs the runner's own abort listener,
which can settle the pass before the loop has captured it — and a `dispose` that
resolved then would be the same defect in a new place. The regression test asserts that
`dispose` is still pending while the runner is inside its abort handler.

Two more details make step 1 real rather than nominal. `indexProject` checks its `signal`
after **every yield** — phase 2 commits every 50 files and phase 3 every 25 documents,
each followed by a `setImmediate` — not only at a phase's entry, so a cancellation that
arrives during a batch stops the pass before the next transaction opens. And a cancelled
pass does not run the recovery path at all (`isAborted`): `forgetStatCache` exists to
repair a FAILED pass, and running it for a cancelled one would be the write the abort was
supposed to prevent.

A cancelled pass rejects, and that rejection is expected by every caller: `dispose` awaits
it with `allSettled`, the plugin's `request`/`check` call sites catch it, and the queue
records no `failed` state for it — a pass nobody broke must not be reported as one that
needs a manual re-index.

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
