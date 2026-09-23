#!/usr/bin/env node
// Builds the preset-packages plugin's two halves (host zip pack/unpack +
// routes + legacy preset migration, browser settings section) via the shared
// suite recipe. fflate is pure JS with a real ESM build, so it bundles into
// both halves without shims.
//
// `yaml` is CommonJS-only (`"type": "commonjs"`, the node condition points at
// dist/index.js), so bundling it INTO the ESM host half makes its internal
// `require('process')` calls hit esbuild's shim, which throws at run time
// ("Dynamic require of \"process\" is not supported"). The shared recipe has no
// host-banner hook, so this wrapper prepends the standard createRequire handoff
// to the built file after buildDual — the same fix plugin-doc applies for docx.
//
// Run from the dsh-app root (esbuild resolves out of dsh-app/node_modules):
//   node plugins/plugin-presets/build.mjs
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDual } from '../build-lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))

await buildDual(here, '@dsh-app/plugin-presets')

// ESM require handoff for the bundled CJS dependency (idempotent).
const indexFile = join(here, 'lib', 'index.js')
const requireBanner =
  "import { createRequire as __createRequire } from 'node:module';\n"
  + 'var require = __createRequire(import.meta.url);\n'
const code = await readFile(indexFile, 'utf8')
if (!code.startsWith(requireBanner)) {
  await writeFile(indexFile, requireBanner + code)
}
console.log('patched lib/index.js with ESM require handoff')
