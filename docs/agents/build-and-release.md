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

The runtime also carries **pnpm** at `<kernelDir>/runtime/pnpm` (`stagePnpm`),
pinned by `scripts/primary-runtime-lock.json` — the same pin the office payload
uses, so one bump moves both, and the tarball is sha512-verified before it is
unpacked. Why it must be there: every package operation the kernel performs is a
child process, and the `dsh plugin … add` path resolves the command by NAME
through `PATH` (`plugin-manager`'s `pnpmCommand` default), so an installer cannot
assume the user has one. The shell wires it in twice — at the front of the kernel
child's `PATH` and in the desktop host's package-manager argument slots
(`webShapeArgs`) — and `split-runtime-layers.mjs` keeps `runtime/pnpm` in the
`node` layer, whose re-assembly check fails if any entry belongs to no layer.
The pin must track CI's `pnpm/action-setup` version: the profile lockfiles are
written by whichever pnpm assembles the runtime.

`build-runtime.mjs` keeps only the **target-scoped** payload (step 2e,
`trimRuntimePayload`): the ported rules from upstream's desktop packaging drop
source maps, `.d.ts`, build caches, `fs-ext` compiler output, domino test
fixtures, other-platform node-pty prebuilds and the koffi import library. The
trim runs BEFORE the file inventory and the tarball, so both describe what
ships.

**Runtime resources come from each plugin's own `package.json` `files` field**,
never a hand list; `smoke-suite.mjs` asserts what a bare `ok:true` cannot.

**The installer pre-extracts the bundled kernel** (`scripts/installer/
installer-hooks.nsh`, wired through `nsis.include` in electron-builder.yml):
an NSIS `customInstall` hook unpacks `resources/kernel/kernel.tgz` into
`resources/kernel-staged/` with Windows' own `tar.exe` while the installer runs,
so the app's first launch adopts the staged tree (`src/kernel/staged.ts`, a
rename — or a copy when userData sits on another volume) instead of unpacking
~13k files behind the splash. The tarball's sha512 is verified against its
sidecar before the stage is touched, and every fault falls back to the app's own
extraction path, so a failed pre-extraction is a slower first launch, never a
broken install. Windows only by construction (macOS/Linux installers have no
NSIS hook); the stage is an installer artifact and dev runs simply have none.

The same file replaces the stock app-running check with an exact-match one
(`customCheckAppRunning`): the stock matches every process whose path starts
with `$INSTDIR`, so installing into a shared directory — a Program Files root —
finds and tries to kill the user's unrelated software and dies in the
"cannot be closed" loop; the replacement matches only
`$INSTDIR\<app>.exe`.

The same file also carries the update-path fallback
(`customUnInstallCheck` / `customUnInstallCheckCurrentUser`). On an update the
installer runs the PREVIOUS version's uninstaller first and treats any non-zero
exit as fatal ("Failed to uninstall old application files"). That uninstaller
ships on the user's machine already, so it cannot be fixed retroactively — and
it cannot survive an install on another drive: with `--updated` it renames
every installed file into `$PLUGINSDIR` (TEMP) before deleting, and **NSIS's
`Rename` cannot cross volumes** (measured: D:→C: and C:→D: both fail), so a
D: install with TEMP on C: aborts on the first file and exits 2. Every in-app
update from a non-system drive hits this (electron-updater invokes the
installer with `--updated /S /D=<dir>`, `NsisUpdater.js`). The hooks replace
the stock failure handling: when the old uninstaller fails or cannot be
launched, remove the previous install directly (`RMDir /r` deletes file by
file, so it is volume-agnostic) plus its registry entries, and let the install
continue. User data is never in scope — `$DSH_HOME` (`~/.dsh`) and the Electron
userData live outside `$INSTDIR`, the registry keys and the shortcuts, and the
update path passes `--updated`, which suppresses app-data deletion.

Rebuild note: the D: drive on the maintainer's machine rejects writes from
electron-builder's bundled 7za and makensis, so local verification builds must
pass `-c.directories.output=<C: path>`.

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

**The kit version is PINNED** (`DESKTOP_OFFICE_KIT_VERSION` in
`scripts/kernel-line.mjs`, imported by `build-runtime.mjs` and overridden into
the assembly), and that pin is what keeps the payload version reproducible. The
kernel line declares `^0.1.1` — a floating range — so without the pin the same
source produces a runtime demanding whatever kit existed on the build DATE.
Measured on this tree: kit 0.1.2 was published 2026-09-25T16:02Z, twelve hours
after the 0.1.7-rc.2 runtime was cut, so a rebuild resolved 0.1.2 and every
installed `0.1.1-py3.12.14` payload stopped satisfying its kernel. The row then
offered a download that could only fail: release assets are named after the
KERNEL version, so the 0.1.2 requirement pointed at an asset still carrying the
0.1.1 payload.

The pin lives in `kernel-line.mjs` because it is part of the build's IDENTITY,
not a build knob: `computeSuiteVersion` hashes it, so a pin bump moves the kernel
directory name, the `bundledStamp` and the adoption decision together. Without
that, a pin-only bump would leave the stamp equal, `decideBundledAdoption` would
answer `already-adopted`, and the runtime demanding the new payload would reach
nobody — the same silent no-op the CI reuse gate compares the kit for.

Bumping the pin is therefore a two-step act, in this order:

1. Bump `DESKTOP_OFFICE_KIT_VERSION`, build, and PUBLISH the runtime. The release
   then carries an `office-payload-<platform>-<arch>.json` whose
   `payloadVersion` names the new kit.
2. Only after that artifact is public does a runtime requiring it become
   installable by existing users.

Users see the change as an UPDATE, never as a fresh install: the payload
directory is named for the kit and Python versions alone, so an unchanged kit
keeps satisfying every later kernel, and a bumped one shows the previously
installed version beside the new requirement (`installedOnDisk` in
`src/kernel/office-payload.ts`, rendered by the 诊断 row).

`buildOfficePayload` installs the closure with its own pnpm project and
`supportedArchitectures` naming the target, so a cross-target cell (win32-arm64
built on a windows x64 runner) gets ITS engine rather than the host's; a payload
without the target's engine fails the build.

A staged Python set (upstream's `primary-runtime`) rides the same artifact when
`DSH_APP_PRIMARY_RUNTIME` names one — `scripts/build-primary-runtime.mjs`
produces one per cell (win32 and darwin only: a 0.1.7 host reads a linux
manifest too, but no linux engine is staged or tested here and one would ride
~150 MB in every linux office payload), and it is what makes the host's
`load_workspace_dependencies` tool answer at all. Its inputs are pinned in
`scripts/primary-runtime-lock.json`, a MERGE of upstream's
`scripts/primary-runtime/lock.json` — 0.1.7-alpha.2 moved that file out of
`apps/desktop/scripts/` — with two additions of this repo: a win32-arm64 cell,
and the pnpm pin upstream resolves from its own workspace. Refreshing it for a
new harness line is therefore a merge, not a copy — the shared values move
together, both additions stay, and every digest is then checked against the
official source, and
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
under `plugins/` needs a version bump in that plugin**, or CI reuses the published
runtime (shell-only releases reuse it on purpose). The patch field is a single
digit: a tenth change carries into the minor (`0.8.9` → `0.9.0`), never
`0.8.10`. `test/plugin-version-bump.test.mjs` enforces this against the newest
release tag and skips in a shallow clone.

## 4. Shell release SOP

Mechanics live in `.github/workflows/release.yml` (jobs: `prepare-release`,
`resolve`, `runtime` × 6 cells, `app` × 4 cells); the decisions:

**Before anything else — three things that cost a release each (each is expanded
where it belongs, and each has bitten this project):**

| Rule | Why | Where |
|---|---|---|
| The `runtime-<dshVersion>` release **stays a prerelease** | `/releases/latest` resolves to the newest NON-prerelease release, and a runtime tag carries no `latest.yml` — publishing it as a normal release points the shell's own update check at a release that cannot answer it | §4.3 |
| A shell **`vX.Y.Z` tag is never re-run** | electron-builder's publish is not idempotent (422 `already_exists`); recovery is delete release + delete tag, then re-tag with the same content | §6 |
| **Publish WITH the generated notes** | `node scripts/gen-release-notes.mjs vX.Y.Z` → `release-notes.md`, then `gh release edit vX.Y.Z --draft=false --notes-file release-notes.md`. Flipping the draft without `--notes-file` leaves an EMPTY release page — measured on v0.13.2, where the notes had to be attached afterwards | §4.4–§4.5 |
| The **ModelScope mirror runs itself** when the draft is flipped to published | `.github/workflows/publish-mirror.yml` hooks `release: published`, which IS that moment (a job inside `release.yml` cannot observe it), and `MODELSCOPE_TOKEN` supplies the credentials. A manual `gh workflow run publish-mirror.yml -f tag=vX.Y.Z` is the **backfill** path (after a `503`, add `-f mode=diagnose`) — not a required step | §4.5–§4.7 |

**And know which line the release moves**: the shell's kernel channel comes from
the manifest of the kernel it bundles (`bundledKernelChannel`,
`src/main/index.ts:93`), and a user's kernel-update path is pinned to that
channel's dist-tag. So a shell released on an `alpha` bundle cannot update its
kernel past an alpha version whose runtime was never published — the artifact
probe returns early and the alternatives on other tags are never considered
(`src/kernel/manager.ts:358-364`). Shipping a shell whose bundled kernel is
`rc` (channel `beta` → dist-tag `next`) is what moves those users onto the new
line: the shell update installs the newer bundled kernel, and the channel follows
it. Backfilling an older line's runtime helps only users who do NOT take the
shell update.

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
   release-notes.md`). That moment is what starts the mirror:
   `publish-mirror.yml` hooks `release: published` (a job inside `release.yml`
   cannot observe the flip, and mirroring an unreviewed draft would push every
   version that review later discards into ModelScope for good).
6. **Verify the mirror** (the run appears within seconds of step 5): Summary
   `OK` / `SKIPPED` (no token on the repo) / `FAILED` (+ backfill via
   `gh workflow run publish-mirror.yml -f tag=vX.Y.Z`), `Prune` and
   `Latest cleanup` checked, `releases/latest/` holding
   only this version + the four `latest*.yml`; a failed mirror never rolls the
   release back. Backfill the same tag with
   `gh workflow run publish-mirror.yml -f tag=vX.Y.Z` (after a `503`, add
   `-f mode=diagnose`) — runs of one tag are serialized repo-wide
   (`concurrency: publish-mirror`, `cancel-in-progress: false`), so a queued
   backfill waits instead of racing the running one.
7. **Runtime-only release**: run `npm run check:plugins -- --kernel <runtime.tgz>
   --home <the DSH_HOME, the directory holding profiles/>` first (it is not the
   profile directory itself; no `--home` → temp DSH_HOME). The runtime
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
`<userData>/kernel/layers/` and drops only unreferenced layers. `node` also
carries `runtime/pnpm` (the tree's bundled package manager), so a pnpm bump
renames that layer on its own — and any runtime entry no layer claims fails
`split-runtime-layers.mjs`'s own re-assembly check.

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
