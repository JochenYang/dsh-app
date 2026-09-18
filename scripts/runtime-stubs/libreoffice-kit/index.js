/**
 * Loader shim that stands in for `@deepseek-ai/libreoffice-kit` inside the
 * kernel runtime.
 *
 * Why a shim and not the package itself: `@deepseek-ai/dsh-office-to-pdf`
 * imports the kit STATICALLY, at module scope
 * (`import { createConverter } from '@deepseek-ai/libreoffice-kit'` in its
 * `lib/index.js`), so a runtime tree without the specifier resolvable makes the
 * provider fail to LOAD — the whole plugin entry is refused before a single
 * conversion is attempted. The kit plus its per-platform engine is ~330 MiB
 * unpacked, which every user would otherwise download with every kernel update
 * whether or not they ever convert an office document. So the runtime ships
 * this file (a few hundred bytes) and the engine travels in a separate office
 * payload artifact the shell installs on demand.
 *
 * How the real kit is reached: `DSH_APP_OFFICE_PAYLOAD` names the directory the
 * shell installs the payload into (`<userData>/dsh-app-office/payload/<version>`).
 * It is set at child spawn from the active kernel's own manifest, so the
 * directory may legitimately not exist yet — this module therefore reads it per
 * CALL, never at import time: the user can download the payload while the kernel
 * is running and the next conversion succeeds without restarting anything.
 *
 * When it is missing, `createConverter` rejects with `code: 'unavailable'` —
 * the category the kit itself publishes and the provider already maps to its
 * own `unavailable` conversion error (see the kit's `CODES` and the provider's
 * catch switch). The message names what is missing and where the user can fix
 * it; that is the only actionable sentence this side of the boundary can give,
 * because the provider replaces the message with its own generic one.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Environment variable naming the installed payload directory (may not exist yet). */
const PAYLOAD_ENV = 'DSH_APP_OFFICE_PAYLOAD'

/** The real package inside the payload tree, at the layout the build writes. */
const KIT_PACKAGE_PATH = join('node_modules', '@deepseek-ai', 'libreoffice-kit')

/** The settings row that installs the payload, as the user sees it. */
const SETTINGS_ROW = '「设置 → 诊断 → 办公组件」'

/**
 * Absolute path of the real kit's entry file inside an installed payload, or
 * null when the payload is absent, incomplete, or carries no usable entry.
 *
 * The package's own manifest decides the entry (`exports["."]`, then `main`),
 * exactly like Node's resolver would: reading it here keeps this shim working
 * when the kit changes its layout, without a hand-kept path.
 *
 * @param root - payload directory (`DSH_APP_OFFICE_PAYLOAD`).
 * @returns absolute entry path, or null.
 */
function kitEntry(root) {
  if (typeof root !== 'string' || root === '') return null
  const dir = join(root, KIT_PACKAGE_PATH)
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
  const exported = manifest?.exports?.['.']
  const relative = (typeof exported === 'string' ? exported : exported?.default) ?? manifest?.main
  if (typeof relative !== 'string' || relative === '') return null
  const entry = join(dir, relative)
  return existsSync(entry) ? entry : null
}

/**
 * The refusal for a payload that is not installed. `unavailable` is the kit's
 * own published category for "the engine cannot serve this host", so callers
 * that switch on the code keep working unchanged.
 *
 * @param root - the payload directory the shell named, or '' when none.
 * @returns the error to reject with.
 */
function payloadMissing(root) {
  const where = root === '' ? '(未指定载荷目录)' : root
  const error = new Error(
    `办公文档转换引擎尚未安装：请在${SETTINGS_ROW}中点击「下载」，安装完成后重试。`
    + `\ndsh-app office payload is not installed at ${where}`,
  )
  error.code = 'unavailable'
  return error
}

/**
 * Create a converter exactly like the kit's `createConverter`, resolved through
 * the installed office payload.
 *
 * @param options - the provider's kit options (fonts, timeouts, …), passed through.
 * @returns a promise of the kit's Converter; rejects with `code: 'unavailable'`
 *   when the payload is missing, and with the kit's own error otherwise.
 */
export async function createConverter(options) {
  const root = (process.env[PAYLOAD_ENV] ?? '').trim()
  const entry = kitEntry(root)
  if (entry === null) throw payloadMissing(root)
  const kit = await import(pathToFileURL(entry).href)
  return kit.createConverter(options)
}
