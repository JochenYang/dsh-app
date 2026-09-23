/**
 * Every suite plugin must expose a localized title, a description and an icon
 * to the kernel's plugin manager — and the failure mode when it does not is
 * SILENT, which is why this is a gate rather than a one-off check.
 *
 * 0.1.7 lets a package declare display metadata as an exported resource: the
 * kernel's `readPluginMeta` (`packages/boot/app-boot/src/package-meta.ts`)
 * resolves `<specifier>/locale/en.json`, then every sibling `<language>.json`
 * in the same directory, and reads `icon` from the manifest. Both lookups go
 * through the package's own `exports`, so a manifest that omits
 * `"./locale/*.json"` resolves NOTHING and the reader falls back to the package
 * name — no error, no diagnostic, just a plugin list full of
 * `@dsh-app/plugin-…`. Measured while adding the metadata: dropping that one
 * `exports` row turned a correct plugin into a bare package name with the
 * reader's `error` field still empty.
 *
 * The checks here are deliberately about the CONTRACT (files, exports, fields,
 * icon constraints), not about the resolved strings: the resolution itself is
 * the kernel's, and this suite cannot import the runtime's copy. `scratch/
 * verify-plugin-meta.mjs` does the end-to-end read against a real runtime and
 * is what proved the shape; this gate keeps the contract from regressing
 * between kernel lines.
 *
 * @module dsh-app/tests/plugin-display-meta
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SUITE_PLUGINS } from '../scripts/kernel-line.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Suite plugins as DIRECTORY names. `SUITE_PLUGINS` holds package names
 * (`@dsh-app/plugin-brand`), which is what the loader needs and what the
 * version gate strips the scope from — this suite works on the checkout, so it
 * strips it once here.
 */
const PLUGIN_DIRS = SUITE_PLUGINS.map(name => name.replace('@dsh-app/', ''))

/** Language ids the kernel's reader admits (its own `LANGUAGE_ID` pattern). */
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u

/** Icon media types the kernel admits, by extension. */
const ICON_EXTENSIONS = ['.svg', '.png', '.jpg', '.jpeg', '.webp']

/** Raw icon byte limit enforced by the kernel. */
const MAX_ICON_BYTES = 256 * 1024

const manifestOf = plugin => JSON.parse(readFileSync(join(ROOT, 'plugins', plugin, 'package.json'), 'utf8'))

test('every suite plugin declares an exported English locale resource', () => {
  // `locale/en.json` is the reader's entry point: without it no dictionary is
  // read at all, and the language files beside it are ignored.
  const missing = []
  for (const plugin of PLUGIN_DIRS) {
    const file = join(ROOT, 'plugins', plugin, 'locale', 'en.json')
    try {
      statSync(file)
    } catch {
      missing.push(`${plugin}: locale/en.json`)
    }
  }
  assert.deepEqual(missing, [], 'the kernel reads display text starting from locale/en.json; these plugins have none, so the plugin manager shows the bare package name')
})

test('every suite plugin exports its locale directory and ships it', () => {
  const problems = []
  for (const plugin of PLUGIN_DIRS) {
    const manifest = manifestOf(plugin)
    if (manifest.exports?.['./locale/*.json'] === undefined) {
      problems.push(`${plugin}: package.json exports has no "./locale/*.json" row`)
    }
    const files = Array.isArray(manifest.files) ? manifest.files : []
    if (!files.some(entry => entry.startsWith('locale/'))) {
      problems.push(`${plugin}: package.json files does not ship locale/`)
    }
  }
  assert.deepEqual(problems, [], 'both rows are load-bearing: without the exports row the reader resolves nothing (silently, falling back to the package name), and without the files row the language files never reach an installed copy')
})

test('every suite plugin locale file carries a title and a description', () => {
  const problems = []
  for (const plugin of PLUGIN_DIRS) {
    const directory = join(ROOT, 'plugins', plugin, 'locale')
    const entries = languageFiles(directory)
    if (!entries.includes('en.json')) {
      problems.push(`${plugin}: no en.json`)
      continue
    }
    for (const name of entries) {
      const language = name.slice(0, -5)
      if (!LANGUAGE_ID.test(language)) {
        problems.push(`${plugin}: locale/${name} is not named after a language id`)
        continue
      }
      const parsed = JSON.parse(readFileSync(join(directory, name), 'utf8'))
      const meta = parsed.meta
      if (typeof meta !== 'object' || meta === null) {
        problems.push(`${plugin}: locale/${name} has no meta object`)
        continue
      }
      for (const field of ['title', 'description']) {
        if (typeof meta[field] !== 'string' || meta[field].trim() === '') {
          problems.push(`${plugin}: locale/${name} meta.${field} is not a non-empty string`)
        }
      }
    }
  }
  assert.deepEqual(problems, [], 'the reader rejects a non-string or empty field, and a malformed dictionary is skipped rather than reported')
})

test('every suite plugin ships an icon the kernel accepts', () => {
  const problems = []
  for (const plugin of PLUGIN_DIRS) {
    const manifest = manifestOf(plugin)
    const icon = manifest.icon
    if (typeof icon !== 'string' || icon === '') {
      problems.push(`${plugin}: package.json has no icon`)
      continue
    }
    // The kernel refuses absolute paths and anything that is not a plain
    // relative path inside the manifest directory.
    if (icon.startsWith('/') || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(icon) || icon.split(/[\\/]/u).includes('..')) {
      problems.push(`${plugin}: icon "${icon}" is not a manifest-relative path`)
      continue
    }
    const extension = icon.slice(icon.lastIndexOf('.')).toLowerCase()
    if (!ICON_EXTENSIONS.includes(extension)) {
      problems.push(`${plugin}: icon "${icon}" is not one of ${ICON_EXTENSIONS.join(', ')}`)
      continue
    }
    const file = join(ROOT, 'plugins', plugin, icon.replace(/^\.\//u, ''))
    let size
    try {
      size = statSync(file).size
    } catch {
      problems.push(`${plugin}: icon "${icon}" does not exist`)
      continue
    }
    if (size > MAX_ICON_BYTES) problems.push(`${plugin}: icon is ${size} bytes, over the ${MAX_ICON_BYTES}-byte limit`)
    // `files` entries are npm archive paths, where a leading `./` is not the
    // convention — upstream writes `icon: "./icon.svg"` with `files: ["icon.svg"]`
    // (`packages/experimental/agent-team-profile/package.json`). Compare the
    // normalized path, not the raw strings.
    const files = Array.isArray(manifest.files) ? manifest.files : []
    const shipped = files.map(entry => entry.replace(/^\.\//u, ''))
    if (!shipped.includes(icon.replace(/^\.\//u, ''))) {
      problems.push(`${plugin}: package.json files does not ship ${icon}`)
    }
  }
  assert.deepEqual(problems, [], 'an icon the reader rejects is dropped from the plugin list (the text still shows), and an icon the files list omits never reaches an installed copy')
})

/** Locale file names in one plugin's locale directory. */
function languageFiles(directory) {
  return readdirSync(directory).filter(name => name.endsWith('.json'))
}
