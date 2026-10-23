#!/usr/bin/env node
/**
 * Download the ON-DEMAND grammars so the plugin's real-grammar cases can run.
 *
 * The suite has one case per extraction-table row, and each parses a real source
 * snippet: a `nameField` naming a field the grammar does not have produces no
 * symbol, and the case fails. That protection covers the nine BUNDLED languages
 * on every run, because their wasm files are in the repository.
 *
 * The four on-demand tables (`rust`, `ruby`, `php`, `bash`) are downloaded into a
 * user's storage at run time, and the repository deliberately does not ship a
 * second copy — that is what "on demand" means. Without this step CI printed
 * **16 skips** for exactly the tables a change is most likely to touch, so the
 * gate that catches a wrong node name never ran on them.
 *
 * This fetches them the way the PRODUCT fetches them — `downloadGrammar`, the
 * same function the settings page calls, which checks the wasm magic number and
 * the recorded sha512 before the bytes are kept. Nothing here trusts a new
 * source: `GRAMMAR_SHA512` and `GRAMMAR_BASE_URL` are already the plugin's own.
 *
 * Run: node plugins/plugin-codegraph/scripts/fetch-ci-grammars.mjs <outDir>
 *
 * @module dsh-app/plugin-codegraph/scripts/fetch-ci-grammars
 */
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')

const outDir = process.argv[2]
if (outDir === undefined) {
  console.error('usage: fetch-ci-grammars.mjs <outDir>   (the directory DSH_APP_CODEGRAPH_GRAMMARS will name)')
  process.exit(2)
}

// Imported rather than reimplemented: the table is the plugin's, and a second
// copy of the language list here is how a CI step starts testing a different set
// from the one that ships. `pathToFileURL` because a drive-letter path is not a
// URL Node will import on Windows — measured, ERR_UNSUPPORTED_ESM_URL_SCHEME.
const { LANGUAGES, downloadGrammar } = await import(
  pathToFileURL(resolve(pluginRoot, 'src', 'languages.ts')).href
)

const target = resolve(outDir)
mkdirSync(target, { recursive: true })

/** Bundled files live in the plugin; only the downloaded ones are fetched. */
const paths = { bundledDir: join(pluginRoot, 'grammars'), downloadDir: target }
const wanted = LANGUAGES.filter(language => !language.bundled)

let fetched = 0
for (const spec of wanted) {
  // A language with NO extraction rules still downloads: the settings page has to
  // be able to report its install state, and `css` appearing in the route suite is
  // what makes "installed but not indexable" a tested claim.
  try {
    await downloadGrammar(spec, paths)
    fetched += 1
    console.log(`fetched: ${spec.id} (tree-sitter-${spec.grammar}.wasm)`)
  } catch (error) {
    // A failure here must NOT be silent: the suite would print skips and go
    // green, which is the exact outcome this script exists to prevent.
    console.error(`FAILED to fetch ${spec.id}: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

if (fetched === 0) {
  console.error('fetched nothing; the suite would skip every on-demand case')
  process.exitCode = 1
} else {
  console.log(`\n${String(fetched)} of ${String(wanted.length)} on-demand grammars in ${target}`)
}
