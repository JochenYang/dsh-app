# AGENTS.md — plugins/ (the brand suite)

How to work on the suite. Repository-wide rules — language, security
invariants, process rules — are in the repository-root `AGENTS.md`; this file adds
what is specific to `plugins/`. Read it before changing a plugin; read the
plugin's own JSDoc header before changing its internals.

## 1. What the suite is

Eighteen dsh plugins layered on top of the upstream kernel **without forking
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

- **Build**: seventeen plugins run `node build.mjs` (esbuild bundles both halves).
  `plugin-brand` is the one exception — `tsc -p tsconfig.json` into `lib/`.
- **A plugin passes four checks before its `lib/` can enter an artifact** — every
  package its `src/**` imports must be accounted for by a dependency field, its
  own `npm run typecheck`; a refusal of a `lib/` older than the plugin's own
  inputs; and a refusal of a build that produced none of the entries its manifest
  declares (`scripts/lib/plugin-gates.mjs` and `scripts/lib/plugin-imports.mjs`,
  run by `build-runtime.mjs`, by `release.yml`'s pre-build loop and by `ci.yml`'s
  `gate` job — the two workflows through
  `node scripts/plugin-gates.mjs <plugin-dir>`). esbuild does not type
  check and npm drops a missing directory silently: a client half calling an
  export its own module stopped exporting bundles fine, ships, and stops the app
  in the renderer instead. **Every package you `import` in `src/` must also appear
  in one of this plugin's own `dependencies` / `peerDependencies` /
  `devDependencies`** (a package declared only at the repository root, or only
  present transitively, does not count as your declaration) — and a
  `@deepseek-ai/*` package you import for RUNTIME must be in
  `peerDependencies`: the kernel provides those at load time, esbuild marks them
  external so nothing else resolves them, and a devDependency satisfies tsc while
  shipping nothing. A type-only import (`import type {} from '…'`, the
  Context-merge idiom) needs no peer — esbuild deletes it. One plugin still
  misses one such peer — `plugin-market`'s `@deepseek-ai/schemastery` — so the
  gate refuses that plugin until it is added; every other plugin is green. The
  type gate needs
  this plugin's declared peers to be resolvable, and `npm install
  --legacy-peer-deps` (what both workflows run) installs dependencies and
  devDependencies but NO peer: a package this plugin imports must therefore ALSO
  be in its own `devDependencies` — the suite's
  convention is both fields with the same spec, which is what
  `@deepseek-ai/dsh-client-ui-primitives` does in all fourteen plugins that import
  it. With that, every plugin's type gate runs in CI. A peer that nothing installs
  makes the gate SKIP this plugin — one line naming the packages, never silently —
  instead of failing a release over an import nobody installed; the other three
  checks need no peer and always run.
- **Tests**: live in `plugins/plugin-*/tests/*.test.ts` and run through the
  plugin's own `scripts/test.mjs`, which esbuild-bundles them (type-only
  framework imports stripped) into `.test-dist/` and runs `node --test` over the
  result. All eighteen plugins have suites.
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
- **Client UI composes the host's primitives; it never redraws them.** A dialog
  is `Modal` (+ `Button`), a diff is `DiffBlock`, an announcement is `Toast`, a
  chart/table/markdown body has its own — all from
  `@deepseek-ai/dsh-client-ui-primitives`. Check that package's export list BEFORE
  writing any surface: the mask, blur, elevation, focus handling, Escape, modal
  layer, fade timing and layering all come with the primitive, and a hand-rolled
  one gets the tokens right and the composition wrong, so it reads as subtly
  off-theme beside every other dialog. This has happened three times in one plugin
  (mask+card, a two-column "diff", a fixed note div) — every time because the
  primitive was not looked for first. Style only the content you add, with
  `var(--dsw-*)` tokens, and override a primitive through its own documented seat
  (`className`, `anchor`, `holdMs`) rather than by redrawing it.
  `RiskConfirmation` is the same package's destructive variant, but it requires an
  acknowledgement checkbox: reserve it for genuinely irreversible choices, and
  prefer a described change (per-item rows + confirm) otherwise. A message that
  must be READ before acting gets the kernel's own hold (8s, the agent-preset
  refusal value), not the 3s announcement default. Reference:
  `plugin-rewind/src/client/{confirm-dialog,recall-note-host}.tsx`, whose tests
  assert the primitives are used and no frame is redrawn.

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

`npm run check:suites:gate` is the other half: it reads the five copies above
and fails when they do not name the same set of plugins, so a roster change that
touched one copy and not the others stops being a silent vanilla boot. A copy
written in a shape the reader does not recognise is exit 2 rather than a pass,
so a row the gate cannot read is red instead of counting as absent.

**Any change under `plugins/` needs a version bump in that plugin**, and the
patch field is a SINGLE digit: a tenth change carries into the minor
(`0.8.9` → `0.9.0`), never `0.8.10`. `suiteVersion` hashes plugin `package.json`
versions, not code, so an unbumped plugin ships nothing — every installation
keeps the old one and every local gate stays green. The bump travels with a
`changesets/<name>.md` fragment at the repository root naming the plugin (see
the root AGENTS.md §7); ci.yml refuses the commit without one, and
`scripts/fold-changesets.mjs` consumes it at release time.

## 6. Kernel-line bumps

Upstream API drift is the standing risk: slices and `as unknown as` casts bypass
the type gate, so a kernel-deleted API leaves tests green while the runtime
throws. After every kernel-line bump, verify each plugin end to end —
`npm run verify` and `npm run check:plugins -- --kernel <runtime.tgz>` — rather
than trusting a green compile. Detail: the repository-root `AGENTS.md` §3, the
kernel-line regression procedure in `docs/agents/kernel-line-regression.md`, and
`docs/agents/build-and-release.md`.
