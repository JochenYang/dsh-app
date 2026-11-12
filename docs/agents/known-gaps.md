# Known gaps and scaffolds

What is declared but not finished, what is deliberately absent, and what is
planned. Do not assume any of it works. The repository-root `AGENTS.md` carries
a short summary and points here.

- `plugin-brand`, `plugin-client-ui`: scaffolds and route details in their JSDoc and `plugins/README.md`.
  `plugin-brand`'s brand settings namespace and app-info service are declared but not wired; its desktop
  action route IS wired. `plugin-client-ui`'s slot ids come and go — verify against the running UI
  (`probe-settings-nav.cjs`) before wiring a new one.
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
- **`plugin-todo`'s reminders are in-app only.** The watcher and the notice were moved to plugin
  level (`client/reminders.ts` + `client/reminder-toast-host.tsx`, the React-root-on-body shape
  `plugin-rewind`'s recall note uses), so a reminder now rings on any surface — including a
  conversation, which the page-scoped version could not do. What it still cannot do is reach the user
  outside the app: a minimised window or a hidden tray shows nothing, because an OS notification needs
  the shell side (host + IPC) and that is a separate change. Setting, snoozing, marking as seen,
  clearing and the "which task is due" rule are pinned by `store.test.ts`, `apply.test.ts` and
  `reminders.test.ts`.
- **`run_code`'s deadline cannot be handed a nested call.** A PTC program carries a deployment
  elapsed-time deadline (600 s at the cap) that covers nested tool waits; when it fires the runtime
  discards its worker and aborts every in-flight nested call, so work in progress is stopped, not merely
  uncollected. The suite's answer is to keep the long tool OUT of the call: `plugin-swarm` detaches a batch
  invoked inside a `run_code` program into a host background job (`plugins/plugin-swarm/src/background.ts`,
  see `docs/agents/delegation-division.md`). What remains open is the kernel side — a nested tool cannot
  read its caller's remaining budget, so the choice to detach is made on "is nested" rather than on an
  estimate, and no tool can promote a still-running call at the deadline. Both would need upstream changes
  (`exec.deadline` exposure and a promotion contract); neither is planned here.
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
