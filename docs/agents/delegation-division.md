# The delegation division (batch vs Agent Teams)

Two delegation paths exist in this client's kernel, and they answer different
questions. This document is the reference for why the prompt sections are
ordered and worded the way they are; the code is `plugins/plugin-swarm/src/index.ts`.

## The two paths

| | batch (`swarm`) | Agent Teams (`spawn_teammate` + task board) |
|---|---|---|
| Owner | this suite (`plugin-swarm`) | upstream bundle (`@deepseek-ai/dsh-experimental-agent-team-profile`) |
| Shape | one call fans out N self-contained tasks | Lead + durable named teammates over a shared task board |
| Ordering | none — items are independent by contract | `blocked_by` on `team_task_create`, enforced by the kernel (`taskReady`, `TEAM_TASK_BLOCKED`) |
| Lifetime | one shot; `childId` + `resume_entries` for follow-ups. Inside a `run_code` program the batch detaches into a host background job (see below) | durable; `send_message` steers or wakes a member |
| Between stages | nothing | Lead reviews, then updates the task or messages the owner |
| Cost | one tool round trip | create tasks, spawn members, message, wait, claim, complete |

Neither can do the other's job. The batch has no dependency concept at all
(`expand.ts` has no ordering code, and the tool schema has no `blocked_by`), and
a Team spent on independent fan-out only adds coordination rounds.

## The detached lane (a batch started inside `run_code`)

`run_code` carries a deployment deadline — 120 s by default, 600 s at the cap
of `@deepseek-ai/dsh-ptc-runtime-node`'s `timeoutMs` / `maxTimeoutMs`, and it
covers "nested tool and approval waits". When it fires the runtime DISCARDS its
worker (`evaluation.finish(..., discard)`) and the PTC executor aborts every
in-flight nested call, so a synchronous batch is stopped together with its
children: the work is lost, not merely uncollected. Nothing can promote a call
that has already been killed, so the fix is on the batch's side — it must not
be inside the call.

A batch invoked from a nested call (its tool-call id carries the executor's
`:ptc:` segment) registers itself as a host background job instead
(`plugins/plugin-swarm/src/background.ts`, over `ctx.jobs`):

| | synchronous | detached |
|---|---|---|
| Lifetime owner | the tool call (`exec.signal`) | the calling agent's SESSION |
| Result | the tool result, immediately | one job settlement notice + `job_output` |
| A `run_code` deadline | kills the batch and its children | stops the program only |
| Cancellation | the call's abort | `job_kill`, or the session/agent closing |
| Child notices | one per child (`delivery: 'parent'`) | none for fresh children (`delivery: 'caller'`); a resumed child keeps the delivery it was created with, so resume batches may still emit those |

Selection is `mode`: `auto` (default) detaches only inside a `run_code`
program, `inline` forces the synchronous path, `background` detaches even
outside one. `auto` is governed by the `backgroundInPtc` setting, so a user who
wants no extra collect step can turn it off and keep every batch synchronous.

The cost is one extra round trip: the job tooling inlines a completion notice
only when the complete unread text fits `inlineOutputBytes` (2048 B), and a
batch report usually does not, so the model reads it with `job_output`. That
report is ONE model-facing write, bounded by the producer to 48 KiB of UTF-8
with the batch header first — the job ring and `job_output` both truncate the
TAIL, so without that bound a long report would lose exactly the part that says
what happened. Over the bound the producer keeps whole item blocks while they
fit and then one status line per remaining item while the budget allows; the
trailer states how many items it could not even name.

What this does NOT fix, and where the kernel ask belongs: a nested tool has no
way to learn its caller's remaining budget, so `auto` detaches on the STRENGTH
OF BEING NESTED rather than on an estimate; and `run_code` still cannot hand a
still-running nested call to a job at its deadline. Both need kernel work, not
a plugin.

## Why the prompt order is what it is

The model chooses between them by what the prompt says and where, so the three
sections are one contiguous decision:

| order | section | owner | says |
|---|---|---|---|
| 590 | `tool:agent-team` | this suite | WHEN to open a Team (ordering, review between stages, durable peers) |
| 600 | `team:policy` | upstream tool-agent-team | HOW to cooperate inside one (write scopes, `FS_STALE_VERSION`, `wait_agent`) |
| 620 | `tool:swarm` | this suite | WHEN to batch (independent, non-overlapping, one shot), and what to hand to the Team |

The original value was **116.6**, which sorts into the persona/plan band
(`HARNESS_IDENTITY` -1000, `DEPLOYMENT_PERSONA_PREFIX` 0, `PLAN_POLICY` 500), so
the batch guidance rendered ~480 positions ahead of the Team policy and before
every tool description. Measured consequence: a composition carrying both kept
choosing the batch for work that needed stages. Section orders are **one
namespace** for global and agent-scoped layers — `assemble()` merges them and
then sorts — so "scoped" is not a way to keep a section out of this ordering.

## Why the Team section is a separate, optional mount

Upstream's `team:policy` states the capability and the cooperation rules but
never the trigger: it opens with "Agent Teams is available in this session" and
spends its length on scopes and messaging. A model holding that plus an
imperative batch section reaches for the batch every time — one side asks for
the work, the other only waits. The suite supplies the missing half.

The mount is `ctx.inject(['agentTeams'], …)`, **not** an entry in the plugin's
own `inject` list. `agentTeams` is provided by the Agent Teams bundle, which a
profile may not list; a required service would stop the whole plugin — tool,
command and batch guidance included — on every composition without it. The
optional door also covers the real composition order, where the bundle layer
registers after this plugin's fiber is already active.

`tool:agent-team` is deliberately **not** named `team:policy`: a scoped section
shadows a global section of the same name (kernel `system-prompt`, `section()`),
so the collision would silently replace upstream's policy instead of adding to it.

## Verifying a change here

Both probes boot the **real** kernel services out of the installed tree and
drive the real assembly, because the facts they check are invisible to a unit
test over constants:

```sh
npm run build                                  # the probes import lib/
node scripts/probe-swarm-team-prompt.mjs       # P1–P5: order, both sections survive, division text, interpolation
node scripts/probe-team-section-mount.mjs      # I1–I4: optional mount both directions, unmount on removal
```
`probe-swarm-team-prompt.mjs` reads upstream's Team policy text out of the
installed `dsh-experimental-tool-agent-team` package and registers it at the
kernel's own order 600, so the ordering assertion is made against the real
section rather than a paraphrase. If a future kernel line renames that section,
the probe fails loudly instead of passing on a stale assumption.

The detached lane is proved by `tests/background.test.ts` (mode resolution,
registration, one-write report, `delivery: 'caller'`, cancel → interrupt), which
takes a fake job registry and a fake subagent seam. What it cannot prove is the
real thing — that a job outlives a `run_code` deadline — so that needs a live
`npm run dev` run on the PTC preset: start a batch whose items take longer than
the program's remaining budget, and confirm the job keeps running (header list),
the notice arrives, and `job_output` carries the per-item report. Raising the
PTC ceiling is a profile-patch knob (`ptc-runtime` row), not a code path: the
lane must be correct at the DEFAULT 600 s cap, which is the value to test at.

## Changing the knobs

`maxActiveSubagents` (16, `plugins/dsh-app.patch.yml`) is **shared** by both
paths — the kernel keys the pool per root agent — and `swarm` holds a steady 12
while the Team bundle allows `maxMembers: 8`. Both at full load exceeds the pool;
the batch re-queues at the limit (`orchestrator.ts`) while a Team records the
member as failed. Raising either ceiling is a whole-process change, not a
per-plugin one.

## Measured behaviour (2026-10-22, DeepSeek-V4.1-Flash, `npm run dev`)

The probes below prove the sections assemble and mount. They cannot prove what a
model DOES with them, so two runs were made against a throwaway workspace on the
`dev` path (where `devSuiteSources()` links the working tree — no runtime install
is needed to test a prompt change, `src/main/index.ts:1244`).

**Ordered task** (research → backend → frontend, each stage gated on the user's
review). The model opened Agent Teams and created three shared tasks:

| task | blocked_by | write scope |
|---|---|---|
| 调研 README.md 与 api.ts 的数据流 | — (ready) | — |
| 在 api.ts 中新增按名称过滤的函数 | `task-1` | `api.ts` |
| 在 view.tsx 接上名称过滤输入框 | `task-2` | `view.tsx` |

It then reported its own state honestly: `task-1` ready, `task-2` and `task-3`
locked by their blockers, no teammate spawned yet — and named the empty workspace
as the one blocker rather than inventing file contents. Both halves of the
intended behaviour, then: the ordering came from the board (`blocked_by`), and the
review gate held because an incomplete blocker cannot be claimed.

**Independent task** (three unrelated files, all at once). The same model used
`swarm` with `max_concurrency: 3`, one item per file. No Team, no tasks — the
other half of the division.

Two things this pair establishes that the probes could not: the model reads the
division as intended in BOTH directions (so the result is not one-sided
preference), and the dependency mechanism it reaches for is the kernel-enforced
one (`blocked_by`), not a self-imposed ordering in prose.

Not established: whether it would have chosen the same way on a full-size prompt
in a real project (both runs were narrow planning tasks), and whether a spawned
teammate then respects the gate when it claims work.

