#!/usr/bin/env node
/**
 * Bundles the node:test suites with esbuild (TS, type-only framework imports
 * stripped) into .test-dist/ and runs them with `node --test`.
 *
 * Run from anywhere:
 *   node plugins/plugin-codegraph/scripts/test.mjs
 * or inside the plugin:
 *   npm test
 */
import { buildSync } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const testsDir = join(pluginRoot, 'tests')
const outDir = join(pluginRoot, '.test-dist')

const suites = readdirSync(testsDir).filter(name => name.endsWith('.test.ts'))
const entryPoints = suites.map(name => join(testsDir, name))

buildSync({
  entryPoints,
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: outDir,
  outExtension: { '.js': '.test.mjs' },
  logLevel: 'error',
})

// Run the files these entry points PRODUCED, not every match in the output
// directory. esbuild never removes an output whose source is gone, so a suite
// deleted from `tests/` used to keep executing on every later run — measured:
// three `zz-*` scratch suites left their bundles behind and printed their own
// debug lines into a green result long after the sources were gone.
const outputs = suites.map(name => join(outDir, `${basename(name, '.ts')}.test.mjs`))
execFileSync(process.execPath, ['--test', ...outputs], { stdio: 'inherit' })
