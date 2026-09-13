#!/usr/bin/env node
/**
 * Bundles the node:test suites with esbuild (TS, type-only framework imports
 * stripped) into .test-dist/ and runs them with `node --test`.
 *
 * Run from anywhere:
 *   node plugins/plugin-doc/scripts/test.mjs
 * or inside the plugin:
 *   npm test
 */
import { buildSync } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const testsDir = join(pluginRoot, 'tests')
const outDir = join(pluginRoot, '.test-dist')

rmSync(outDir, { recursive: true, force: true })

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
  // The bundled CJS dependency (docx → jszip) calls require() for node
  // builtins at render time; ESM output has no require, so hand one over —
  // the same fix the host build applies post-build.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';\nvar require = __createRequire(import.meta.url);",
  },
  logLevel: 'error',
})

execFileSync(process.execPath, ['--test', ...readdirSync(outDir).filter(name => name.endsWith('.test.mjs')).map(name => join(outDir, name))], { stdio: 'inherit' })
