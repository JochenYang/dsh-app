/**
 * Effective appearance for shell-owned surfaces — the first-launch splash.
 *
 * The UI's appearance is a **dsh setting** (`ui-theme.preference` =
 * `light | dark | system`, default `system`), stored in the user-settings
 * document as a two-key YAML block:
 *
 * ```yaml
 * ui-theme:
 *   preference: dark
 * ```
 *
 * The shell draws its splash before that UI exists, so it reads the document
 * directly. The block is parsed by hand rather than by adding a YAML
 * dependency for one field, and every failure path (no file, no block, an
 * unknown value) resolves to `system` — the setting's own default — which
 * means "follow the OS". A shell surface that cannot tell is never allowed to
 * invent a preference.
 *
 * @module dsh-app/main/theme
 */

import { readFileSync } from 'node:fs'

/** What a shell surface actually renders. */
export type ThemeMode = 'light' | 'dark'

/** The three values the UI's Appearance row persists. */
export type ThemePreference = 'light' | 'dark' | 'system'

/** Settings namespace owned by the UI's theme plugin (its own constant's twin). */
export const THEME_SETTINGS_NAMESPACE = 'ui-theme'

/** Field carrying the selected preference inside that namespace. */
export const THEME_PREFERENCE_FIELD = 'preference'

/** The preference used when the document says nothing usable. */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system'

/**
 * Read the appearance preference out of a settings document.
 *
 * Only the top-level `ui-theme:` block is considered, and only until the next
 * top-level key: `preference` also exists under other namespaces (the locale
 * plugin keeps one), so a document-wide search would happily return the wrong
 * value.
 *
 * @param text - the settings document's contents.
 * @returns the preference, or null when there is nothing usable.
 */
export function parseThemePreference(text: string): ThemePreference | null {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^ui-theme:\s*$/.test(line))
  if (start === -1) return null
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    // A new top-level key ends the block; blank lines and comments do not.
    if (/^\S/.test(line) && !line.startsWith('#')) break
    const match = /^\s+preference:\s*(\S+)\s*$/.exec(line)
    if (match === null) continue
    const value = match[1].replace(/^['"]|['"]$/g, '')
    return value === 'light' || value === 'dark' || value === 'system' ? value : null
  }
  return null
}

/**
 * Read the preference from a settings file.
 * @param settingsFile - absolute path to the user-settings document.
 * @returns the preference, or null when the file is missing or unusable.
 */
export function readThemePreference(settingsFile: string): ThemePreference | null {
  try {
    return parseThemePreference(readFileSync(settingsFile, 'utf8'))
  } catch {
    // A missing or unreadable document is the normal first-run state.
    return null
  }
}

/**
 * Turn a preference into the mode a surface renders.
 * @param preference - the persisted preference, or null when unknown.
 * @param systemDark - the OS's current preference.
 * @returns the mode to apply.
 */
export function resolveThemeMode(preference: ThemePreference | null, systemDark: boolean): ThemeMode {
  const effective = preference ?? DEFAULT_THEME_PREFERENCE
  if (effective === 'light') return 'light'
  if (effective === 'dark') return 'dark'
  return systemDark ? 'dark' : 'light'
}

/**
 * Read the preference out of a PROFILE PATCH document (`cordis.patch.yml`).
 *
 * 0.1.7 keeps user settings as rows in the booted profile's patch instead of in
 * `$DSH_HOME/settings.yaml`, and it renames that file to
 * `settings.yaml.imported` once the import has run — so on that line the reader
 * above finds nothing, and the window would open on the OS preference whatever
 * the user had chosen. Same namespace, same field, different address:
 *
 *     - id: ui-theme
 *       name: '@deepseek-ai/dsh-ui-theme'
 *       config:
 *         preference: dark
 *
 * Narrow on purpose, like {@link parseThemePreference}: the row is found by id,
 * the field is read inside that row only, and the scan stops at the next
 * top-level entry. `preference` also exists under other namespaces (the locale
 * plugin keeps one — see the sibling parser's note), so a document-wide search
 * would return whichever happens to come first.
 *
 * @param text - the profile patch's contents.
 * @returns the preference, or null when there is no ui-theme row with one.
 */
export function parseThemePreferenceFromPatch(text: string): ThemePreference | null {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex(line => /^- id: ui-theme\s*$/u.test(line))
  if (start === -1) return null
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    // The row's block ends where the next top-level entry begins.
    if (/^-/u.test(line)) break
    const match = /^\s+preference:\s*(\S+)\s*$/u.exec(line)
    if (match === null) continue
    const value = match[1].replace(/^['"]|['"]$/g, '')
    return value === 'light' || value === 'dark' || value === 'system' ? value : null
  }
  return null
}

/**
 * Read the preference from a profile patch file.
 * @param patchFile - absolute path to `<profile>/cordis.patch.yml`.
 * @returns the preference, or null when the file is missing or carries none.
 */
export function readThemePreferenceFromPatch(patchFile: string): ThemePreference | null {
  try {
    return parseThemePreferenceFromPatch(readFileSync(patchFile, 'utf8'))
  } catch {
    // A profile that has never been written is the normal first-run state.
    return null
  }
}
