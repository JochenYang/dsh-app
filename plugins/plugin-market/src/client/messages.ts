/**
 * The host's coded messages, rendered in the active locale.
 *
 * The host is a long-lived child process: its language is fixed at boot, so it
 * never sends prose for anything the user reads (see `HostText` in
 * `src/errors.ts`). It sends a stable code plus the values the sentence
 * interpolates, and the copy lives in this panel's dictionary.
 *
 * Kept apart from the panel component so the render contract — known code →
 * zh/en copy, unknown code → the host's English diagnostic, nested code in a
 * param slot → that code's own copy, nothing at all → the caller's line — is
 * testable without React and without a browser.
 *
 * @module @dsh-app/plugin-market/client/messages
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { HostText } from '../errors.ts'
import { NS, type MarketKey } from './locales.ts'

/** The panel's namespace-bound translate, threaded into the helpers below. */
export type Translate = TranslateNS<typeof NS>

/**
 * Copy for the host codes this build knows, keyed by the code itself; the
 * convention is the code with its namespace dot and the following word folded
 * into the key (`pkg.tooLong` → `mkt.host.pkgTooLong`).
 *
 * Some codes are deliberately absent, because the host's English diagnostic IS
 * the message in every locale: `catalog.httpStatus` (an HTTP status reads the
 * same everywhere), `catalog.requestFailedDetail` (the fetch library's own
 * words), `route.crossOrigin` / `route.methodOnly` (only a cross-site or
 * protocol-violating caller can trigger them) and `route.bodyTooLarge` /
 * `route.invalidBody` (transport-level, about the request itself).
 * {@link hostMessage} renders their `text`, never a blank line.
 */
const HOST_COPY: Readonly<Record<string, MarketKey>> = {
  'error.network': 'mkt.host.networkError',
  'pkg.notString': 'mkt.host.pkgNotString',
  'pkg.empty': 'mkt.host.pkgEmpty',
  'pkg.tooLong': 'mkt.host.pkgTooLong',
  'pkg.invalid': 'mkt.host.pkgInvalid',
  'version.notString': 'mkt.host.versionNotString',
  'version.notExact': 'mkt.host.versionNotExact',
  'profile.invalid': 'mkt.host.profileInvalid',
  'entryId.invalid': 'mkt.host.entryIdInvalid',
  'buildAllow.unsafeName': 'mkt.host.buildAllowUnsafeName',
  'cli.notFound': 'mkt.host.cliNotFound',
  'registry.notFound': 'mkt.host.registryNotFound',
  'registry.versionNotFound': 'mkt.host.registryVersionNotFound',
  'registry.httpFailed': 'mkt.host.registryHttpFailed',
  'registry.lookupFailed': 'mkt.host.registryLookupFailed',
  'registry.badResponse': 'mkt.host.registryBadResponse',
  'registry.incomplete': 'mkt.host.registryIncomplete',
  'registry.versionMismatch': 'mkt.host.registryVersionMismatch',
  'source.notString': 'mkt.host.sourceNotString',
  'source.empty': 'mkt.host.sourceEmpty',
  'source.tooLong': 'mkt.host.sourceTooLong',
  'source.unparsable': 'mkt.host.sourceUnparsable',
  'source.notHttps': 'mkt.host.sourceNotHttps',
  'source.hasCredentials': 'mkt.host.sourceHasCredentials',
  'source.notArray': 'mkt.host.sourceNotArray',
  'source.tooMany': 'mkt.host.sourceTooMany',
  'catalog.timeout': 'mkt.host.catalogTimeout',
  'catalog.requestFailed': 'mkt.error.request',
  'catalog.notJson': 'mkt.host.catalogNotJson',
  'catalog.notObject': 'mkt.host.catalogNotObject',
  'catalog.responseTooLarge': 'mkt.host.catalogResponseTooLarge',
  'repo.unknown': 'mkt.unknownRepo',
  'install.confirmLocal': 'mkt.host.installConfirmLocal',
  'install.confirmCrossOrigin': 'mkt.host.installConfirmCrossOrigin',
  'install.timeout': 'mkt.host.installTimeout',
  'install.commandFailed': 'mkt.host.installCommandFailed',
  'install.commandFailedLog': 'mkt.host.installCommandFailedLog',
  'update.notInstalled': 'mkt.host.updateNotInstalled',
  'update.suiteManaged': 'mkt.host.updateSuiteManaged',
  'update.localOrGit': 'mkt.host.updateLocalOrGit',
  'update.latestUnknown': 'mkt.host.updateLatestUnknown',
  'update.upToDate': 'mkt.host.updateUpToDate',
  'toggle.suiteManaged': 'mkt.host.toggleSuiteManaged',
  'toggle.enableNotBoolean': 'mkt.host.toggleEnableNotBoolean',
  'toggle.manualDisable': 'mkt.host.toggleManualDisable',
  'allowBuild.packagesNotArray': 'mkt.host.allowBuildPackagesNotArray',
  'allowBuild.tooMany': 'mkt.host.allowBuildTooMany',
  'allowBuild.localOrGit': 'mkt.host.allowBuildLocalOrGit',
  'route.internalError': 'mkt.host.routeInternalError',
  'route.catalogFailed': 'mkt.host.routeCatalogFailed',
}

/**
 * Render one coded host message.
 *
 * Known code → this dictionary (the `t` seat interpolates `{name}`); unknown
 * code → the host's own English diagnostic; nothing at all → the caller's
 * fallback. A `params` value that names another code of this dictionary is that
 * code's own copy — an unprovable repo side, a missing OS error code —
 * resolved here, one level deep (nested codes carry no params of their own).
 *
 * @param value - the host message, if it sent one.
 * @param t - the panel's namespace-bound translate seat.
 * @param fallback - line to show when the host sent nothing this build knows.
 * @returns the copy of the active locale.
 */
export function hostMessage(value: HostText | undefined, t: Translate, fallback: string): string {
  if (value === undefined) return fallback
  const key = HOST_COPY[value.code]
  if (key === undefined) return value.text ?? fallback
  const params: Record<string, string | number> = {}
  for (const [name, raw] of Object.entries(value.params ?? {})) {
    const nested = HOST_COPY[String(raw)]
    params[name] = nested === undefined ? raw : t(nested)
  }
  return t(key, params)
}

/** One source-failure line: the host's coded reason, never blank. */
export function sourceReasonOf(reason: HostText, t: Translate): string {
  return hostMessage(reason, t, t('mkt.error.request'))
}
