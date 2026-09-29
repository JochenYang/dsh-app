# Profile supply chain: after every kernel-line move

The two things a kernel-line move breaks **in a user's environment** (not in this
repository), and how much of them is now a command instead of a procedure.

```
npm run profiles:audit     # read-only: exclusions, and which of them are stale
npm run profiles:prune     # drop the stale ones (backup + byte-preserving)
npm run profiles:peers     # which plugins the followed line can still admit
```

All three take `--home <dir>` (default: `$DSH_HOME`, else `~/.dsh`), `--profile
<name>` (repeatable), and `peers` also takes `--kernel <version>` (default: the
line this checkout follows, `scripts/kernel-line.mjs`). `--check` makes either
read-only mode exit non-zero when there is something to act on.

## What the script decided, and what it deliberately left to you

| Job | Automated | Why |
|---|---|---|
| Finding stale `minimumReleaseAgeExclude` entries | ✅ | deterministic: the entry is either in the profile's lockfile or it is not |
| Removing them | ✅ | byte-preserving with a `.bak-before-prune-<YYYYMMDD>` copy |
| Reporting plugins whose peers cap below the line | ✅ | the registry's own `peerDependencies`, judged with semver (prereleases included) |
| **Accepting** an incompatible plugin with a version exemption | ❌ | `allow-version … --accept-risk` is a risk decision; the script PRINTS the exact command |
| Updating a plugin (`dsh plugin … update …`) | ❌ | it mutates the profile's tree; run it yourself and let the audit confirm the result |
| Global install / checkout alignment (`npm i -g`, `git checkout dsh-v…`) | ❌ | it rewrites your machine's global install and your harness checkout |
| Setting `minimumReleaseAge` | **never** | see the invariant below |

## The invariant this tool exists to protect

**Never set `minimumReleaseAge: 0` (or `false`).** That 24 h buffer is what keeps a
freshly-published broken or malicious version out of the dependency graph. The
audit reports a disabled policy prominently and never writes that key.

Pruning the *exclusion list* is different, and it is not cosmetic: pnpm's
release-age check runs against the **lockfile before every command** and ignores
`minimumReleaseAgeExclude` entirely (measured on pnpm 11.7.0 —
`plugins/plugin-market/src/release-age.ts`). The list still governs the
*resolution* path, which is why it is pruned rather than deleted. That is also why
the market lifts the policy **for a single run** instead of writing exclusions.

The other half — a plugin whose `peerDependencies` cap below the followed line — is
**refused at boot** on 0.2.0 and later (`dsh: skipping profile bundle "…"`), where
older lines only warned. `profiles:peers` is the look-ahead for that.

## The standing procedure

1. **Move the line** (only when you mean to): global `dsh` and the
   `deepseek-harness` checkout to the matching tag, then this repository's specs —
   follow `docs/kernel-0.2.0-rc.2-adaptation-and-ports.md` §1 for the repository
   side. `dsh --version`, the checkout's tag and the running instance should agree.
2. `npm run profiles:audit` → if anything is stale:
3. `npm run profiles:prune` → the backup is printed; then in each profile
   `pnpm install --lockfile-only --ignore-scripts` and expect
   `Lockfile passes supply-chain policies`. (A profile whose lockfile is missing is
   left completely alone: nothing can be proven stale without it.)
4. `npm run profiles:peers` → for every `REFUSED` line either update the plugin or
   run the printed `allow-version` command yourself; revoke the exemption once the
   author publishes a compatible version.
5. Start the app and read the log: `skipping` / `disabling` lines are the
   authoritative verdict, and they should be gone.

## Measured on this machine (2026-09-29)

```
dsh-app   3 exclusions, 3 live, 0 stale
web       5 exclusions, 5 live, 0 stale
desktop   no lockfile — nothing judged, nothing pruned
headless / rsi-check   nothing to audit

dsh-app   ok  dsh-better-edit, dsh-context (latest 0.60.0), dsh-git-conventions,
              dsh-lsp-actions, dsh-remote, dsh-vision-bridge,
              dshmarket (latest 1.66.5, peers admit ^0.2.0-rc.1)
          unknown  dsh-notify-desktop, dsh-session-header (file:/git specs — no
                   registry entry to read)
          official @deepseek-ai/dsh-tool-session-query, @deepseek-ai/dsh-toolkit
```

`unknown` is a real verdict, not a failure: a `file:` tarball or a git spec has no
registry entry to compare against.
