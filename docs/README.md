# Documentation index

`docs/` holds every fact an agent needs after the repository-root `AGENTS.md`. This file routes by
category and names the one document that owns each fact, so a topic has a single current source.

| Category | Where | Owns | Update when |
|---|---|---|---|
| The project | [`../README.md`](../README.md), [`../README.en.md`](../README.en.md) | what the app is, install, first run, dev quick start | user-facing behaviour or setup changes |
| Architecture facts | [`ARCHITECTURE.md`](ARCHITECTURE.md) | layers, module boundaries, data flow, security posture, packaging | a module's design or a boundary changes |
| Commands and gates | [`agents/commands.md`](agents/commands.md) | every script, gate, probe and packaging target | a command, gate or probe is added or moved |
| Testing and CI | [`agents/testing.md`](agents/testing.md) | the three test layers, what each is blind to, the CI job order | a suite's shape or the CI order changes |
| Boot path | [`agents/runtime-shape.md`](agents/runtime-shape.md) | the kernel child, activation file, suite stitching, office payload | the boot path moves |
| Environment | [`agents/environment.md`](agents/environment.md) | every variable and the module that resolves it | a variable is added, renamed or removed |
| Security invariants | [`agents/security-invariants.md`](agents/security-invariants.md) | the rules a change must not weaken, with their reasoning | an invariant changes — needs a review, not a fixup |
| Process rules | [`agents/process-rules.md`](agents/process-rules.md) | the rules that each cost a bad day, and why | a new one is paid for |
| Settings rail | [`agents/settings-rail-order.md`](agents/settings-rail-order.md) | the order table and the no-reuse rule | a settings section is added or moved |
| Delegation | [`agents/delegation-division.md`](agents/delegation-division.md) | prompt sections, `plugin-swarm`'s order, the batch-versus-teams split | the split changes |
| Codegraph | [`agents/codegraph.md`](agents/codegraph.md) | what the graph holds, the three pass phases, the three ways it is quietly wrong | `plugin-codegraph`'s model changes |
| Release | [`agents/build-and-release.md`](agents/build-and-release.md), [`agents/release-checklist.md`](agents/release-checklist.md) | the runtime artifact, the office payload, the mirror, the release order | the artifact or the order changes |
| Kernel-line moves | [`agents/kernel-line-regression.md`](agents/kernel-line-regression.md) | the pre-flight touchpoint scan, the gates, the checklist | a kernel line moves |
| Profiles | [`agents/profile-supply-chain.md`](agents/profile-supply-chain.md) | a machine's own `dsh` profiles after a kernel-line move | the mirror rules change |
| Troubleshooting | [`agents/troubleshooting.md`](agents/troubleshooting.md) | a timeout, an error code or a log line you cannot place | a new one is diagnosed |
| Known gaps | [`agents/known-gaps.md`](agents/known-gaps.md) | what is declared but unfinished, and what is deliberately absent | it changes |
| Plans | [`plans/`](plans/README.md) | open plans, their acceptance criteria and their status | a plan starts, changes or finishes |
| Roadmap | [`capability-roadmap/`](capability-roadmap/README.md) | capability domains and whether each one landed | a domain is scoped, lands or stops |
| Research cards | [`memory-topic-cards/`](memory-topic-cards/) | the design evidence behind `plugin-memory` | the conclusion changes |
| History | [`archive/`](archive/README.md), `.devflow/`, `repo/progress/` | finished migrations, regressions, process notes | append only — never current fact |
| Changelog | [`../CHANGELOG.md`](../CHANGELOG.md) | the user-visible change per release, zh/en aligned | every release |

## Single source

- Architecture facts live only in `ARCHITECTURE.md`; `AGENTS.md` §2–§3 point here.
- The full command, gate and probe list lives in `agents/commands.md` (`AGENTS.md` §4 keeps only the four
  everyday ones and points there); the test layers and the CI order only in `agents/testing.md`.
- Each security invariant's reasoning lives only in `agents/security-invariants.md`, each process
  rule's only in `agents/process-rules.md` — `AGENTS.md` §7 and §9 carry the one-line index.
- The unfinished list lives only in `agents/known-gaps.md`; `ARCHITECTURE.md` §9 and `AGENTS.md` §10
  point at it.
- A plan's status lives only in that plan's own `- Status:` header; `plans/README.md` is an index.
- A roadmap domain's status lives only in that domain file's `- Status:` header; the roadmap README
  lists links and one-line themes, no status column.

## Current fact versus history

The status vocabulary is fixed, and it is written in a `- Status:` line at the top of the file:

`current` (the fact itself) · `active` (work in progress) · `draft` (not settled) ·
`planned` (scoped, not started) · `partial` (partly landed) · `done` (finished) ·
`stopped` (deliberately not pursued) · `superseded` (replaced — the successor is named in the file) ·
`mixed` (one current reference inside an otherwise historical file — the file names the part).

Everything under `docs/archive/` is history by location and is never marked `current`; those files
explain why something was done, not what the code does now.

One document is deliberately mixed: [`desktop-optimization-plan.md`](desktop-optimization-plan.md).
Its current part is §4 — the disk, process, network and user-visible contracts, the invariants and the
change prohibitions. Everything else is the progress record of an executed plan and reads as history.
Its order table was a copy of [`agents/settings-rail-order.md`](agents/settings-rail-order.md) and is
gone from there, because the copy had drifted.

## Naming and placement

- A new document goes into an existing directory. A new top-level category is a change to this file
  first.
- Plans go in `plans/`; finished migrations and regression records go in `archive/`; process notes go
  in `.devflow/`.
- Documents reference each other by relative path. Moving or deleting one means clearing every inbound
  link in the same change.
- No category is created without real content: an empty document is worse than a missing one, because
  it answers a question with nothing.
