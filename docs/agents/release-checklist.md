# Release checklist

Expanded rules and the full walkthrough live in
[`docs/agents/build-and-release.md`](../docs/agents/build-and-release.md) §4;
this file is the order of operations for cutting a release, with the three
mistakes that have each cost a release called out where they apply.

## Decide what the release contains

The declarations were made where each change landed: every commit touching a
releasable path (`src/`, a plugin's `src/` or `package.json`, the two runtime
build scripts) carried a `changesets/<name>.md` fragment, and ci.yml refused
the push without one. So this section is a REVIEW of what the fragments
declared — `node scripts/check-changeset.mjs --base <last-tag>` lists the
releasable diff — plus the delivery-path walk for anything that predates the
gate:

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

### Two lessons this project paid for (read before deciding what to bump)

- [ ] **A behaviour change with no version bump ships NOTHING.** Measured on
      v0.13.6: four suite plugins had their visible behaviour changed (a settings
      row promoted out of a tab, a row renamed and moved, a registration shape
      changed) and none had its `version` touched, so `suiteVersion` stayed
      `7b7e969e`. The shell's adoption key was then IDENTICAL to what the installed
      kernel already carried, so the update would have unpacked nothing and the
      user would have seen the old UI — **with no error anywhere**. Bumping the
      four plugins moved the key to `28049ec2`, which is what actually delivered
      the change. Bump EVERY plugin whose behaviour changed, not just the one you
      think of first, and verify afterwards that the published artifact carries
      the new versions:
      `tar -xzOf <runtime.tgz> runtime/app/node_modules/@dsh-app/<plugin>/package.json`.
- [ ] **A shell `vX.Y.Z` never covers a fix to code that ships inside the
      runtime.** The runtime is a separate artifact with its own tag
      (`runtime-<dshVersion>`), and the shell only re-extracts it when the
      adoption key changes. So "fix it and re-release the shell" is not a delivery
      path for a plugin change; the runtime has to be rebuilt (see the previous
      item) and the shell tag is a *new* version, never a re-run of the old one.
      Same for the reverse: a `src/` fix cannot reach anyone through a runtime
      release.

## Bump and changelog

- [ ] `version` in `package.json`.
- [ ] `node scripts/fold-changesets.mjs X.Y.Z` — assembles the bilingual
      section from the `changesets/` fragments each change carried (the gate in
      ci.yml enforced that they exist), then deletes them. The output is a
      draft: review and enrich it the way past entries are enriched, keeping
      **zh and en aligned** (same entries, same order).
- [ ] Commit both. `release.yml` refuses a tag whose version has no bilingual
      section, so a tag cut without this step fails instead of publishing an
      empty release page.

## Tag

- [ ] `git tag vX.Y.Z` matching `package.json`, then push it.

## Verify before publishing (the release stays a draft)

- [ ] Every job green: `prepare-release`, `resolve`, six `runtime` cells, four
      `app` cells.
- [ ] **Every cell's manifest carries the suite version you just built**
      (`gh release download runtime-<v> -p 'manifest-<cell>.json'` → `.suiteVersion`).
      A MIXED set is the failure the `resolve` job's own probe guards against: one
      cell left on the previous suite means that platform keeps shipping stale
      plugins and nothing in the release turns red.
- [ ] **The published artifact really contains the new plugin versions** — read
      them out of the tarball, do not trust the log:
      `tar -xzOf dsh-runtime-<cell>-<v>.tgz runtime/app/node_modules/@dsh-app/<plugin>/package.json`.
      This is the check that closes the "bumped nothing / bumped the wrong plugin"
      failure: a manifest can carry a fresh key while a plugin you forgot is still
      the old version.
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
