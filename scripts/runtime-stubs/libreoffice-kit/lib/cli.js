/**
 * Stand-in for the LibreOffice kit's CLI inside the kernel runtime.
 *
 * Why it must EXIST even when nothing is installed: a 0.1.7-rc.1 desktop host
 * resolves `@deepseek-ai/libreoffice-kit/package.json` while it boots, derives
 * `<packageRoot>/lib/cli.js` from it, and hands that path to `skill-office`,
 * which `statSync`s it as it registers its skills. This directory is what that
 * specifier resolves to in a packaged runtime, so a missing file here fails the
 * host's own startup — before any conversion is ever attempted, and whether or
 * not the user has any use for office documents. `index.js` next door exists for
 * the mirror-image reason (the provider imports the specifier at module scope).
 *
 * Why it hands off to a child process rather than importing the real CLI: the
 * kit's CLI reads its subcommand from its own `process.argv`, which in an
 * import would be this shim's path. Spawning keeps the real entry's argv and
 * stdio exactly as if the model had invoked it directly.
 *
 * The refusal mirrors `index.js`: same payload directory variable, same
 * user-facing sentence. It exits non-zero, because a conversion that silently
 * reported success would be worse than one that never ran.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

/** Environment variable naming the installed payload directory (may not exist yet). */
const PAYLOAD_ENV = 'DSH_APP_OFFICE_PAYLOAD'

/** The real package inside the payload tree, at the layout the build writes. */
const KIT_PACKAGE_PATH = join('node_modules', '@deepseek-ai', 'libreoffice-kit')

/** The entry the host derives from the same manifest, so both name one file. */
const KIT_CLI_PATH = join('lib', 'cli.js')

/** The settings row that installs the payload, as the user sees it. */
const SETTINGS_ROW = '「设置 → 诊断 → 办公组件」'

/**
 * Absolute path of the real kit's CLI inside an installed payload, or null when
 * the payload is absent or does not carry the entry the host expects.
 *
 * @param root - payload directory (`DSH_APP_OFFICE_PAYLOAD`).
 * @returns absolute CLI path, or null.
 */
function kitCli(root) {
  if (typeof root !== 'string' || root === '') return null
  const cli = join(root, KIT_PACKAGE_PATH, KIT_CLI_PATH)
  return existsSync(cli) ? cli : null
}

const root = (process.env[PAYLOAD_ENV] ?? '').trim()
const cli = kitCli(root)
if (cli === null) {
  const where = root === '' ? '(未指定载荷目录)' : root
  process.stderr.write(
    `办公文档转换引擎尚未安装：请在${SETTINGS_ROW}中点击「下载」，安装完成后重试。`
    + `\ndsh-app office payload does not carry ${KIT_CLI_PATH} under ${where}\n`,
  )
  process.exitCode = 1
} else {
  const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit' })
  child.once('error', (error) => {
    process.stderr.write(`dsh-app could not start the LibreOffice kit CLI at ${cli}: ${error.message}\n`)
    process.exitCode = 1
  })
  child.once('exit', (code, signal) => {
    process.exitCode = code ?? (signal === null ? 1 : 1)
  })
}
