# Environment variables

Every variable the shell, the build scripts and the release tooling read. The
module named in parentheses is the one that resolves it — read that file for the
exact precedence when a value can come from more than one place.

| Variable → meaning (used in) |
|---|
| `DSH_APP_DEV=1` — dev mode: the suite plugins come from this repository instead of the runtime, and the updater/rollback paths stay off (`index.ts`) |
| `DSH_APP_DEV_RUNTIME` — a deepseek-harness SOURCE checkout to run as the kernel; it must be built (the shell starts its `apps/desktop-host` and `apps/cli`). **Named explicitly only** — there is no sibling-directory probing, so a pulled-but-unbuilt checkout can never be booted by accident (`index.ts`, `dev.mjs`) |
| `DSH_APP_DEV_KERNEL` — an already-built runtime tree (`node/` + `app/`) to boot in place, leaving the installed kernel and its `current.json` untouched (`index.ts`, `kernel/manager.ts`) |
| *(neither set, with `DSH_APP_DEV=1`)* — the dev run boots the **installed** runtime, the same artifact a packaged start boots; with nothing installed it installs the bundled `kernel.tgz` offline and never reaches the network (`index.ts`) |
| `DSH_APP_NODE_BINARY` — Node for the host child when the kernel is a source checkout (which ships no binary of its own), else `node` from PATH; a runtime tree — installed or named — always uses its own `node/node[.exe]` (`index.ts`) |
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
| `DSH_APP_PROXY_INJECT` — `off` keeps the detected proxy out of the kernel child's environment; any other value (or unset) injects it (`index.ts`) |
| `DSH_APP_PROXY_WATCHDOG_MS` — watchdog interval, default 30000 (`index.ts`) |
| `DSH_HOME` — dsh profiles home, default `~/.dsh` (`brand-suite.ts`) |
| `DSH_VERSION` — kernel version to bundle, else from the followed dist-tag, then asserted (`build-runtime.mjs`) |
| `NODE_DIST_MIRROR` — mirror for the Node archive; `SHASUMS256.txt` still nodejs.org-first (`build-runtime.mjs`) |
| `MODELSCOPE_TOKEN` / `MODELSCOPE_REPO` — mirror credentials/target; an unset token reports `SKIPPED`; SDK pinned in `MODELSCOPE_SDK_VERSION` (`publish-mirror.yml`, `mirror_release.py`) |
| `MODELSCOPE_ENDPOINT` — ModelScope API base the mirror publish/probe/diagnose scripts talk to (`publish-modelscope.mjs`, `diagnose-modelscope-upload.mjs`, `mirror_release.py`) |
| `DSH_APP_LOCALE` — shell language: `zh-CN` / `en-US`, else the OS locale, else zh-CN; the zh table is frozen (`shared/locale.ts`) |
| `DSH_APP_PROFILE` — the suite's own profile name the kernel child boots with; plugin-market and plugin-presets install into the profile this names, and the suite smoke writes it (`index.ts` injects it; `plugin-market`, `plugin-presets`, `smoke-suite.mjs`) |
| `DSH_APP_LEGACY_PROFILE` — the profile a first run migrates the user's patch rows from (`index.ts`) |
| `DSH_APP_DSH_BIN` — dsh CLI the profile-heal and market paths call, else the kernel's own `bin.js` (`index.ts`, `plugin-market`) |
| `DSH_APP_DESKTOP` — desktop-host marker the child reads to pick its transport (`index.ts`) |
| `DSH_APP_SHELL_VERSION` / `DSH_APP_KERNEL_VERSION` / `DSH_APP_KERNEL_CHANNEL` — the facts the 诊断 page shows, injected at spawn (`index.ts`, `plugin-brand` diagnostics facts) |
| `DSH_APP_SHELL_ACTIONS` — the shell action route base the desktop bridge reads (`shell-actions.ts`) |
| `DSH_APP_HARNESS_CHECKOUT` — harness checkout the primary-runtime smoke reads the host's payload module from (`packages/skill/tool-workspace-dependencies/src/index.ts` on the 0.1.7 line, `apps/desktop-host/src/primary-runtime.ts` before it); default: a sibling `../deepseek-harness` (`smoke-primary-runtime.mjs`) |
