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
| `symbols` | a declaration, with its line extent (`line`..`end_line`) | `id` = `<path>#<kind>:<parent>.<name>` |
| `edges` | a relation between two nodes | `(src, dst, kind)` |
| `meta` | the project's own state | one row |

There is deliberately **no full-text index**. A word-part hit is always also a
substring hit (`ruler` is inside `diffRulerMarks`), so an inverted index — with its
per-symbol write, its second copy of every name and a `rowid` contract between two
modules — would add no recall to a search that does not rank by score. The one query
a substring scan cannot answer is a bag of words in any order, and that is answered
by scanning for each word (`queryTokens`).

`end_line` is the half of a declaration's extent the tools need: a query cuts
`line`..`end_line` out of the file at read time (`src/source.ts`), so no source
bytes are stored. Storing them would make the database a second, staler copy of
the repository — one edit would have to rewrite a shelf.

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

Three columns were added with schema 5, and all three say what a declaration IS
rather than where it is:

| Column | Holds | Read by |
|---|---|---|
| `symbols.signature` | the declaration's head on one line — what it takes and returns, without its body (`normalizeSignature` in `parse.ts`); `''` when nothing survives | the outline and `find` rows, the request pack |
| `symbols.doc` | the first sentence of the comment block directly above (`docComment`); a Python docstring when there is no comment | the outline rows at the finest detail |
| `edges.narrowed` | `1` when the reference was resolved by a same-file declaration or by an import clause, `0` when only the name matched project-wide (`linkFor`'s three layers) | the `✓` on an `impact` row |

They are deliberately OUTSIDE `symbolColumns()`: `toSymbolView` spreads a row
whole and every tool's output schema is `additionalProperties: false`, so a
column that rides into the view unannounced fails the whole answer. Each reader
asks for them by name.

Measured on this repository before the columns existed (478 TypeScript files,
15,189 declarations): 41% of declarations have a comment on the line directly
above, and 72% of those comments sit one level up from the declaration (inside
its `export` or `lexical` wrapper) — a reader that looks only at the
declaration's own previous sibling stores `''` for seven docs in ten.

## 2. Which module decides what

| Module | Owns | Never does |
|---|---|---|
| `src/store.ts` | the schema, and `replaceFile` / `forgetFile` as the only writers | read the disk |
| `src/languages.ts` | which extensions map to which grammar, the download + sha512 check, and which three grammars the plugin builds itself (§11) | parse |
| `src/parse.ts` | the per-language extraction tables (`GRAMMAR_SHAPES`) and the three-layer name resolution (`linkFor`) | touch the disk |
| `src/search.ts` | how a query string becomes filters, and which words a multi-word query is made of | query a database, or index anything |
| `src/ignore.ts` | `.gitignore` matching and the generated-file verdict — by name, by banner, or by the SHAPE of the head's lines — as pure functions over strings | walk a tree |
| `src/sfc.ts` | the code region of a Vue/Svelte/Astro component (a `<script>` block, or Astro's `---` frontmatter), masked into its own line positions | parse anything |
| `src/sql.ts` | the SQL scanner: `CREATE` keywords and the objects a statement names | parse SQL properly, or resolve schemas |
| `src/schema.ts` | the block scanner behind Prisma and GraphQL SDL, and their two keyword/reference tables | parse either language, or resolve a type to a declaration |
| `src/hcl.ts` | Terraform/HCL: labelled blocks as addresses (`aws_instance.web`, `var.region`) and the references between them | evaluate expressions, follow `for_each`, or resolve a module's inputs |
| `src/source.ts` | the ONE read of source bytes at query time: path containment, hash comparison, line budget | write anything |
| `src/budget.ts` | how much source one answer may carry, per project size | know what a symbol is |
| `src/docs.ts` | which symbols a document NAMES | parse markdown |
| `src/indexer.ts` | the walk, the incremental comparison, the three phases, `projectChanged` (the read-only "did anything move" answer), and the pass's cancellation checkpoints | write SQL |
| `src/query.ts` | every read the three tools perform | own state |
| `src/routes.ts` | the settings page's and the pages' HTTP surface | compute index state |
| `src/client/page.tsx` | the sidebar page: every project, then one project's graph | own a second copy of the graph surface (it reuses `GraphPanel`) |
| `src/index.ts` | tool registration and the composition | — |
| `src/overview-state.ts` | which overview text a session gets, across assemblies: the failure / status / full rules (§8b-2) | read a graph or a clock it was not handed |
| `src/grep-note.ts` | the one line appended after a search the model made itself, and the per-session "already told" rule (§8d) | listen to anything, or decide whether the graph is current |
| `src/prefetch.ts` | the request pack: the tokens a request names, their strict resolution, the text and its budget (§8e) | listen to anything, read a switch, or decide whether the graph is current |
| `src/budget.ts` | the source slice's budget (§9b) and the outline's: the detail ladder, the 1,200-token list budget, how many rows survive (§8f) | render a row, or read a graph |
| `src/switches.ts` | the environment switches — their names, the `0`/`false` convention, which ones are wired (§12) | read anything but the environment |
| `src/usage.ts` | what the model-facing features did per project, counted in memory for `/status` (§12) | write a file, or reach a prompt |
| `src/refresh.ts` | the debounce that turns a `tools/result` into one change CHECK per project | own a queue, a database, or a verdict |
| `src/tool-text.ts` | what the three tools SAY (`renderFind` / `renderImpact` / `renderContext`) | read a graph, a queue or a clock |
| `src/queue.ts` | serialisation, the state machine, the read-only change decision, the compensating pass a mid-pass change owes, and cancelling a deleted project's work | write to a graph, or decide staleness from Git |

`store.ts` is the only module that writes SQL, and `indexer.ts` is the only module
that reads the tree. **`source.ts` is the second module that reads a file, and
every read in it is the narrowest the question allows**: one declaration
(`readSourceSlice`), one line per reference in an `impact` answer with each
caller's file read once under a file and byte bound (`readCallSites`, §8g), or
one `stat` with no read at all (`changedFilesSinceIndex`, §9). All three admit a
path the same two ways — at query time, only when the graph already holds a
`files` row for it, and only when its absolute form stays inside the project
root. That pair of checks is why a path in a tool answer (which a MODEL produced)
cannot become an arbitrary file read — see §9b.

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

The pass yields to the event loop: phase 1 after 8ms of work (by TIME, not by a
file count — §7 has the measurement that killed the count), phases 2 and 3 after
each batch of 50 files / 25 documents. Without it a 20 000-file pass holds the
kernel's loop for its whole duration and no tool call can ever observe the
`indexing` state — the state machine would be unreachable in practice.

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

The split had a second half, found the same way: a file whose grammar is ABSENT but
whose language has no extraction rules was counted as `missingLanguage` — a download
that cannot help, offered as the cure. Measured on a real project: ten `.css`/`.scss`
files told the user "download the language below", and downloading the CSS grammar
changed nothing, because a selector is not a symbol. `unsupportedFor` now decides by
what a download would BUY: only a language with rules is ever reported as missing.

**A narrower tree read as deletions.** `.gitignore`, the generated-file verdict and
the size limit all make the walk return FEWER files than the directory holds — and
the removal step deletes a graph row for every path it did not see. So the walk
reports what it excluded (`ignored`, `generated`, `tooLarge`) and the pass must not
treat those as gone, or a `.gitignore` edit would empty half a graph. The freshness
check (`projectChanged`) runs through the SAME walker for a related reason: a check
with its own idea of "which files count" reports work that a pass then does not do,
and the project never converges.

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

**It peeks, it does not open** (`peekProjectMeta` in `src/store.ts`). The
difference is not an optimisation, it is the whole correctness of this step:
`openGraph` applies `SCHEMA_VERSION`, and a mismatch DROPS every table — `meta`
and its `cwd` with them. A listing built on `openGraph` therefore erased the one
field it needs, on the first launch after every schema bump, and because the
directory name is `sha256(cwd)` there was nothing left to recover from: the
settings page came up with no projects and each one reappeared only once a
session opened it by hand. Measured after the 3→4 bump. So the listing opens the
file, reads, and closes — no schema, no pragma, no write — and an OLD graph still
knows its root as long as its metadata validates. The rebuild happens where it
belongs: the first real open of that project (`graphFor` → `openGraph`), which
then runs a full pass.

A graph that cannot be read (a half-written file from a killed pass, or a file
that is not a database) is skipped, never repaired here: deleting an unreadable
file is `openGraph`'s decision, made when that project is actually opened.

The same reasoning applies INSIDE `openGraph`: `meta.project` is not derived data —
it is the only record of which project a graph describes — so a schema rebuild reads
it first and writes it back with its counts zeroed. Without that, every version bump
would lose the projects it touched, one library upgrade at a time.

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

`codegraph_context` on a symbol now also returns the declaration's own source,
line-numbered, so the call is a place to EDIT from rather than an index to read
afterwards (§9b owns the read, the containment rules and the drift flag; §1 owns
why the bytes are not stored). Everything else in that answer — siblings, calls,
callers, imports, documents — is a pointer, and a pointer is what made a model open
the file anyway.

`codegraph_find` ranks by evidence rather than by one scan. An exact name —
compared case-insensitively, because `LIKE` is and an `=` that is not would let
`ruler` miss `Ruler` and then rank `RulerFactory` above it — ends the search. Otherwise
a prefix, a substring scan, and a bag-of-words scan for a MULTI-WORD query merge in
that order; duplicates collapse by id and the answer keeps path-and-line order.

`codegraph_find` also points at `codegraph_impact` for a SMALL call-site count, not
only for a large one. Measured in a real session: it answered `saveDraft` with
"5 call site(s)", and the model then read the same file five times to work out which
function each call site sits in — the list `codegraph_impact` returns in one call, with
the declaring symbol named on every row. The hint used to fire only above 20, so the
common case got no pointer and the read reflex won.

**Every `codegraph_find` row prints its id, because a refused name needs one.** The
row used to carry kind, name and location only. `codegraph_impact` accepts ONE
declaration and refuses a name that resolves to several, and that collision is
ordinary rather than exotic: one entity normally has a declaration per notation — a
type alias beside the model class an ORM maps a table onto beside the table an SQL
migration creates — so the model meets the refusal on the names it asks about most.
The refusal does print candidate ids, but only FIVE of them, while `find` answers up
to forty rows: past five declarations the refusal cannot name what it declines to
answer, and the model's only way to one is a text search for it. Printing the id on
every row also removes the round trip in the ordinary case, where the first answer
already names the declaration and the second call is the real question.

The row APPENDS the id rather than replacing the label, unlike the overview's hub
rows (§8b-1). The difference is the line number: an id carries no line, and a `find`
answer spans files, so `path:line` is the only thing on the row that says where to
look. The id is what to copy; the label is what to read.

The four tiers are deliberately not four kinds of index. Tiers 1–3 are one table and
one scan; tier 4 exists because `marks ruler` is not a substring of anything, which is
the single hole a substring scan has. That is also why the bag-of-words tier runs
LAST: every row it can find is a row the substring tier would find for a single word,
so letting it go first would only let it push those rows past the limit. Nothing here
ranks by score — a stable order is worth more to a reader than a marginally better
one. It also accepts `kind:` / `path:` / `lang:` / `name:` prefixes, because a common
name narrowed by a fact the caller already knows is a better question than a longer
word.

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

- **Bounded** — five to twelve entry candidates, as many hubs, three languages,
  five directories, ~16 lines. This is context spent on every turn; an unbounded
  list would cost more than the reading it saves.
- **Complete enough to stop.** The entry rows name the start symbol
  (`apps/api/src/main.ts (starts at function bootstrap)`), the hub rows print a
  copyable id, and one line says which top-level directories hold the project. A
  row that answers "which file" but not "what is it" leaves exactly enough missing
  to justify the exploration it was meant to replace. The entry rows USED TO carry
  the start symbol's LINE as well, for a measured reason: a model that read only
  `(starts at function bootstrap)` ran glob plus four reads and answered with
  `main.ts:34` — five tool calls for a number the block already knew. That reason
  was outweighed in 2026-11 (§8b-2): the line moves whenever one is inserted above
  it, and every move re-sent the whole snapshot. The outline
  (`codegraph_context("<path>")`) returns every line in one call.
- **Silent when it cannot back itself up** — no graph, or a graph with no files,
  contributes `''`. "0 files" would read as a fact about the project rather than about
  the pass. An `indexing` pass contributes a BOUNDED STATUS instead (§8b-1): silence
  there read as "this project has no graph", in exactly the window a session asks its
  first orientation question — and only for the FIRST index; once the project has a
  complete block, a re-index keeps it (§8b-2). A `failed` pass says so with its
  recorded reason instead of asserting a shape: it is terminal until a human retries,
  so any shape it left has no bounded age.
- **Evaluated per assembly** — a fresh graph, a re-index or a new session all land
  without a restart.
- **Stable under edits** (§8b-2) — the block changes only when the project's shape
  really did.

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

### 8b-2. Stable under edits: three rules and a session's own text

The block is a runtime-context snapshot, and the kernel appends a NEW snapshot
whenever the whole text changes and retires nothing (every earlier copy stays in
the conversation). That makes any churn in this text expensive in proportion to
how long the session runs. Measured on 234 real sessions before this round
(`scripts/usage-replay.mjs` reproduces the table): 35 sessions carried the block;
they re-pushed the snapshot 354 times, 280 of them because the block's OWN text had
changed, and those re-reads come to about 51 million tokens. The 274 recoverable
diffs broke down as: the headline's counts 229 times (`~440 edges` became `~450`
after one edit — two significant digits move at every unit below a hundred), hub
rows 138 times (ordered by reference count, so `~34`/`~35` reordering and `9` →
`~10` both changed the row), entry rows 82 times (a line number shifting, a new
file entering the list), and the status flip 32 times (a re-index turned the whole
block into one sentence and back).

Rendering removes most of the causes (`prompt.ts`):

- **Counts are rungs, not rounded numbers** (`ladderRung`): below 5 exact, then the
  nearest of 1–2–5 per decade in log distance (`~20`, `~50`, `~500`, `~5k`). A
  rung moves only when the project really changed size. The exact numbers are one
  `codegraph_context` call away, which is the call the block exists to encourage.
- **Hubs are chosen and ordered by rung** — every candidate snapped to the same
  ladder, then rung descending and id ascending. The set moves only when a symbol
  crosses a rung; the order no longer depends on the counts within one.
- **Entry rows carry no line number and no symbol count**, and are ordered by
  class then path. One inserted line above an entry's start used to re-send the
  block; the outline returns every line in one call.
- **A layout line** (`Top-level layout (indexed files): plugins ~500, test ~100 …`)
  says which directories hold the project — rung descending, name ascending, at
  most five, only with two or more directories to name. The counts come from
  `projectLayout` as exact numbers, so bucketing and ordering have one home.

What rendering cannot fix is the text changing because the project DID change, or
because the queue changed state. `overview-state.ts` decides that, per assembly,
with the clock injected:

| the candidate | what the session gets |
|---|---|
| a `failure` sentence | exactly that, every time; nothing is recorded — a failed pass is terminal until a human retries, and showing the previous shape would have the model edit against a graph the plugin says not to trust |
| a `status` sentence (first index, or a re-index) | the text THIS session was last shown; a session never shown a block gets the project's latest complete block; a project with none gets the status sentence — the first-index window it was written for |
| a complete block | the first one a session is offered, always; after that, a changed block is adopted only when the session's last change is at least five minutes old (`minIntervalMs`), otherwise the session keeps what it has and takes whatever is newest at the first assembly after the interval — delayed, never dropped |

The session's own text outranks the project's in the `status` row on purpose: a
session inside its interval is reading an older block, and handing it the
project's newest one there would be followed by the next complete assembly taking it
back — one flip per re-index, the thing the rule removes. `changes(cwd)` counts
adopted changes per project and feeds `/status` (`§12`).

What this costs: a session can read a block up to five minutes older than the
graph. The tools report freshness on every answer, so the cost is a stale
orientation, never a stale fact acted on as current.

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

### 8d. The note after a search the model made itself

The one place the plugin writes into ANOTHER tool's answer. Measured on this
machine's 234 real sessions: the model reached for `grep` 1,942 times and for
`codegraph_*` six, and in one session `codegraph_find` answered a name with "5
call site(s)" and the model then read the same file five times to work out which
function each call sat in. Telling it the graph exists does not move it at the
moment it plans (§8c); the graph goes instead to the moment it already chose.

`grep-note.ts` is pure — `searchNote(graph, pattern)` answers one line or
`undefined`, `SearchNoteMemory.shouldNote(session, name)` answers once per session —
and `index.ts` owns every gate. The line is`codegraph: "<name>" is declared once in this project — <kind> at <path>:<line>
(<signature>) — with N reference(s) from M file(s). \`codegraph_impact("<name>")\`
lists each reference with the function that contains it.` — the position (the fact
a read was for), the counts, and the next call, under 320 characters, stepping down
by dropping the signature, then the pointer, then the whole line as the path grows.

The rules, and why each is a rule and not a preference:

- **Certain or silent.** The pattern must be one bare identifier the graph declares
  EXACTLY once — the same test `resolveSymbol` applies, which is why the pointer
  names the symbol and not its id (the id would carry the path a second time). 71%
  of this repository's declarations share their name; a line about the wrong `store`
  is worse than none. Matching is case-sensitive, as the search was.
- **Any search call, at most five notes per outer call.** A `run_code` sub-dispatch
  counts too, on purpose: with the PTC executor selected — the configuration the
  live check ran in — a model-direct native call is refused as `UNKNOWN_TOOL` and
  EVERY search is a sub-dispatch, whose contexts the executor ferries to the outer
  result. The plan first scoped the note to model-direct calls, which in that
  configuration is never. The cap (`MAX_NOTES_PER_CALL`) is counted per OUTER
  call, keyed by the outer execution's `parent` token that every one of its
  sub-dispatches carries — so two outer calls running side by side cannot reset
  each other's count, and the entry leaves with the execution. It keeps a script
  that loops over fifty names from appending fifty lines; a name the cap skipped
  has not been "told about" and keeps its turn for a later call, and only a note
  actually appended counts.
- **A current graph with no check pending.** A line number from a graph an edit has
  just outrun is the one thing a note must never give; the same honesty rule as the
  tools (§9).
- **An `accept` of a result that is not an error**, with the downstream decision's
  own `additionalContexts` kept in front of the note. The listener never throws: it
  runs inside the tool pipeline, where an exception would fail a successful search.
- **Once per session and name**, after the note exists — a name that produced
  nothing has not been "told about" and must not spend its turn.
- **`DSH_APP_CODEGRAPH_GREP_NOTE=0` turns it off** (§12); `/status` counts `grepNotes`.

The note is a USER-role message, so what goes into it is held to a higher standard
than a tool row: the identifier is bare by construction, and the signature it
prints has its comments stripped by a quote-aware scan — a string literal in a
default (`"src/**/*.ts"`) is the declaration's fact and stays — and its control
characters replaced (`normalizeSignature`, §1). Prose planted in a comment must
not arrive under the user's role as if the harness had said it.

It is an experiment with a counter, not a settled feature (plan D3): the note can
be wrong in the ways a name is wrong — a unique name that is also a prose word, or
one whose unreconciled edges inflate the count — and the replay script plus
`grepNotes` decide whether it stays. The source kind is `dsh-app-codegraph`, so a
session log can tell the note from the search it rode on.

### 8e. The request pack: the declarations a request names, before the plan

The overview answers "what is this project"; the pack answers "what are THESE" —
the files and identifiers a request names outright. Measured on the same 234
sessions: 25% of the 452 human messages carry a code-shaped token, and the strict
gate (a file the graph holds, or a name with exactly one declaration) fires on 9%
— 45% of the long ones, mostly delegation briefs, where a plan is actually made.

`prefetch.ts` is pure: `requestTokens(request)` finds the tokens (paths with a
code extension; camelCase, PascalCase, snake_case and SCREAMING_SNAKE_CASE names;
at most 14), `buildPrefetchPack(graph, request)` resolves each strictly (a path is
a file and only a file — exact, then a UNIQUE suffix; a name is a symbol only when
exactly one declaration carries it) and renders at most 3 files with an 8-row
outline and 3 symbols, under 1,700 characters, rows cut before items, the last
item before the first. One sentence frames it as background, not instructions, and
names the one next call for a symbol; a symbol row carries no id, because every
name in a pack is unique by construction and the id would repeat the path. The
token pattern is LINEAR by construction — a capital always opens the next hump
(`[a-z0-9]*` inside a hump, never `[a-zA-Z0-9]*`, and no tail after the last
hump): the ambiguous form took 580 ms on `aAAAA…_` at 26 letters and hours at
forty, on the kernel's event loop, from one pasted line.

`index.ts` owns the wiring and every gate, and the shape is plugin-memory's (its
request-relevant cards): `agent/inbox/claimed` remembers the request of a `user`
message per session — what the harness injects through the same inbox (a runtime
context, a skill catalog, a notice) is not a new question, and neither is a
whitespace-only message — and a second runtime context (`dsh-app:codegraph:request`,
order 61, `interpolate: false`) reads it at assembly. The kernel appends that
context only when its text changes, so the steps of one turn cost nothing.

The rules that are not preferences:

- **Only a `current` graph with no check pending before a pack is FIRST built** —
  a pack is a promise that these are the declarations as they stand. A project on
  its first turn gets no pack; the overview carries the indexing sentence instead.
  A pack already sent is HELD through a re-index, though: it rides the same
  snapshot as the overview, so dropping it while the index runs and restoring it
  after is two whole-snapshot re-pushes per editing turn. The next `current`
  assembly rebuilds it, and a real change lands once.
- **Counted once per request.** The provider runs on every assembly, so
  `prefetchAttached` / `prefetchSkipped` move the first time a request meets a
  current graph, never per step.
- **`DSH_APP_CODEGRAPH_PREFETCH=0` turns it off** (§12).
- A lowercase word (`helper`, `run`) is not a token, on purpose: it is how prose
  spells a word. The calibration pattern lacked SCREAMING_SNAKE_CASE and missed
  every `MAX_RETRIES`; adding it (here and in the replay script together) moved
  the strict gate from 40 to 41 of 452 messages.

What it can get wrong: a unique-suffix file that is not the one meant (`a.ts`
when one file so named exists), a camelCase word that is a product's name (six are
stopped), a stack trace pasted into the request (which is probably wanted). The
ceiling of every miss is the budget, and the framing sentence already says the
files decide. `prefetchAttached` and the replay script watch it.

### 8f. The outline's detail ladder and the token budget

A file outline used to print names only, so the model read the file to learn what
the names meant. It now prints what the graph holds of each declaration — the
normalized head (`symbols.signature`, §1) and, when there is room, the first
sentence of its doc comment — and pays for it out of a budget:
`budget.ts`'s `planOutline` picks the level, `tool-text.ts`'s `outlineRow` is both
the row and the unit the budget measures, so the two cannot disagree about what a
row costs.

| Declarations in the file | Level | A row is |
|---|---|---|
| ≤ 25 | `full` | the signature, then the doc sentence |
| 26–60 | `signatures` | the signature |
| more | `names` | the name |

The list is capped at 4,800 characters (≈ 1,200 tokens, `ANSWER_LIST_CHARS`): a
level that does not fit is lowered one step; a `names` list that still does not fit
keeps the longest prefix — the order is exported first, then most-referenced, so
what is cut is the tail — and never drops below one row. The first line says what
happened: `· detail: signatures · ~812/1200 tokens`, and `· 31 row(s) cut to fit
the budget…` when rows went; `file.detail` and `file.cut` carry the same facts in
the JSON, and a cut counts as a truncation (§8b). `detail` is an argument
(`names` / `signatures` / `full`, default `auto`): an explicit level is where the
ladder STARTS, never a promise, because a `full` list of ninety rows is the read
the budget exists to replace.

Measured on this repository's `src/main`, with real syntax: a 23-declaration file
stays `full` at ~881 tokens (65% of reading it); a 46-declaration file falls to
`names` at ~1,085 (35%) — a signature row is ~150 characters once the id and the
line are on it, so 46 of them already exceed the budget; an 87-declaration file is
`names`, cut to 56 rows, at the 1,200 cap (9% of the file). Every one of the 58
files measured stayed under the cap.

The same columns reach the other lists: `codegraph_find` leads each row with the
signature when it answers ten rows or fewer; `codegraph_context` on a symbol
carries signatures on its siblings (≤ 25) and on its calls (≤ 15), and a call whose
target resolves uniquely shows the target's signature. `names` rows carry no
`[exported]` mark — the order already puts exports first, and the mark is 11
characters a row.

### 8g. `codegraph_impact`: which references are certain, which tests to run, who calls the callers

Three additions to the one answer the model uses for "what breaks if I change this":

- **A confidence mark per reference row.** `✓` means the edge was narrowed — the
  name resolved through a same-file declaration or an import clause
  (`edges.narrowed`, §1); an unmarked row is a name match. The legend prints only
  when a `✓` appeared. Before this, a hub's 664 rows looked equally certain, and
  the only way to tell the ten real call sites from the 654 `store` variables was
  to open the files.
- **The test files that reference it.** A separate group after the reference list:
  `Tests that reference this (15 of 22 file(s)) — run these first:`, cut at 15
  files and saying so (`TRUNCATED: 7 more test file(s) exist`). "Which tests
  cover this" was a glob plus a read; now it is one line in the answer that
  already lists the references. The test shape is `*.test.*` / `*.spec.*` /
  `*.e2e.*`, a `tests/` or `__tests__/` directory, and the `*Tests` / `*Test`
  suffix for the languages that spell it that way.
- **A caller tree, on request.** `depth` (default 1, at most 3) expands each
  caller's own callers as an indented tree: 12 callers per symbol per level, 60
  nodes in all, each symbol once (`(see above)` where a cycle returns — and the
  asked symbol is a caller like any other, so a self-recursive function lists
  itself at depth 1 and `(see above)` only from depth 2 on, never a pointer to
  nothing at the top), and a count where a cut happened — `300 caller(s), 12
  shown` on that node, `TRUNCATED at 60` in the title when the cap was reached.
  Depth 1 is the default because a tree is only worth its tokens when the change
  is structural; the JSON carries `callers` only when `depth` was passed.

The count on a node is deliberately not folded into the title: a reader meets the
cut where it happened, on the row whose children are missing.

**The row carries the call itself.** Every reference row reads
`` - `caller` — `path:line` ✓: `the line of the call` `` — the calling symbol's
name first, then the place, then the line's own text, read from the caller's file
at answer time (`readCallSites`: each file once, at most 40 files and 4 MB per
answer, the line trimmed and folded to 120 characters, 3,000 characters of text
per answer with the first rows served first; rows past the bound stay locations
and the list says `call-site text is shown for N of M row(s)`). The line is
folded to one line — whitespace collapsed, every control and FORMAT character
replaced (a bidi override in a source line must not rearrange the row it sits
in) — and the list says once that the text is quoted data, not instructions. A
row whose file no longer hashes to the graph's record carries `⚠ file changed
since it was indexed — this line may no longer be the call`, because its line
number counts the old bytes. Before the list, the
target's own declaration rides along while it is 40 lines or fewer (`source —
path:a-b`, line-numbered, the same block `context` prints). This is the
sufficiency half of adoption: a reader who has the callee and every call line
has no file to open. Measured before: `find` answered "5 call site(s)" and the
model read the same file five times; the rows were `path:line` and the caller's
name sat unused in the JSON. The whole text costs about 750 tokens per answer,
spent only when the tool is called, and `DSH_APP_CODEGRAPH_SOURCE=0` turns it
off with the slice.

**And a stale answer names what moved.** `freshness: stale` says the answer
describes the previous state; `pendingFiles` (§9) names the cited files that
did, and the render puts them on the first line.

## 9. Freshness

Every tool answer carries it, and the three values mean different things to a
model: `current` — trust it; `stale` — the working tree moved (or the compensation
ceiling stopped), trust then refresh; `indexing` — the graph is not settled, so wait:
this is either a first touch or a pass/check in flight. `unindexed` exists in the store
type but no tool answer emits it, because the first call queues a pass. §9a's table is
the authoritative mapping from situation to value.

**A stale answer names the files that moved.** "This answer describes the previous
state" is true of every stale answer and actionable in none: forty cited files,
and no way to tell which to open. So a `stale` answer carries `pendingFiles`, the
cited files (the target's, the reference rows', the siblings', the callers') whose
`mtime`/`size` differ from what the graph recorded — one `stat` each, no read
(`changedFilesSinceIndex`), first-mention order, deduplicated — and every
renderer puts it first: `⚠️ N file(s) this answer cites changed since it was
indexed (a.ts, b.ts, …, and K more): their lines may have moved. Read those for
the live content; the rest of this answer is as indexed.` Five are named. A
`current` answer never computes it: the check that made it current has just
compared the tree. Every file an answer cites is checked — `impact` includes the
relationship groups, the test files and the caller tree's nodes — and the
database read behind the `stat` is guarded too: `pendingFiles` is an addition to
an answer that is already valid, and a handle closed underneath it must not
turn that answer into an error.

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

### 9b. The source slice, and its own freshness flag

`codegraph_context` on a symbol returns the declaration's bytes, read from disk at
query time (`src/source.ts`). Four properties make that safe and honest:

- **A path in an answer is a request, not a fact.** A tool answer is produced with
  a model in the loop, so `path` is admitted only when the graph holds a `files`
  row for it AND its resolved absolute form stays inside the project root. An
  indexed path alone is not enough (a row can name `../x`), and containment alone
  is not enough (it would read any file under the root). `relative()` is the
  containment check, not a string prefix: `D:\app` is a prefix of `D:\app-evil`.
- **The recorded hash decides `source.drift`.** The bytes served are always the
  CURRENT ones — refusing to answer would hide the very edit being asked about —
  and the flag is what stops those bytes from being read as the graph's view.
  This is a SECOND freshness channel: `freshness` describes the graph,
  `source.drift` describes the bytes just handed over. They normally agree; when
  they do not, the answer says which half moved.
- **The budget is a table** (`src/budget.ts`). Per-file depth never shrinks as the
  project grows — a big repo with a 4000-line module needs MORE of one file, not
  less — and a declaration longer than the budget is reported as cut in words, not
  only in a boolean.
- **A kill switch, not a config row.** `DSH_APP_CODEGRAPH_SOURCE=0` answers without
  source, exactly as before the reader existed. The risky half of the feature is
  one filesystem read; turning it off must not need a code change on a user's
  machine.

A refusal is a stable code (`disabled` / `not-indexed` / `outside-root` /
`unreadable` / `shortened` / `too-large`), rendered as its own sentence: the six
reasons have six different next steps, and silence would read as "the graph had
nothing to add". `unreadable` and `shortened` are the pair worth keeping apart — the first
sends a reader to check permissions, while the second means the file is fine and
simply got shorter than the graph's record of it, which is a re-index problem.
`too-large` is checked BEFORE the read: the walk skips files past
`MAX_SOURCE_FILE_BYTES`, but a file can grow after it was indexed, and the slice
used to read whatever was there, whole, on the kernel's event loop — the freeze
§7 records — to hash it and take forty lines. `readCallSites` bounds its reading
the same way (a `stat` before each file, a byte total per answer).

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
| A name declared in several files links to all of them (up to ten) — unless this file IMPORTS it from one of them | a signature's type dependencies can read about twice the real count when nothing narrows it — `Model` has 364 annotations but 728 edges because two files declare it | under-reporting callers changes code silently; over-reporting is a row the reader can dismiss. The import clause is the narrowing that costs nothing: `import { Model } from './model'` states which one. What is still missing is a specifier that no `import` clause names (a re-export chain, a path alias), where the same name stays ambiguous |
| `extends` / `implements` have shapes for the TypeScript/JavaScript family only | a Python, Go, Java, C# or Rust project answers these queries with nothing | each language needs its own node table; the grammars differ more here than for calls |
| A module's public surface stops at file → symbol | `export * from './x'` is a file→file edge, so "is this symbol part of the package API" is one hop away, not answered directly | deriving symbol-level publication across a re-export chain means re-scanning every exporting file whenever one changes — the W11b shape that lost edges before |
| A shared name's re-export resolves inside the named module only — for the EXPORT surface | an `export { x } from './y'` where `y` re-exports `x` from `z` links to nothing at the second hop | one hop is what the `from` clause states; following the chain needs import resolution for every step. Calls and signature references are NOT bounded this way: when the clause names a module that declares none of the name (a barrel), the import layer falls back to the project-wide rule, so the cost of a re-export is precision rather than a missing caller |
| The graph is rebuilt from scratch on a schema bump | the first launch after an upgrade shows `indexing` for ~30s | a derived graph is only as good as the pass that filled it; an interrupted rebuild leaves an empty graph that the next open repairs |
| A constructor call is recorded only where the extraction table names its node type — the TypeScript/JavaScript family (`new_expression`), Java and C# (`object_creation_expression`) and Scala (`instance_expression`) | `Dart`'s `Widget()` is a `selector` on the identifier, not a call node, so a Dart class still answers "0 call sites" | measured in a real session: before these rows existed, the most-used class in a TypeScript monorepo answered `0 call site(s)` and the model read twenty files by hand. The four rows above close the case that showed up; Dart's shape needs selector-chain resolution, which is a different piece of work |

The last one has a sharp edge worth stating: an interrupted rebuild leaves a graph
with no rows, and nothing marks it as incomplete. The next open rebuilds it, so the
state is transient — but a query issued during it answers from an empty graph, and
`indexing` is the only signal.

### 10c. The six ways an answer is incomplete, and what each now says

Every one of these was measured, and each used to read as a complete answer.

| the situation | used to answer | now says |
|---|---|---|
| more references than the row limit | `40 rows`, `truncated: true` | `664 reference(s) — 40 shown`, plus the 624 that are missing |
| the sample came from three files out of a hundred | 40 rows, all from one file | 40 rows drawn one-per-file, so a sample looks like a sample |
| the name is declared several times, so no edge was ever built | "no unambiguous symbol matched" | the declarations that share it, their ids, and "ambiguity is not absence" |
| the call goes through an interface, a dispatch or a variable, so no edge exists | an empty list | "no direct callers found — that is NOT safe to change" |
| the symbol has hundreds of callers, so searching for them is expensive | the declaration only | `482 call site(s) — prefer codegraph_impact over searching` |
| the file the symbol lives in was skipped as generated output | "no symbol matched", `current` | `The index skipped N file(s) as generated output … a name that lives in one of them is not in this answer` |

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

The sixth row is the generated-file rule's bill (§12): the rule is a shape, and a
hand-written file with machine-long lines is caught with the bundles. Before the
count travelled with every answer, "no symbol matched" on such a file read as
final. The number is kept in `meta.project` (`generatedSkipped`), read as 0 for a
graph written before the field existed — that read runs against the OLD blob just
before a rebuild, and a strict one would drop the project on upgrade.

### 10d. What this plugin is, in one sentence

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

### 10e. Unloading: the pass must stop before the handles close

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
not produce yields no symbol and the case fails. That covers every bundled
language on every run, and `tests/sfc.test.ts` does the same for the two component
languages (Vue and Svelte), whose `<script>` block is masked into place before the
TypeScript grammar reads it. The on-demand tables (`rust`, `ruby`, `php`, `bash`,
and PowerShell's two rows) are verified only where their wasm is present, because
the repository ships no second copy of a download.

CI closes that gap instead of accepting it: `ci.yml` runs
`plugins/plugin-codegraph/scripts/fetch-ci-grammars.mjs` before the plugin suites
and points `DSH_APP_CODEGRAPH_GRAMMARS` at what it fetched. The script goes
through the product's own `downloadGrammar`, so the recorded sha512 and the wasm
magic check apply to those bytes exactly as they do to a user's, and a fetch
failure is fatal rather than a quiet fallback to skips. A local run without that
variable prints **18 skips** — visible in the count, never silent — and
`DSH_APP_CODEGRAPH_GRAMMARS=<dir>` runs all 125.

**Twelve grammars are BUILT here, not downloaded, and six of them ship on request.**
Kotlin, Swift, Dart, Scala, Elixir, Lua, Zig, R, Julia, Haskell, Objective-C and Groovy
have no entry in the pinned `@vscode/tree-sitter-wasm` set, so their wasm files are
produced from the upstream grammar sources with the tree-sitter CLI. Six of those ship
inside the plugin — Kotlin, Swift, Dart, Objective-C, Lua and R — because they are what a
phone, a desktop or a data team's project is written in. The other six are downloaded from
this app's own kernel release (`grammarUrls` in `languages.ts`): Scala, Elixir, Zig, Julia,
Haskell and Groovy together were 13 MB of an artifact every user downloads, for languages
that almost no repository is written in. Their bytes live in `grammars-optional/` in the
repository, ride the `runtime-<version>` release (release.yml uploads them; the mirror job's
folder upload carries them to ModelScope), and every download is checked against a recorded
sha512 before it is renamed into place. `tree-sitter` CLI 0.27.1 is the version to use — it
must match `web-tree-sitter` 0.27, and a mismatch shows up as `Language.load` failing rather
than as a parse difference. Rebuilding one, from the commits these bytes came from — a
`--depth 1` clone of `main` does not reproduce them:

| Grammar | Upstream | Commit |
|---|---|---|
| Kotlin | `fwcd/tree-sitter-kotlin` | `d6af96d` (2026-10-31) |
| Swift | `alex-pinkus/tree-sitter-swift` | `9e3b87f` (2026-10-13) |
| Dart | `UserNobody14/tree-sitter-dart` | `0038280` (2026-10-18) |
| Scala | `tree-sitter/tree-sitter-scala` | `8c0b6d4` (`v0.26.4`, 2026-11-01) |

```sh
git clone <upstream> /tmp/g && git -C /tmp/g checkout <commit>
cd /tmp/g && tree-sitter generate          # only when src/parser.c is absent
tree-sitter build --wasm . -o <plugin>/grammars/tree-sitter-<lang>.wasm
```

Three of these needed the table to grow a shape it did not have, and the reasons are
worth keeping: `nameChild` accepts a PATH (`arguments > #first`, `type_head > **identifier`,
`field:declarator > field:declarator`) because most of these grammars nest the name;
`declarations` accepts an ORDERED LIST per node type because Elixir spells `defmodule`,
`def`, `defimpl` and `@type` as the same `call` node, told apart by its `target` text; and
`alsoCall`/`heritageFields` exist because Objective-C has two call node types and a
superclass in a FIELD rather than in a clause node.

`tree-sitter-swift` needs one source change first: its scanner reports an
allocation failure with `fprintf(stderr, …)` + `exit(1)`, which leaves
`GOT.mem.stderr`, `fwrite` and `exit` as undefined imports — the wasm runtime
provides no stdio, so the module fails to instantiate. `abort()` keeps the
fail-fast behaviour and links — which means the committed Swift module is NOT
byte-identical to upstream, and a rebuild must reapply that one-line change
(`scanner.c`, the OOM branch) or it will fail to load again. Verify a rebuilt
module through the plugin's own
`parseFile` (`scratch/cg-grammar-probe.ts` is the shape) before committing it:
loading, a clean tree and real symbols are three separate facts.

**What is verified about these bytes, and what is not.** All 20 grammars this plugin
can parse with have been loaded through the pinned `web-tree-sitter` under BOTH host
binaries this app can run — the dev machine's Node 24 and the kernel runtime's own
`node.exe` (22.x) — and every load succeeded. Fourteen of them ship in the plugin; the
six release-hosted ones were read from `grammars-optional/`, which is the same bytes
the release carries. Twelve (the ones built here) were then used to parse a real sample
each, `rootNode.hasError === false` on all twelve. The other eight are the pinned
upstream set, whose real-grammar coverage is `tests/parse.test.ts`: one case per
extraction-table row, each running a real grammar, so a node name the grammar does not
produce fails a case on every run. The ABI that decides whether a module loads at all
is `web-tree-sitter`'s rather than Node's, so those host runs are evidence about the
binary, not about the artifact.

Still unverified: the PACKAGED tree, where `web-tree-sitter` resolves through the
profile's install of the plugin rather than this working tree, and where the six
release-hosted grammars download from a URL that only exists once a release has been
cut with them attached. `npm run verify` proves every suite plugin ACTIVATES in a real
kernel, that its own routes answer and that the resources it ships exist; it parses no
source file and probes no `codegraph` route, so it cannot see a grammar that fails to
load. To repeat the load check by hand: load each `.wasm` (from `grammars/` and
`grammars-optional/`) with `web-tree-sitter` and parse one real sample per language,
asserting `rootNode.hasError === false` — a load failure throws, a version skew parses
into ERROR nodes, and the two are different bugs.

## 12. Switches, counters and the replay scripts

**Generated by shape.** A bundle committed without `.min.` in its name and without
a banner is invisible to the two rules in `ignore.ts`, and it is the expensive
miss: measured on a real repository, 25 such files held 90% of the definitions, 86%
of the edges and 92% of the unresolved calls of a 335-file graph, and their
one-letter names collided with real symbols. `isGeneratedShape` reads the head's
LINE LENGTHS: an average of 500 or more characters is a bundler (a person writes
about 70). The average, not the longest line — a 3,000-character inline fixture
under an otherwise normal head stays a person's file. Documents are exempt by the
walker's word: prose is written one paragraph per line. The verdict is reached
during the walk like the banner one, because `projectChanged` never parses and the
two callers of the walk have to agree. The rule is a SHAPE, not a verdict — a
hand-written file with machine-long lines (a long SQL statement, an embedded blob)
is caught with the bundles — so the count of files skipped this way is kept
(`meta.project.generatedSkipped`) and every tool answer says so (§10c), where
silence would make "no such symbol" read as final.

**Switches are environment variables, and the settings page says so.** Each one
turns OFF a default-on behaviour a user may want gone on one machine: the source
slice in `codegraph_context` (`DSH_APP_CODEGRAPH_SOURCE`), the request pack
(`DSH_APP_CODEGRAPH_PREFETCH`), the search note (`DSH_APP_CODEGRAPH_GREP_NOTE`).
`switches.ts` is their only home — the names, the convention (`0` or `false` is
off; absent, empty or anything else is on, so a typo cannot switch something on by
accident), and `WIRED_SWITCHES`, the list of switches whose behaviour exists. A
switch that gates nothing must not be on that list: "on" beside a feature that is
not there is a lie the page would tell on every render. `GET /status` reports the
wired ones with their variable and live state, and the settings page lists each
with its variable (selectable as one piece), a sentence, and On/Off — a switch
nobody can find is a switch nobody can turn.

**Counters** (`usage.ts`) are per project, in memory, since the process started:
how many times the pushed overview's text changed, how many calls each tool got,
how many requests got a pack or were skipped, how many searches got a note. They
exist because the session log records what a tool ANSWERED, not what the plugin
DECIDED — "the block changed 24 times in one session" leaves no tool call behind —
and a threshold tuned without them is tuned blind. `/status` carries one row per
project, every key present.

**The replay scripts** read the kernel's session logs and print counts only — never
a message, never a card, never anything a person typed:

| Script | Answers |
|---|---|
| `scripts/usage-replay.mjs` | who carried the overview and who called a tool; how big each answer was; how often snapshots were re-pushed and WHICH LINE CLASS changed (`headline` / `hub` / `entry` / `status` …, by multiset difference so an inserted line is not "every line below it changed"); how the model reads (native and inside `run_code`, repeats); the multiplier — every tool answer × the steps after it; **resident context at session end** — the last usage record's prompt tokens (measured), its share of `contextWindow`, compaction and prune counts, and the surface nodes still standing by contributor (the kernel's own fold: a replace shadows the range it names), in characters, converted at each session's own chars/token and labelled an estimate |
| `scripts/prefetch-replay.mjs` | the request pack's gate on real messages: how many carry a code-shaped token, how many resolve a file or a uniquely declared identifier, split by message length, and the pack size that would follow |

Both depend on the kernel's log format (multi-frame zstd, `session.v4.jsonl`), and
the decoder lives in ONE place, the repository's `scripts/lib/session-log.mjs`,
shared with the memory plugin's own scripts — a second copy would be the drifting
duplicate. `--since YYYY-MM-DD` windows, `--json` prints the same data as an
object, and a `--sessions` directory that does not exist exits 2: a wrong path
should be heard, not read as an all-zero green.
