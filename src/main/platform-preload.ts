/**
 * The embedded Platform view's preload: the credential handoff, and nothing else.
 *
 * Unlike the app window's preload (a single marker), this one has a job. The
 * Platform document is a DeepSeek web page that expects a host-provided `window.dsh`
 * object telling it it is embedded and handing it a token — upstream's contract,
 * reproduced here because the page is the same page. The token arrives through a
 * SYNCHRONOUS bootstrap channel that the main process answers only for this view's
 * own main frame on the session's origin, and it is kept in a closure: the page can
 * call `getAuthToken()` but can never read the value out of a global.
 *
 * Everything is gated on two independent facts, both required:
 *
 * - the origin the main process passed on this view's command line, so a document
 *   that navigated elsewhere gets no bridge even if it somehow kept the preload;
 * - `process.isMainFrame`, so a subframe cannot ask for the credential.
 *
 * If the bootstrap fails or answers something unexpected, NO `window.dsh` is
 * exposed at all. The page then behaves as a plain web page rather than as an
 * embedded one — which is the safe direction: it cannot ask for a token that was
 * never initialized, and the failure is visible as a page that does not sign in
 * rather than as a page that leaks.
 *
 * @module dsh-app/main/platform-preload
 */
import { contextBridge, ipcRenderer } from 'electron'

/** Private channels of the Platform bridge (upstream's names, kept verbatim). */
const PLATFORM_IPC = {
  bootstrap: 'dsh-platform:bootstrap',
  localeChanged: 'dsh-platform:locale-changed',
} as const

type PlatformLocale = 'en_US' | 'zh_CN'

/** The origin argument the main process passes when it creates this view. */
const ORIGIN_ARGUMENT = '--dsh-platform-origin='
const allowedOrigin = process.argv
  .find((argument) => argument.startsWith(ORIGIN_ARGUMENT))
  ?.slice(ORIGIN_ARGUMENT.length)

if (process.isMainFrame && allowedOrigin !== undefined && allowedOrigin !== '' && location.origin === allowedOrigin) {
  let token: string | undefined
  let locale: PlatformLocale | undefined
  const localeListeners = new Set<(locale: PlatformLocale) => void>()

  ipcRenderer.on(PLATFORM_IPC.localeChanged, (_event, value: unknown) => {
    if (value !== 'en_US' && value !== 'zh_CN') return
    locale = value
    for (const listener of localeListeners) {
      try {
        listener(value)
      } catch (error) {
        console.error('platform locale listener failed', error)
      }
    }
  })

  try {
    const value: unknown = ipcRenderer.sendSync(PLATFORM_IPC.bootstrap)
    if (typeof value === 'object' && value !== null
      && 'token' in value && typeof value.token === 'string' && value.token.length > 0
      && 'origin' in value && value.origin === location.origin
      && 'locale' in value && (value.locale === 'en_US' || value.locale === 'zh_CN')) {
      token = value.token
      locale = value.locale
    }
  } catch {
    // Initialization failure retains embedded mode so the page cannot fall back
    // to whatever browser credentials its own session might have.
  }

  contextBridge.exposeInMainWorld('dsh', {
    protocolVersion: 1,
    displayMode: 'embedded',
    getLocale: (): PlatformLocale => {
      if (locale === undefined) throw new Error('platform locale initialization failed')
      return locale
    },
    onLocaleChange: (listener: (locale: PlatformLocale) => void): (() => void) => {
      localeListeners.add(listener)
      return () => { localeListeners.delete(listener) }
    },
    getAuthToken: (): string => {
      if (token === undefined) throw new Error('platform initialization failed')
      return token
    },
  })
}
