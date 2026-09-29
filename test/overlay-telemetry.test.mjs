/**
 * The overlay keeps upstream's desktop-only telemetry pair switched OFF.
 *
 * Why this is pinned rather than left to the comment beside the rows. Both rows
 * export product usage events to DeepSeek's own collector
 * (`dsh-host-product-telemetry-otel`, default endpoint
 * `https://dsh-otel-collector.deepseeksvc.com/v1/logs`), and upstream's guard —
 * `disabled: !!js "ctx.get('profileContext')?.name !== 'desktop'"` — does NOT
 * disable them here: the desktop host launches the Web application with
 * `profile: "desktop"` (`dsh-desktop-host/lib/index.js`) while resolving this
 * shell's own profile directory, so that expression evaluates FALSE. Measured
 * 2026-09-29 on a real profile: the exporter loaded, failed its config validation
 * (`$.serviceVersion missing required value` — its `serviceVersion` reads
 * `process.env.DSH_CLIENT_VERSION`, which only the official app sets), the Plugins
 * page showed `desktop-product-telemetry` as 启动失败 and every start logged
 * `2 entries did not activate`.
 *
 * The suite disables both rows instead of satisfying that config: a valid config
 * would let the exporter RUN under the official app's service name, and in safe
 * mode (the suite layer is written empty by design) it would run for real even
 * with the rows pinned here.
 *
 * @module dsh-app/tests/overlay-telemetry
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'

const OVERLAY = path.join(import.meta.dirname, '..', 'dist', 'main', 'dsh-app.patch.yml')

/** The overlay's rows, as id → the row's own text lines. */
function rows(text) {
  const found = new Map()
  for (const block of text.split(/\n(?=- )/u)) {
    const id = /^- id:\s*(\S+)\s*$/mu.exec(block)?.[1]
    if (id !== undefined) found.set(id, block)
  }
  return found
}

test('upstream\'s desktop-only telemetry pair stays disabled by the overlay', () => {
  const overlay = rows(readFileSync(OVERLAY, 'utf8'))
  for (const id of ['desktop-product-telemetry', 'product-analytics']) {
    const row = overlay.get(id)
    assert.ok(row !== undefined, `${id} is overridden by the overlay`)
    assert.match(row, /^\s*disabled:\s*true\s*$/mu, `${id} is switched off, so it neither loads nor verifies its official-app config`)
    // A `!!js` guard would be the expression that DOES NOT hold here (the host
    // reports `desktop`), so the override must be the literal boolean.
    assert.doesNotMatch(row, /!!js/u, `${id} must not be re-guarded with an expression that evaluates the wrong way here`)
  }
})
