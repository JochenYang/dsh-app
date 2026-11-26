# Known gaps and scaffolds

What is declared but not finished, what is deliberately absent, and what is
planned. Do not assume any of it works. The repository-root `AGENTS.md` carries
a short summary and points here.

- `plugin-brand`, `plugin-client-ui`: scaffolds and route details in their JSDoc and `plugins/README.md`.
  `plugin-brand`'s desktop action route IS wired, and its two remaining header TODOs no longer describe a gap
  (verified 2026-11-23): the app-info facts reach the client through the shell's `about-info` action — the About
  page shows the real shell and kernel versions — and a `brand` settings namespace has no consumer: the kernel's
  settings forms project a plugin's own `Config` schema per profile entry, there is no namespace-registration
  API, and nothing in the suite stores a shell-level preference through it. Do not wire either on the strength
  of the TODO; the header is left as it is until a consumer exists. `plugin-client-ui`'s slot ids come and go —
  verify against the running UI (`probe-settings-nav.cjs`) before wiring a new one.
- **Desktop actions ride the shell's own protocol route** (`src/main/shell-actions.ts`,
  `dsh-app://app/__dsh-app/action/<name>`, inside the loaded origin — no port, no kernel child). A
  Node child cannot reach the scheme, so `plugin-brand` hands the client coordinates and the
  diagnostics page calls it; requests carry the top frame's URL + a per-process secret (subframes
  refused).
- **Office payload**: it is still not bundled with the installer — a first run with no network converts
  no documents until the 诊断 row downloads it (`docs/agents/build-and-release.md` §2). The Python set
  the office skills need travels in that same artifact, staged per cell by
  `scripts/build-primary-runtime.mjs` (`DSH_APP_PRIMARY_RUNTIME` carries it into the build) on win32 and
  darwin only: no linux engine is staged or tested here, and one would ride ~150 MB in every linux
  payload (a 0.1.7 host reads a linux manifest itself). Every non-linux cell smoke-verifies the staged
  Python set with the host's own code before shipping (`release.yml`).
- **`plugin-sidebar`** has no automated test suite for its client components — the plugin is verified
  through tsc + esbuild + headless server API smokes. Its Git-panel UI walk
  (`scripts/probe-git-panel.cjs`) was RETIRED on 2026-10-22: it reached the Git view through the
  per-session preference the kernel restores (`localStorage['dsh.conversation.<sessionId>']`,
  `view: 'git'`) because the conversation view-tab STRIP renders only when `conversation.view` holds
  more than one registration (`showTabs = tabs.length > 1` in `ui-conversation`'s
  ConversationSessionHeader) and the suite's `git` is the only registrant on this line — and its
  session-switch step then failed on the switch rather than on the panel, so a red run proved
  nothing. What remains: `buildPathTree` (9 cases) pins the tree nesting and compaction, `diffRulerMarks`
  (6 cases) pins the ruler logic, `scripts/probe-diff-ruler.cjs` pins the ruler's PAINTED proportions,
  and **the single-vertical-scroller rule has no automated check at all** — it is verified by hand.
  A future UI walk has to fix the session-switch precondition first.
- **Pre-release gaps**: macOS signing/notarization and optional Windows signing secrets must be
  supplied as CI secrets; `resources/icon.png` is a placeholder.
- **First-run UX**: kernel download progress is wired into the in-window update card, and the splash
  page offers pause/resume (`manager.ts` `pauseDownload`/`resumeDownload`); checksum display is not.
- **The `0.1.7-alpha.1` host line is history** — nothing about it is pending; what remains is the
  delivery model that would retire the `kernel/` tree, activation file and profile mirror, still
  planned in `docs/capability-roadmap/kernel-package-set.md`.
- **The app update path asks the host before it kills it** — `DshHost.inspectQuit` / `askHostTasks`
  use the child's own `quit-inspection` and `update-tasks` control, and every failure reads as "work
  is in flight" (see `src/main/updater.ts` `confirmNoActiveTasks`).
- **`plugin-todo`'s desktop notification carries a count, never a task's text, and a click does nothing yet.**
  The watcher and the notice were moved to plugin level (`client/reminders.ts` + `client/reminder-toast-host.tsx`,
  the React-root-on-body shape `plugin-rewind`'s recall note uses), so a reminder rings on any surface. Since
  2026-11-23 the same ring also raises a system notification when `document.visibilityState` is `hidden` — a
  minimised window, one hidden to the tray, one fully covered, one on another desktop, a locked screen: every
  state in which the in-app notice cannot be seen — through plugin-brand's `desktop/notify` action
  (`client/desktop-notify.ts`; `WatchHooks` in `reminders.ts` makes the rule testable: only while hidden, once
  per ring, and the second hop goes to the notify action's exact address or nowhere). The body is
  "有 N 条待办到期" by design: an OS notification lands in the desktop's own store (the notification centre's
  history, a lock screen) outside what the app controls, so the task wording stays in the in-app notice (a
  security review's P2, closed that way rather than with a switch). Still open, none planned: a click on the
  notification does not focus the session; a hidden window's timers are throttled by Chromium, so after five
  minutes hidden a ring may arrive up to a minute late; and a page reload re-announces a reminder the user has
  not acted on, by the same catch-up contract as the in-app notice. Setting, snoozing, marking as seen,
  clearing and the "which task is due" rule are pinned by `store.test.ts`, `apply.test.ts` and
  `reminders.test.ts`; the transport by `desktop-notify.test.ts`. Not verified in a packaged window yet.
- **`run_code`'s deadline cannot be handed a nested call.** A PTC program carries a deployment
  elapsed-time deadline (600 s at the cap) that covers nested tool waits; when it fires the runtime
  discards its worker and aborts every in-flight nested call, so work in progress is stopped, not merely
  uncollected. The suite's answer is to keep the long tool OUT of the call: `plugin-swarm` detaches a batch
  invoked inside a `run_code` program into a host background job (`plugins/plugin-swarm/src/background.ts`,
  see `docs/agents/delegation-division.md`). What remains open is the kernel side — a nested tool cannot
  read its caller's remaining budget, so the choice to detach is made on "is nested" rather than on an
  estimate, and no tool can promote a still-running call at the deadline. Both would need upstream changes
  (`exec.deadline` exposure and a promotion contract); neither is planned here.
- **The 2026-11-26 sweep of the other seventeen plugins — what was measured and deliberately
  left.** They were re-checked for hidden cost and silent failure by mechanical scans plus
  measurement rather than another read-through (`scratch/suite-audit/`); ten defects across four plugins
  (usage, market, rewind, sidebar) were fixed, and these were left, each with the number that says why:
  - `plugin-rewind`'s snapshot walk skips only directories it knows (dependency, VCS and cache
    directories — never build output, which a recall must be able to put back), so on this very
    repository (`scratch/` 2.4 GB, `runtime-dist/` 1.5 GB) every snapshot is incomplete: 499 of
    the 1,013 stored manifests carry a `partial` reason, and a recall here reports
    `coverage: partial`. `maxSnapshotFiles` / `maxSnapshotBytes` are the user's knobs; which
    directories to skip by default is a product decision.
  - `plugin-rewind`: the write recorder holds up to 20,000 entries with no byte ceiling (each
    ≤ 4 MiB); manifests are rewritten at every turn and their bytes sit outside the 1 GB blob
    budget; the quarantine keeps everything until it is purged (W24's one remaining item).
  - `plugin-market`: `/catalog` answers a 2.8 MiB payload and recomputes `repoKey` for every
    entry on each request (~7 ms); the install queue holds its mutex while it resolves a
    registry version (≤ 20 s against a dead registry); the skills branch of `market_search` is
    always a live search.
  - `plugin-usage`: `usage.jsonl` has no retention (46,949 rows / 12.8 MB after about three
    months here, loaded synchronously at start: 83 ms), and the watermark file is rewritten on
    every debounced live event (28 KB per write at 558 sessions). A live event that jumped a
    gap carries whatever provider/model the in-memory header cache holds — nothing, right after
    a restart — and the backfill's later re-fold does not correct an existing row's attribution:
    the counts stay right, the per-model cost of those rows can be off.
  - `plugin-archives`: every list, delete and prune calls the kernel's uncached
    `sessionPersistence.list()` — 102 ms and 1,366 filesystem operations for 256 sessions here,
    linear in sessions. That cost is upstream's.
  - `plugin-sidebar`: mounting the Git tab runs four serial git processes (~159 ms, 68% of it
    process start-up); `status` still refuses, now with a coded message, past about 44,000
    untracked entries; the diff view is not virtualized.
- Future: signed kernel manifests; `$DSH_HOME` settings rollback on major-version upgrades. `docs/capability-roadmap/`
  holds the rest of the roadmap; `docs/plans/` holds the plans that are still open.
- **The kernel preflight cannot see a shift in responsibility, or anything at render time.** It answers
  twelve questions about a target line's symbols, declarations, ids and versions
  (`scripts/kernel-preflight.mjs`, table in `kernel-line-regression.md` §1), and the 0.2.2-rc.1 → rc.2
  move measured its recall: every code-level break of that round is now caught, and two classes are not.
  A package that GAINS a responsibility (rc.2's `mcp-manager` took over the servers config, which forced
  `plugin-mcp` from owning a file to being a thin shell) removes no symbol, so no scan here can see it —
  that one is read from the upstream notes. And nothing static covers rendering or runtime behaviour, so
  a line move still ends in a real window (§5 of `kernel-line-regression.md`).
