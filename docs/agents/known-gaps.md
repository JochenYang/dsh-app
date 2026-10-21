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
- **Office payload**: the Python half (upstream's `primary-runtime` set) is wired end to end and
  smoke-verified by every non-linux release cell before shipping, but it is still not bundled with the
  installer — a first run with no network converts no documents until the 诊断 row downloads it
  (`docs/agents/build-and-release.md` §2).
- **`plugin-sidebar`** has no automated test suite for its client components — the plugin is verified
  through tsc + esbuild + headless server API smokes, plus `scripts/probe-git-panel.cjs` (real kernel,
  real window) for the tree, the single-scroller rule and the diff ruler. One kernel-line fact that
  probe had to work around: the conversation view-tab STRIP renders only when `conversation.view`
  holds more than one registration (`showTabs = tabs.length > 1` in `ui-conversation`'s
  ConversationSessionHeader), and on this line the suite's `git` is the only registrant — upstream's
  对话/轨迹 rows are not registered, so there is no tab to click. The Git view is reached through the
  per-session preference the kernel itself restores (`localStorage['dsh.conversation.<sessionId>']`,
  `view: 'git'`), which is why the probe writes that instead of clicking.
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
- Future: signed kernel manifests; `$DSH_HOME` settings rollback on major-version upgrades. `docs/capability-roadmap/`
  holds the rest of the roadmap; `docs/plans/` holds the plans that are still open.
