# Release checklist

Expanded rules and the full walkthrough live in
[`docs/agents/build-and-release.md`](../docs/agents/build-and-release.md) §4;
this file is the order of operations for cutting a release, with the three
mistakes that have each cost a release called out where they apply.

## Decide what the release contains

- [ ] **Does a user on the previous version actually RECEIVE this change?** Walk
      the delivery path, do not assume it:
  - a change in `src/` (the shell) → a new `vX.Y.Z` tag. Nothing else delivers it.
  - a change in `plugins/` or `scripts/build-runtime.mjs` → a **new runtime**, and
    that runtime only reaches an existing install if its identity changed: the
    kernel's adoption key is `dshVersion+suiteVersion` from the runtime manifest,
    and `suiteVersion` is a hash of the **suite plugins' versions** only. So a
    runtime rebuilt with different build logic and no plugin version bump is
    byte-different and *invisible*: the shell compares the key, sees the version
    it already adopted, and never re-extracts.
    **Therefore: bump the suite plugin version(s) whose behaviour changed, or the
    release does nothing.** (`scripts/kernel-line.mjs` `computeSuiteVersion`;
    `src/kernel/bundled.ts` `decideBundledAdoption`.)
  - both → one shell release with a refreshed `bundled-kernel/`; the shell update
    installs the newer bundled kernel and the channel follows it.
- [ ] `runtime-dist/` is gitignored and build output — never commit it.

## Bump and changelog

- [ ] `version` in `package.json`.
- [ ] `[Unreleased]` → `[vX.Y.Z]` in `CHANGELOG.md`, **zh and en aligned** (same
      entries, same order).
- [ ] Commit both.

## Tag

- [ ] `git tag vX.Y.Z` matching `package.json`, then push it.

## Verify before publishing (the release stays a draft)

- [ ] Every job green: `prepare-release`, `resolve`, six `runtime` cells, four
      `app` cells.
- [ ] The runtime log prints `Runtime artifact ready: …` **and**
      `Office payload artifact ready: …` for the intended kernel.
- [ ] Six cells whose sidecars match each manifest `integrity`
      (`gh api repos/<owner>/<repo>/releases/tags/runtime-<v> --jq '.assets[].name'`).
- [ ] Each cell carries `office-payload-<cell>-<dshVersion>.tgz` (+ `.sha512`,
      `office-payload-<cell>.json`) — without it that platform's office conversion
      is a permanent 404 and **nothing else turns red**.
- [ ] The `runtime-<dshVersion>` release **stays a prerelease**:
      `/releases/latest` resolves to the newest non-prerelease release, and a
      runtime tag carries no `latest.yml`.

## Notes

- [ ] `node scripts/gen-release-notes.mjs vX.Y.Z` → `release-notes.md`
      (incremental, bilingual, generated — never hand-written HTML).

## Publish

- [ ] `gh release edit vX.Y.Z --draft=false --notes-file release-notes.md`.
      **The `--notes-file` is not optional**: flipping the draft without it leaves
      an EMPTY release page (measured on v0.13.2, where the notes had to be
      attached afterwards).
- [ ] That flip is what starts the ModelScope mirror
      (`publish-mirror.yml` hooks `release: published`).

## Verify the mirror

- [ ] The run appears within seconds. Summary `OK` / `SKIPPED` (no token on the
      repo) / `FAILED`; `Prune` and `Latest cleanup` checked; `releases/latest/`
      holds only this version plus the four `latest*.yml`.
- [ ] Backfill if needed: `gh workflow run publish-mirror.yml -f tag=vX.Y.Z`
      (after a `503`, add `-f mode=diagnose`). A failed mirror never rolls the
      release back.

## When it goes wrong

- [ ] A shell `vX.Y.Z` tag is **never re-run** — electron-builder's publish is not
      idempotent (422 `already_exists`). Delete the release and the tag, then
      re-tag the same content.
- [ ] A `runtime-<v>` tag CAN be re-run: its upload uses `--clobber`.
- [ ] Recovery detail: `docs/agents/build-and-release.md` §6.
