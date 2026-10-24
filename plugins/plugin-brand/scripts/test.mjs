#!/usr/bin/env node
/**
 * Bundles the node:test suites with esbuild (TS, type-only framework imports
 * stripped) into .test-dist/ and runs them with `node --test`.
 *
 * Run from anywhere:
 *   node plugins/plugin-brand/scripts/test.mjs
 * or inside the plugin:
 *   npm test
 */
import { buildSync } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { readdirSync, rmSync, existsSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const testsDir = join(pluginRoot, 'tests')
const outDir = join(pluginRoot, '.test-dist')

// esbuild writes the bundles it builds and leaves everything else, so a bundle
// whose source file was deleted stays behind and keeps running. Measured: a deleted
// test reported a failure against a fixture that no longer existed.
if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })

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
})

// Run the bundles THIS build produced, by name, rather than whatever the directory
// happens to hold.
const bundles = entryPoints.map(entry => join(outDir, `${basename(entry, '.test.ts')}.test.test.mjs`))
execFileSync(process.execPath, ['--test', ...bundles], { stdio: 'inherit' })
