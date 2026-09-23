#!/usr/bin/env node
/**
 * Bundles the node:test suites with esbuild (TS, type-only framework imports
 * stripped) into .test-dist/ and runs them with `node --test`.
 *
 * Run from anywhere:
 *   node plugins/plugin-presets/scripts/test.mjs
 * or inside the plugin:
 *   npm test
 */
import { buildSync } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const testsDir = join(pluginRoot, 'tests')
const outDir = join(pluginRoot, '.test-dist')

const entryPoints = readdirSync(testsDir)
  .filter(name => name.endsWith('.test.ts'))
  .map(name => join(testsDir, name))

buildSync({
  entryPoints,
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: outDir,
  outExtension: { '.js': '.test.mjs' },
  logLevel: 'error',
  // The host half pulls in `yaml` (CommonJS-only). Bundled into an ESM output
  // its internal `require('process')` hits esbuild's shim and throws at load
  // time, so every test file gets the same createRequire handoff the plugin's
  // own build prepends to lib/index.js.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';\n"
      + 'var require = __createRequire(import.meta.url);',
  },
})

execFileSync(process.execPath, ['--test', ...readdirSync(outDir).filter(name => name.endsWith('.test.mjs')).map(name => join(outDir, name))], { stdio: 'inherit' })
