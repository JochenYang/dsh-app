/**
 * The host's coded messages, rendered in the active locale.
 *
 * The host is a long-lived child process: its language is fixed at boot, so it
 * never sends prose for anything the user reads (see `HostText` in
 * `src/wire.ts`). It sends a stable code plus the values the sentence
 * interpolates, and the copy lives in this page's dictionary.
 *
 * Kept apart from the section component so the render contract — known code →
 * zh/en copy, unknown code → the host's English diagnostic, nested code in a
 * param slot → that code's own copy, nothing at all → the caller's line — is
 * testable without React and without a browser.
 *
 * @module @dsh-app/plugin-presets/client/messages
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { HostText } from '../wire.ts'
import { NS, type PresetsKey } from './locales.ts'

/** The page's namespace-bound translate, threaded into the helpers below. */
export type Translate = TranslateNS<typeof NS>

/**
 * Copy for the host codes this build knows, keyed by the code itself; the
 * convention is the code with its namespace dot and the following word folded
 * into the key (`preset.entryInvalid` → `presets.host.presetEntryInvalid`).
 *
 * Two kinds of code are deliberately absent. `route.crossOrigin` /
 * `route.methodOnly` can only be triggered by a cross-site or
 * protocol-violating caller, and the two conflict codes never render at all
 * (the page turns any 409 into its own overwrite dialog) — for those the host's
 * English `text` IS the message, and {@link hostMessage} renders it, never a
 * blank line.
 */
const HOST_COPY: Readonly<Record<string, PresetsKey>> = {
  'error.unknown': 'presets.host.unknownError',
  'entry.empty': 'presets.host.entryEmpty',
  'entry.pattern': 'presets.host.entryPattern',
  'path.empty': 'presets.host.pathEmpty',
  'path.backslash': 'presets.host.pathBackslash',
  'path.absolute': 'presets.host.pathAbsolute',
  'path.emptySegment': 'presets.host.pathEmptySegment',
  'path.parentSegment': 'presets.host.pathParentSegment',
  'path.hiddenSegment': 'presets.host.pathHiddenSegment',
  'manifest.notJson': 'presets.host.manifestNotJson',
  'manifest.notObject': 'presets.host.manifestNotObject',
  'subject.preset': 'presets.host.subjectPreset',
  'subject.backup': 'presets.host.subjectBackup',
  'preset.manifestVersion': 'presets.host.presetManifestVersion',
  'preset.manifestKind': 'presets.host.presetManifestKind',
  'preset.manifestEntryMissing': 'presets.host.presetManifestEntryMissing',
  'preset.manifestEntryInvalid': 'presets.host.presetManifestEntryInvalid',
  'preset.entryInvalid': 'presets.host.presetEntryInvalid',
  'preset.unknownEntry': 'presets.host.presetUnknownEntry',
  'preset.compositionMissing': 'presets.host.presetCompositionMissing',
  'preset.manifestMissing': 'presets.host.presetManifestMissing',
  'preset.notZip': 'presets.host.presetNotZip',
  'preset.duplicateMember': 'presets.host.presetDuplicateMember',
  'preset.decompressedTooLarge': 'presets.host.presetDecompressedTooLarge',
  'preset.importTooManyFiles': 'presets.host.presetImportTooManyFiles',
  'preset.exportTooManyFiles': 'presets.host.presetExportTooManyFiles',
  'preset.exportTooLarge': 'presets.host.presetExportTooLarge',
  'preset.archiveTooLarge': 'presets.host.presetArchiveTooLarge',
  'preset.illegalPath': 'presets.host.presetIllegalPath',
  'preset.outsidePayload': 'presets.host.presetOutsidePayload',
  'preset.readDirFailed': 'presets.host.presetReadDirFailed',
  'preset.readFileFailed': 'presets.host.presetReadFileFailed',
  'preset.readRootFailed': 'presets.host.presetReadRootFailed',
  'preset.writeFailed': 'presets.host.presetWriteFailed',
  'backup.manifestVersion': 'presets.host.backupManifestVersion',
  'backup.manifestKind': 'presets.host.backupManifestKind',
  'backup.storeEntryShape': 'presets.host.backupStoreEntryShape',
  'backup.storeDirInvalid': 'presets.host.backupStoreDirInvalid',
  'backup.storeFileNotAllowed': 'presets.host.backupStoreFileNotAllowed',
  'backup.storeFileSensitive': 'presets.host.backupStoreFileSensitive',
  'backup.unknownBlock': 'presets.host.backupUnknownBlock',
  'backup.secretContent': 'presets.host.backupSecretContent',
  'backup.exportTooManyFiles': 'presets.host.backupExportTooManyFiles',
  'backup.exportTooLarge': 'presets.host.backupExportTooLarge',
  'backup.archiveTooLarge': 'presets.host.backupArchiveTooLarge',
  'backup.duplicateMember': 'presets.host.backupDuplicateMember',
  'backup.notZip': 'presets.host.backupNotZip',
  'backup.decompressedTooLarge': 'presets.host.backupDecompressedTooLarge',
  'backup.importTooManyFiles': 'presets.host.backupImportTooManyFiles',
  'backup.illegalPath': 'presets.host.backupIllegalPath',
  'backup.manifestMissing': 'presets.host.backupManifestMissing',
  'backup.writeFailed': 'presets.host.backupWriteFailed',
  'backup.writeFailedRestored': 'presets.host.backupWriteFailedRestored',
  'backup.writeFailedRollbackFailed': 'presets.host.backupWriteFailedRollbackFailed',
  'zip.dataDescriptor': 'presets.host.zipDataDescriptor',
  'zip.undeclaredMember': 'presets.host.zipUndeclaredMember',
  'zip.corrupt': 'presets.host.zipCorrupt',
  'zip.sizeMismatch': 'presets.host.zipSizeMismatch',
  'zip.totalTooLarge': 'presets.host.zipTotalTooLarge',
  'zip.memberMissing': 'presets.host.zipMemberMissing',
  'route.listFailed': 'presets.host.routeListFailed',
  'route.exportFailed': 'presets.host.routeExportFailed',
  'route.backupExportFailed': 'presets.host.routeBackupExportFailed',
  'route.importUnreadable': 'presets.host.routeImportUnreadable',
  'route.presetTooLarge': 'presets.host.routePresetTooLarge',
  'route.backupTooLarge': 'presets.host.routeBackupTooLarge',
}

/**
 * Render one coded host message.
 *
 * Known code → this dictionary (the `t` seat interpolates `{name}`); unknown
 * code → the host's own English diagnostic; nothing at all → the caller's
 * generic line. A `params` value that names another code of this dictionary is
 * that code's own copy — a nested rejection reason, the archive a message is
 * about, a missing OS error code — resolved here, one level deep (nested codes
 * carry no params of their own).
 *
 * @param value - the host message, if it sent one.
 * @param t - the page's namespace-bound translate seat.
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
