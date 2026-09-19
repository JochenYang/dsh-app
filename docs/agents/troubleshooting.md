# Troubleshooting anchors

Numbers and codes that tell "hung" from "still working". The module beside each
holds the full detail — read it before acting on the signal.

| Signal → meaning | Where |
|---|---|
| `WEB_PROVIDER_AMBIGUOUS` — several usable search providers registered, none pinned | `ctx.web` seam |
| `WEB_PROVIDER_CONFIGURED_MISSING` — the pinned provider is not registered | `ctx.web` seam |
| 90 s (`HOST_READY_TIMEOUT_MS`) — boot failed unless the host child reports `{type:'ready'}` on the IPC channel within this | `server.ts` |
| 8 s (`HOST_SHUTDOWN_GRACE_MS`) then 5 s per signal (`HOST_SIGNAL_GRACE_MS`) — `shutdown` message + closed request pipe → SIGTERM → `taskkill /T` on Windows | `desktop-host.ts` |
| `unsupported Electron runtime fingerprint` — the host was started with Electron's own Node | `index.ts` |
| `unsupported internal option "<dir>"` — argv shape the child does not know: up to 0.1.5 `[entry, projectDir]`, 0.1.6+ `[entry, runtimeDir, projectDir]`; mapped from the host `version`, falling back once | `desktop-host.ts` |
| `installed package "@deepseek-ai/dsh" has no manifest` / `profile bundle … resolved outside the desktop profile` — a host up to 0.1.5 resolves kernel packages from the PROFILE's `node_modules`, not the handed runtime; the shell mirrors the runtime's tree in (hardlinks) for that line only | `desktop-host.ts`, `suite-profile.ts` |
| `N entries did not activate` — the enforcing resolver could not find a row's package: link the suite plugin into the booted profile (root `AGENTS.md` §5) | `brand-suite.ts` |
| `1000 ms × attempt` — crash-restart delay; the counter resets **only** on a ready host, so persistent failure terminates instead of looping | `index.ts` |
| 6 h (`KERNEL_CHECK_INTERVAL_MS`) — background kernel check; never at startup, never auto-installing | `index.ts` |
| 10 s after boot — the one automatic shell-update check; afterwards tray only | `index.ts` |
| 2000 chars / 10 files (`MAX_LOG_LINE` / `MAX_KEPT_LOG_FILES`) — child-log redaction cap and pruning | `redact.ts` / `server.ts` |
| `GPU ≈ 0%` beside non-zero main + renderer — an injected script re-entering a loop per resolution, not a rendering problem | `window.ts` |
| ~30 min to hours — npm dist-tag goes live **before** the runtime matrix finishes uploading, so "安装包尚未发布" in that window is expected | CI |
| `scripts/publish-modelscope.mjs`, `scripts/diagnose-modelscope-upload.mjs` — manual mirror drills; CI uses the Python SDK in `.github/scripts/` | `scripts/` |
| `办公文档转换引擎尚未安装` (code `unavailable`) — the runtime's kit shim ran: the office payload is not installed (or `DSH_APP_OFFICE_PAYLOAD` was not published). A MISSING SHIM instead makes the provider fail to load, which surfaces as a plugin-tree activation fault | `src/kernel/office-payload.ts`, `scripts/runtime-stubs/` |

## Reading a stuck boot

The window is served by forwarding to the kernel child, so a blank window with
`[connection] connection lost, retry` in the client console means the child is
up but the stream handshake was refused — check `host-stream-auth.ts` before
suspecting rendering. A boot that never reaches a window at all is bounded by
the 90 s ready timeout above.
