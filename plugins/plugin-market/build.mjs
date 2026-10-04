#!/usr/bin/env node
// Builds the plugin market plugin's two halves (host catalog/install routes +
// browser market panel) via the shared suite recipe.
//
// The host half needs `require.resolve` to locate the kernel CLI package at
// runtime; that handoff is written in-source (createRequire over
// import.meta.url in src/npm.ts).
//
// `yaml` is CommonJS-only, and bundling it INTO the ESM host half makes its
// internal `require('process')` hit esbuild's shim, which throws at run time
// ("Dynamic require of \"process\" is not supported") — the plugin then fails
// to import and the whole market entry is dropped from the loader. The shared
// recipe has no host-banner hook, so this wrapper prepends the standard
// createRequire handoff after buildDual, the same fix plugin-presets and
// plugin-doc apply for their own CJS dependencies.
//
// Run from the dsh-app root (esbuild resolves out of dsh-app/node_modules):
//   node plugins/plugin-market/build.mjs
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDual } from '../build-lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))

await buildDual(here, '@dsh-app/plugin-market')

// ESM require handoff for the bundled CJS dependency (idempotent).
const indexFile = join(here, 'lib', 'index.js')
const requireBanner =
  "import { createRequire as __createRequire } from 'node:module';\n"
  + 'var require = __createRequire(import.meta.url);\n'
const code = await readFile(indexFile, 'utf8')
if (!code.startsWith(requireBanner)) {
  await writeFile(indexFile, requireBanner + code)
}
