/**
 * The main window's preload: ONE marker, and nothing else.
 *
 * Why the window has a preload at all, when the security posture says it should
 * not: the kernel's account surface decides whether it exists by asking whether
 * this marker is present. `@deepseek-ai/dsh-client-ui-settings-account` opens
 * with `if (!('dshDesktop' in globalThis)) return` — measured in the upstream
 * source (`packages/client/ui-settings-account/src/client/index.ts:28`) — so on a
 * shell with no preload the account settings section, the sign-in dialog, the
 * balance card and the avatar menu are never registered, and nothing reports why.
 * The marker is the entire switch.
 *
 * What it deliberately does NOT expose, compared with upstream's preload
 * (`apps/desktop/src/preload-app.ts`):
 *
 * - no IPC channel at all (`ipcRenderer` is never imported), so the page cannot
 *   ask the main process for anything;
 * - no `updates` bridge, no `browser` bridge, no directory picker, no
 *   `webUtils.getPathForFile`, no locale channel;
 * - no token, no origin, no filesystem path.
 *
 * The value is frozen: a page that can see it learns only that it runs inside
 * this desktop shell. Everything the account feature needs is kernel-side and
 * travels over the existing `dsh-app://app` transport, so adding a channel here
 * is never the answer. A page outside the app origin gets NOTHING — not even the
 * marker — because the document that may act on it is the one this shell serves.
 *
 * @module dsh-app/main/account-preload
 */
import { contextBridge, ipcRenderer } from 'electron'

/** The app document's origin, spelled out rather than derived from a config. */
const APP_SCHEME = 'dsh-app'
const APP_HOST = 'app'

/** The marker the kernel's account UI looks for. Keep the name in sync. */
export const MARKER_KEY = 'dshDesktop'

/** Private channels of the embedded Platform view (see src/main/platform-view.ts). */
const PLATFORM_IPC = {
  open: 'dsh-platform:open',
  bounds: 'dsh-platform:bounds',
  close: 'dsh-platform:close',
} as const

/** The pages the kernel's account section may embed. */
type PlatformPage = 'usage' | 'top-up'

/** A rectangle in the app window's content coordinates (CSS pixels). */
interface PlatformBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

// The SAME window shows the local splash page first and the app document second,
// so this preload runs in both. The splash is a `file:` document with its own
// injected scripts and no use for any of this — and exposing it there would be
// capability in a document that has nothing to do with the account surface — so
// everything is inside the origin guard, not before it.
if (location.protocol === `${APP_SCHEME}:` && location.hostname === APP_HOST) {
  // 1. The marker. One frozen object; it is what makes the kernel register its
  //    account section at all (`ui-settings-account` returns early without it).
  contextBridge.exposeInMainWorld(MARKER_KEY, Object.freeze({ protocolVersion: 1 }))

  // 2. The Platform view bridge. Three operations, and each one is answered by
  //    the main process only for THIS window's top frame on the app origin (see
  //    `installPlatformIpc`). No credential passes through here in either
  //    direction: the main process holds the account session and the embedded
  //    document gets it from its own preload. This is what turns the account
  //    section's usage / top-up links into an in-app view instead of a browser
  //    tab — without it the kernel falls back to `shell.openExternal`, which is
  //    why the bridge is optional from the kernel's side and safe to add here.
  contextBridge.exposeInMainWorld('dshPlatform', {
    open: (page: PlatformPage, bounds: PlatformBounds): Promise<void> =>
      ipcRenderer.invoke(PLATFORM_IPC.open, page, bounds) as Promise<void>,
    setBounds: (bounds: PlatformBounds): Promise<void> =>
      ipcRenderer.invoke(PLATFORM_IPC.bounds, bounds) as Promise<void>,
    close: (): Promise<void> => ipcRenderer.invoke(PLATFORM_IPC.close) as Promise<void>,
  })
}
