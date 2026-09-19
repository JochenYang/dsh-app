# AGENTS.md — plugins/ (the brand suite)

How to work on the suite. Repository-wide rules — language, security
invariants, process rules — are in the repository-root `AGENTS.md`; this file adds
what is specific to `plugins/`. Read it before changing a plugin; read the
plugin's own JSDoc header before changing its internals.

## 1. What the suite is

Seventeen dsh plugins layered on top of the upstream kernel **without forking
it** — that is what keeps the desktop app updateable when upstream moves.
`plugins/README.md` is the roster: which plugin owns which capability, and each
one's host/client role. `plugins/dsh-app.patch.yml` is the loader overlay that
mounts them.

Never modify harness source to make a plugin work: desktop adaptation stays
shell-side (injected scripts, stylesheets, profile patch rows only).

## 2. Build, install & test

Install inside the plugin directory, never at the root:

```sh
cd plugins/plugin-memory
npm install --legacy-peer-deps     # plugin-local only; at the ROOT this breaks npm ci
npm run build
npm test
```

Build and test every plugin from the repository root:

```sh
for d in plugins/*/; do (cd "$d" && npm install --legacy-peer-deps && npm run build); done
for d in plugins/*/; do if [ -d "$d/tests" ]; then (cd "$d" && npm test); fi; done
```

- **Build**: sixteen plugins run `node build.mjs` (esbuild bundles both halves).
  `plugin-brand` is the one exception — `tsc -p tsconfig.json` into `lib/`.
- **Tests**: live in `plugins/plugin-*/tests/*.test.ts` and run through the
  plugin's own `scripts/test.mjs`, which esbuild-bundles them (type-only
  framework imports stripped) into `.test-dist/` and runs `node --test` over the
  result. Sixteen plugins have suites; **`plugin-fff` has none**.
- **CI runs every plugin with a `tests/` directory** (`.github/workflows/ci.yml`
  loops over `plugins/*/`), so a suite that passes locally also gates the PR.
  The root `test/plugin-version-bump.test.mjs` additionally fails any plugin
  whose code changed since the last release tag without a version bump.

## 3. Runtime resources

Runtime resources come from each plugin's own `package.json` `files` field,
never a hand list — `smoke-suite.mjs` asserts what a bare `ok:true` cannot
(template catalogs non-empty, bundled font assets present). A `files` entry the
build refuses to ship fails the runtime build, so declare resources there rather
than copying them into the artifact by hand.

## 4. Conventions specific to plugins

- **ESM** with `moduleResolution: "Bundler"` and explicit local-import
  extensions — unlike the CommonJS shell.
- **Each plugin owns its dictionary.** Shell copy lives in
  `src/shared/locale.ts`; a plugin keeps its own table and must not write Han
  characters anywhere else.
- **Host halves never send user-visible prose** — only `HostText { code,
  params?, text? }` (`plugin-websearch/src/wire.ts`): a stable code the client
  maps to its dictionary, plus an English diagnostic.
- **Host routes** register with `ctx.connection.fetch.register(...)` and answer
  under `/api/plugins/dsh-app/<plugin>/<name>` — no `@` in a path segment, and
  only GET/HEAD/POST are admitted. The Connection carrier applies the
  Host/Origin fence and browser auth before a handler runs, so a route carries
  no fence of its own.
- **A suite plugin must be linked into the booted profile's
  `node_modules/@dsh-app`** — the shared link alone yields a silently vanilla
  UI. `brand-suite.ts` re-links both scopes every start.

## 5. Adding, removing or renaming a plugin

The suite roster lives in **five places and must match exactly** —
`plugins/dsh-app.patch.yml`, `scripts/kernel-line.mjs` (`SUITE_PLUGINS`),
`src/main/brand-suite.ts` (`SUITE_PLUGIN_DIRS`), `scripts/smoke-suite.mjs`
(`SUITE_DIRS`), `.github/workflows/release.yml` (the pre-build loop). Update all
five in one commit, then run `smoke-suite.mjs --tgz` against a fresh build.

`npm run check:graph` enforces the static half of this without a kernel or a
network: a roster entry with no package on disk, a core package declared as a
dependency instead of a peer, a packaged `node_modules`, or a peer range that
drifts from the followed kernel line.

**Any change under `plugins/` needs a patch bump in that plugin.** `suiteVersion`
hashes plugin `package.json` versions, not code, so an unbumped plugin ships
nothing — every installation keeps the old one and every local gate stays green.

## 6. Kernel-line bumps

Upstream API drift is the standing risk: slices and `as unknown as` casts bypass
the type gate, so a kernel-deleted API leaves tests green while the runtime
throws. After every kernel-line bump, verify each plugin end to end —
`npm run verify` and `npm run check:plugins -- --kernel <runtime.tgz>` — rather
than trusting a green compile. Detail: the repository-root `AGENTS.md` §3 and
`docs/agents/build-and-release.md`.
