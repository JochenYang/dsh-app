#!/usr/bin/env node
/**
 * Bundles the node:test suites with esbuild (TS, type-only framework imports
 * stripped) into .test-dist/ and runs them with `node --test`.
 *
 * Run from anywhere:
 *   node plugins/plugin-swarm/scripts/test.mjs
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
  alias: {
    // Identity-brand stub — see stub-dsh-session.mjs.
    '@deepseek-ai/dsh-session': join(here, 'stub-dsh-session.mjs'),
  },
})

execFileSync(process.execPath, ['--test', ...readdirSync(outDir).filter(name => name.endsWith('.test.mjs')).map(name => join(outDir, name))], { stdio: 'inherit' })
