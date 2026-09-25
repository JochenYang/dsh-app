# Changesets

The release input. A change that reaches users on the previous version carries
a fragment here **in the same commit as the change** — the declaration happens
where the change lands, not at release time from the releaser's memory.

Two release classes were paid for exactly that gap: v0.12.5 shipped four
changed plugins to nobody (no version bump, so the suiteVersion hash was
unchanged and every installation kept the old plugin, every gate green), and
v0.13.6 moved a settings row the same silent way. `ci.yml` enforces the
fragment; `scripts/fold-changesets.mjs` consumes it.

## Format

`changesets/<kebab-case-name>.md`:

```markdown
---
shell: patch
plugins: plugin-market, plugin-memory
---

市场插件：SVG 忙碌圈改为主色脉冲。
Market plugin: the SVG busy ring now pulses in the primary colour.
```

- `shell` — the shell tag's impact: `none | patch | minor | major`. `none` for
  a change that only travels through the runtime (a plugin-only change still
  needs its plugin's version bumped; see below).
- `plugins` — comma-separated suite plugin directory names whose behaviour
  changed. **Each must bump its own `package.json` version in the same
  commit**: `suiteVersion` hashes plugin versions, not code, so an unbumped
  plugin ships nothing. The patch field is a single digit (`0.8.9` → `0.9.0`,
  never `0.8.10`).
- Body — exactly two non-empty lines: Chinese first, English second. One line
  each is the discipline; write the user-visible change, not the commit.

## What needs a fragment

Anything that reaches an existing installation — the paths `ci.yml` gates:

- `src/**` (ships with the shell tag)
- `plugins/<plugin>/src/**`, `plugins/<plugin>/package.json`
- `scripts/build-runtime.mjs`, `scripts/kernel-line.mjs` (they decide what the
  runtime contains)

Docs, CI, tests and tooling reach nobody and need none.

## At release time

1. Bump `package.json` (the shell convention: 9 rolls to 0).
2. `node scripts/fold-changesets.mjs <version>` — assembles every fragment
   into the bilingual `CHANGELOG.md` section and deletes them.
3. Review the section (it is a draft; enrich it the way past entries are
   enriched), commit, tag. `release.yml` refuses a tag whose version has no
   bilingual section.
