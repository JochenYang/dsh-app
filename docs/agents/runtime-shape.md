# How the app actually runs

The boot path and the parts that move under it: the kernel child, the activation
file, the brand-suite stitching and the office payload. Read this before
touching any of them. The rules that exist because of this shape are in
[`process-rules.md`](process-rules.md); the origin model is in
[`security-invariants.md`](security-invariants.md).

The Electron main process **spawns a real Node child** running the dsh kernel from an installed,
versioned tree (`<userData>/kernel/dsh-<dshVersion>+suite-<suiteVersion>/`, holding `node/` and
`app/`). The window loads `dsh-app://app/index.html`, a privileged custom scheme served only by
forwarding to that child; there is no setup renderer, and the first run downloads or adopts a kernel
in the background, reporting through the in-window update card and the tray.

`<userData>/kernel/current.json` is the **single source of activation truth** (`active`, `previous`,
plus a `bundledStamp`). Versioned directories are immutable; activation is one atomic file rewrite, so
a bad boot always has a `previous` to roll back to, and a kernel that fails to become healthy twice is
rolled back once, then surfaced as an error rather than looping.

The brand suite is stitched in at every server start (`src/main/brand-suite.ts`, `suite-profile.ts`):
its plugins are linked into the booted profile's `node_modules/@dsh-app` and the shared fallback — the
rule and its reason are in [`process-rules.md`](process-rules.md) — it boots its own profile named
`dsh-app` (`SUITE_PROFILE` in `src/shared/constants.ts`; a user's own `dsh web` keeps `web`),
`plugins/dsh-app.patch.yml` is copied into userData as a loader overlay, and every piece degrades
gracefully: a rollback target without the suite boots vanilla, never blocked.

The LibreOffice engine is deliberately **not** in the runtime artifact: it travels in the on-demand
"office payload" (see [`known-gaps.md`](known-gaps.md)), and a loader shim at the kit's specifier turns
an absent payload into an actionable refusal rather than a plugin-tree load fault.
