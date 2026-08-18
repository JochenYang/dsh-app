# DSH App — brand plugin suite (M3)

The suite is two dsh plugins that layer on top of upstream dsh **without forking
it**. This is what keeps the desktop app updateable: when upstream dsh releases a
new version, the shell swaps the kernel and these plugins keep working.

## Packages

| Package | Side | Role |
|---|---|---|
| `plugin-brand` | host | brand settings namespace, app info service, desktop bridge (git info, native dialogs) |
| `plugin-client-ui` | client | brand theme, workspace file panel, reminder summary, trajectory export, model capability badges |

## Client UI enhancement mapping

| Feature | Slot / service (upstream) | Status |
|---|---|---|
| Brand theme | `ctx.theme.register(ThemeDefinition)` — real tokens (`--dsw-alias-*`) | ✅ implemented |
| Workspace file panel (right sidebar, file count, branch summary, @path insertion) | `sidebar.workspaces` (ui-workspace) + host git bridge | 🔶 scaffold — component/store TBD in dev loop |
| Reminder summary in Session hover | `packages/schedule` state + hover slot | 🔶 scaffold — slot id to verify |
| Trajectory toolbar export ZIP | `dsh-session-log-export` `/export` endpoint | 🔶 scaffold — slot id to verify |
| Model capability badges | `ui-settings-models` + `ui-model-selection` | 🔶 scaffold — slot id to verify |

## Integration into the kernel runtime

The runtime artifact build (scripts/build-runtime.mjs) adds the suite via
`file:` references into the runtime profile's package.json, so a published
kernel contains dsh + the suite in one immutable directory. Once the suite is
published to npm, switch those references to version ranges.
