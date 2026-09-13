#!/usr/bin/env node
// Builds the Word plugin's two halves (host tools/skill installer + client
// capsule entries) via the shared suite recipe. `docx` matches none of the
// external filters, so it is bundled INTO lib/index.js — it is pure JS, unlike
// native-loading deps that must stay external.
//
// docx's bundled CommonJS dependencies (jszip and friends) call require() for
// node builtins at render time. The host half is ESM, where `require` does not
// exist and esbuild's fallback shim throws. The shared recipe has no
// host-banner hook, so this wrapper prepends the standard createRequire handoff
// to the built file after buildDual — the same fix an explicit esbuild banner
// would produce.
//
// Run from the dsh-app root (esbuild resolves out of dsh-app/node_modules):
//   node plugins/plugin-doc/build.mjs
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDual } from '../build-lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))

await buildDual(here, '@dsh-app/plugin-doc')

// ESM require handoff for the bundled CJS dependencies (idempotent).
const indexFile = join(here, 'lib', 'index.js')
const requireBanner =
  "import { createRequire as __createRequire } from 'node:module';\n"
  + 'var require = __createRequire(import.meta.url);\n'
const code = await readFile(indexFile, 'utf8')
if (!code.startsWith(requireBanner)) {
  await writeFile(indexFile, requireBanner + code)
}
console.log('patched lib/index.js with ESM require handoff')
