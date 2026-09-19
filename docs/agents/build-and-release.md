# Build & release

How the runtime artifacts are produced and how a release is cut. Design context
for what these artifacts *are*: `docs/ARCHITECTURE.md` §4–§5, §8. Every command
here runs from the repository root.

## 1. Rebuilding the runtime and the bundled kernel

```sh
node scripts/build-runtime.mjs <platform> <arch> [version]
node scripts/prepare-bundled-kernel.mjs <platform> <arch>
```

Both outputs are gitignored; CI rebuilds them. Omit `<version>` to resolve the
followed line's dist-tag. On a **new kernel line**, bump every
`@deepseek-ai/dsh*` dep in the root `package.json` to one spec (plugins follow via
peer/dev deps), then `npm run typecheck` and smoke `<runtime>/app` →
`node_modules/@deepseek-ai/dsh/lib/bin.js --version`. The runtime also carries the
pinned `@deepseek-ai/dsh-web-frontend` (`latest` lags), the private
`@deepseek-ai/dsh-desktop-host` (from the line's tag; escape hatches in
`environment.md`), and the **Office skills payload** at
`<kernelDir>/runtime/office-skills` — a 0.1.6+ host will not boot without
`<assetRoot>/scripts/check_office.py`, so it is as mandatory as the host (meta
layer).

`build-runtime.mjs` keeps only the **target-scoped** payload (step 2e,
`trimRuntimePayload`): the ported rules from upstream's desktop packaging drop
source maps, `.d.ts`, build caches, `fs-ext` compiler output, domino test
fixtures, other-platform node-pty prebuilds and the koffi import library. The
trim runs BEFORE the file inventory and the tarball, so both describe what
ships.

**Runtime resources come from each plugin's own `package.json` `files` field**,
never a hand list; `smoke-suite.mjs` asserts what a bare `ok:true` cannot.

## 2. The office payload (the engine that is NOT in the runtime)

**The LibreOffice engine is not in the runtime artifact at all.** The kit
(`@deepseek-ai/libreoffice-kit` + its `…-kit-<platform>-<arch>` engine, ~330 MiB
unpacked / ~115 MiB compressed) leaves the tree entirely and travels in a
**second artifact**, `office-payload-<platform>-<arch>-<version>.tgz` (+
`.sha512` and an `office-payload-<platform>-<arch>.json` sidecar), built by
`buildOfficePayload` from the same assembled tree and uploaded to the same
release. `@deepseek-ai/dsh-office-to-pdf` imports the kit **statically at module
scope**, so the runtime keeps a tiny loader shim at that specifier
(`scripts/runtime-stubs/libreoffice-kit`, staged by `stageOfficeKitShim`) which
loads the real kit out of the installed payload at call time and refuses with an
actionable error while it is absent — dropping the package without the shim
makes the provider fail to LOAD, which reads as a plugin-tree fault, not as "the
engine is not installed".

The payload's own install/verify/prune lives in `src/kernel/office-payload.ts`
(the settings row in 诊断 drives it; nothing downloads automatically). Its two
version numbers are load-bearing: the asset name carries the dsh version
(release assets are version-addressed, and the mirror's completeness check reads
them that way), while `<userData>/dsh-app-office/payload/<version>` is named for
the payload's CONTENT (kit version, plus the Python version when a Python set is
carried) — that is what makes a kernel update or a rollback reuse the engine
already on disk.

`buildOfficePayload` installs the closure with its own pnpm project and
`supportedArchitectures` naming the target, so a cross-target cell (win32-arm64
built on a windows x64 runner) gets ITS engine rather than the host's; a payload
without the target's engine fails the build.

A staged Python set (upstream's `primary-runtime`) rides the same artifact when
`DSH_APP_PRIMARY_RUNTIME` names one — `scripts/build-primary-runtime.mjs`
produces one per cell (win32 and darwin only; the host's `readPrimaryRuntime`
refuses a linux manifest), and it is what makes the host's
`load_workspace_dependencies` tool answer at all. Its inputs are pinned in
`scripts/primary-runtime-lock.json`, a copy of upstream's
`apps/desktop/scripts/primary-runtime-lock.json` plus a win32-arm64 cell this
repo added; refreshing it for a new harness line is a manual drill (copy the
values, then check every digest against the official source), and
`node scripts/smoke-primary-runtime.mjs <stagedDir>` proves a staged tree against
the host's own `primary-runtime.ts` — install, five paths, Python imports, Node
and pnpm versions, and the `load_workspace_dependencies` answer itself.

## 3. Line derivation and `suiteVersion`

**Line derivation**: the root `package.json` alone decides the dsh line —
`scripts/kernel-line.mjs` reads the one spec all `@deepseek-ai/dsh*` deps must
share, maps it to a dist-tag, and owns the suite roster + `suiteVersion`;
`build-runtime.mjs` and the workflow's `resolve` assert against it. Moving the
line = one edit (bump, tag).

**`suiteVersion` hashes plugin `package.json` versions**, not code — **any change
under `plugins/` needs a patch bump in that plugin**, or CI reuses the published
runtime (shell-only releases reuse it on purpose). `test/plugin-version-bump.test.mjs`
enforces this against the newest release tag and skips in a shallow clone.

## 4. Shell release SOP

Mechanics live in `.github/workflows/release.yml` (jobs: `prepare-release`,
`resolve`, `runtime` × 6 cells, `app` × 4 cells); the decisions:

1. **Bump + changelog**: `version` in `package.json`; `[Unreleased]` →
   `[vX.Y.Z]` in `CHANGELOG.md` (zh/en aligned); commit both.
2. **Tag + push** `vX.Y.Z` = the `package.json` version.
3. **Verify content before publishing** (green is not proof; the release stays a
   draft): all jobs green (prepare-release + 6 runtime + 4 app); the runtime log
   prints `Runtime artifact ready: …` **and `Office payload artifact ready: …`**
   for the intended kernel; 6 cells with sidecars matching the manifest
   `integrity` (`gh api
   repos/JochenYang/dsh-app/releases/tags/runtime-<v> --jq '.assets[].name'`).
   Each cell must carry `office-payload-<cell>-<dshVersion>.tgz` (+ `.sha512`
   and `office-payload-<cell>.json`) — without it that platform's office
   conversion has no engine at all, and nothing else in the release turns red.
   The `runtime-<dshVersion>` release **must stay prerelease** —
   `/releases/latest` resolves to the newest non-prerelease release, and a runtime
   tag has no `latest.yml`, so it would break updates.
4. **Notes**: `node scripts/gen-release-notes.mjs vX.Y.Z`; incremental, bilingual
   (zh open, English in `<details>`), generated — never hand-written HTML.
5. **Publish the draft** (`gh release edit vX.Y.Z --draft=false --notes-file
   release-notes.md`) with **your own credentials** — CI's `GITHUB_TOKEN` triggers
   nothing and skips the mirror.
6. **Verify the mirror**: Summary `OK` / `SKIPPED` (no token) / `FAILED`
   (+ backfill), `Prune` and `Latest cleanup` checked, `releases/latest/` holding
   only this version + the four `latest*.yml`; a failed mirror never rolls the
   release back. Re-run `gh workflow run publish-mirror.yml -f tag=vX.Y.Z` (after
   a `503`, add `-f mode=diagnose`).
7. **Runtime-only release**: run `npm run check:plugins -- --kernel <runtime.tgz>
   --home <real profile dir>` first (no `--home` → temp DSH_HOME). The runtime
   job queues the ModelScope mirror itself once the six-cell set is up, so
   a dispatch-run runtime no longer needs a manual backfill; if a mirror run
   failed, backfill the same way: `gh workflow run publish-mirror.yml -f
   tag=runtime-<dshVersion>`. A shell release's own mirror run never touches
   runtime assets, so "the shell mirrored fine" says nothing about them.

## 5. Mirror and layer facts

Mirror internals: `.github/scripts/mirror_release.py` (+ tests).
`keep_versions` default 10 governs `archive/`/`prerelease/`; `latest/` is
converged to the last upload, so **the archive is the rollback source**; deletes
use allowlists/single-file guards. Runtime assets go under
`releases/runtime/<tag>/`, never into `versions.json`/`latest/`, prune on
`keep_runtime_versions` default **3**, with a disjoint `<tag>/<file>` delete
allowlist validated before the first delete.

Layers: five + one index per cell; names are the cache keys
(`node`/`vendor`/`meta` content-addressed, `dsh`/`suite` version-addressed); the
client prefers layers and falls back to the tarball; digests
official-first/fail-closed/ModelScope-never; `cleanup()` keeps
`<userData>/kernel/layers/` and drops only unreferenced layers.

The office payload is part of the runtime set the mirror requires: the script
reads each cell's manifest and demands all three payload assets for every cell
once any manifest declares an `officePayload` block (so an engine-less release
still mirrors, but a failed payload upload does not), and both the workflow's
wait loop and `release.yml`'s resolve assertion name the same trio — a mirror
without it leaves that cell's office conversion a permanent 404 while the
runtime install looks healthy.

## 6. Failure recovery

**Never re-run a tag** — electron-builder's publish is not idempotent (422
`already_exists`); delete release + tag, then re-tag:

```sh
gh api -X DELETE repos/JochenYang/dsh-app/releases/<id>
git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z
```

Publishing a FRESH version number cannot collide: `prepare-release` creates an
empty draft, so the 422 only ever appears on a second upload into a release that
already holds the asset.

Runtime tags re-upload with `--clobber` and are safe to re-run. `gh run rerun
<run> --failed` re-executes the ORIGINAL commit (flakes only; a fix needs
`workflow_dispatch`). Never two writers on one runtime tag: check no other
`release.yml` run is active and `git log origin/main..HEAD` is empty.

**A re-run cascades into the app jobs.** `gh run rerun --failed` is documented
as "rerun only failed jobs, **including dependencies**", and measured on run
35450267252 (2026-09-19): one flaked `runtime` cell was re-run and all four
`app` jobs ran again with it — they started at 15:31:18 having already succeeded
at 15:19. Their electron-builder publish then re-uploaded assets already on the
draft; the Linux and Windows cells took the `overwrite published file …
reason=already exists` branch and passed, the macOS cell died on the 422 above.

So decide by whether the app jobs have already uploaded:

1. **`app` still running, or never started** — a re-run is safe.
2. **`app` already succeeded** — do NOT re-run. Either accept the red cell and
   verify content per §4.3 instead, or take the delete-and-re-tag path above. A
   failed `app` job is not evidence of a missing asset: on that run the macOS
   job died after its four installers and `latest-mac.yml` were already in
   place, and their digests matched.
3. **`gh run rerun --job <databaseId>`** (`databaseId`, not the browser URL's
   job number) is the narrower flag, but its help carries the same "including
   dependencies" wording and its cascade behaviour is UNVERIFIED — treat it as
   a re-run, not as a single-job escape hatch.
