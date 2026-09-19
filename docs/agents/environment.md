# Environment variables

Every variable the shell, the build scripts and the release tooling read. The
module named in parentheses is the one that resolves it — read that file for the
exact precedence when a value can come from more than one place.

| Variable → meaning (used in) |
|---|
| `DSH_APP_DEV=1` — dev mode: local harness checkout, not a downloaded kernel (`index.ts`) |
| `DSH_APP_DEV_RUNTIME` — explicit dev checkout path, else `../deepseek-harness` (`index.ts`) |
| `DSH_APP_NODE_BINARY` — dev-mode Node for the host child, else `node` from PATH; production uses the bundled `node/node[.exe]` (`index.ts`) |
| `DSH_APP_HOST_CHECKOUT` — built checkout to pack the private host from (`apps/desktop-host/lib/index.js` required) (`build-runtime.mjs`) |
| `DSH_APP_HOST_PACKAGE` — prebuilt host tarball instead of building one (`pnpm pack`) (`build-runtime.mjs`) |
| `DSH_APP_HOST_REPO` — checkout the host source comes from at `dsh-v<DSH_VERSION>`, else sibling `../deepseek-harness` (`build-runtime.mjs`) |
| `DSH_APP_HOST_REPO_URL` — clone URL, used only with no local checkout; empty disables cloning (`build-runtime.mjs`, CI `vars.*`) |
| `DSH_APP_HOST_TAG` — tag the host source is taken from, default `dsh-v<DSH_VERSION>` (`build-runtime.mjs`, CI `vars.*`) |
| `DSH_APP_CHANNEL` — kernel line: `alpha` → alpha tag, `beta` → `next`, else stable; **unset** follows the bundled kernel's own manifest channel (`resources/kernel/manifest.json`, else the repo's `bundled-kernel/manifest.json`) and only falls back to stable with no readable manifest; at build time the cross-line override (`index.ts`, `kernel-line.mjs`, `build-runtime.mjs`) |
| `DSH_APP_ARTIFACT_OWNER` / `DSH_APP_ARTIFACT_REPO` — GitHub owner/repo hosting runtime artifacts (`shared/constants.ts`) |
| `DSH_APP_SUITE_VERSION` — overrides the runtime manifest's content-hash suite version (`kernel-line.mjs`, `sources/dev.ts`) |
| `DSH_APP_NPM_REGISTRIES` — comma-separated registry chain replacing the default (`sources/registry.ts`) |
| `NPM_CONFIG_REGISTRY` — single-registry override; npmmirror still appended (`sources/registry.ts`) |
| `DSH_APP_GITHUB_MIRRORS` — comma-separated mirror URL prefixes; empty disables mirrors (`sources/artifact.ts`, `updater.ts`) |
| `DSH_APP_LOG_DIR` — log directory, default `<userData>` (logs in `<dir>/logs`) (`server.ts`, `index.ts`) |
| `DSH_APP_PRIMARY_RUNTIME` — a staged Python set (upstream's `primary-runtime` tree, `runtime.json` required) to carry inside the office payload; unset means engine-only (`build-runtime.mjs`; `scripts/build-primary-runtime.mjs` produces one) |
| `DSH_APP_OFFICE_PAYLOAD` — payload directory the shell publishes to the kernel child (`<userData>/dsh-app-office/payload/<version>`, set at spawn whether or not it is installed); read per conversion by the runtime's kit shim (`index.ts`, `scripts/runtime-stubs/libreoffice-kit`) |
| `DSH_APP_PROXY_PORTS` — ports to probe, replacing the default list (`proxy-detect.ts`) |
| `DSH_APP_PROXY_WATCHDOG_MS` — watchdog interval, default 30000 (`index.ts`) |
| `DSH_HOME` — dsh profiles home, default `~/.dsh` (`brand-suite.ts`) |
| `DSH_VERSION` — kernel version to bundle, else from the followed dist-tag, then asserted (`build-runtime.mjs`) |
| `NODE_DIST_MIRROR` — mirror for the Node archive; `SHASUMS256.txt` still nodejs.org-first (`build-runtime.mjs`) |
| `MODELSCOPE_TOKEN` / `MODELSCOPE_REPO` — mirror credentials/target; an unset token reports `SKIPPED`; SDK pinned in `MODELSCOPE_SDK_VERSION` (`publish-mirror.yml`, `mirror_release.py`) |
