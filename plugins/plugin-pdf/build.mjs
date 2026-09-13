#!/usr/bin/env node
// Builds the PDF plugin's two halves (host tools/skill installer + client
// capsule entries) via the shared suite recipe. pdf-lib and unpdf match none of
// the external filters, so both are bundled INTO lib/index.js — they are pure
// JS with no native pieces, unlike native-loading deps that must stay external.
// The bundled CJK font stays a sibling asset (assets/fonts/), found at runtime
// relative to lib/index.js.
//
// pdf-lib's bundled CommonJS dependencies (pako, fontkit and friends) call
// require() for node builtins at render time. The host half is ESM, where
// `require` does not exist and esbuild's fallback shim throws. The shared
// recipe has no host-banner hook, so this wrapper prepends the standard
// createRequire handoff to the built file after buildDual — the same fix an
// explicit esbuild banner would produce.
//
// Run from the dsh-app root (esbuild resolves out of dsh-app/node_modules):
//   node plugins/plugin-pdf/build.mjs
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDual } from '../build-lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))

await buildDual(here, '@dsh-app/plugin-pdf')

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
