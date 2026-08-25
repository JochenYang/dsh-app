#!/usr/bin/env node
/**
 * Builds the swarm plugin's host half:
 *   lib/index.js — the host half (Node): the swarm tool, the /swarm command,
 *     and the batch orchestrator. Bundled with @deepseek-ai/* and cordis
 *     EXTERNAL (they resolve from the profile's node_modules at load time).
 *
 * Run from the dsh-app root (esbuild resolves out of dsh-app/node_modules):
 *   node plugins/plugin-swarm/build.mjs
 */
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ID = '@dsh-app/plugin-swarm'

/** Keep every framework import external: module-table entries only. */
const externalFramework = {
  name: 'external-framework',
  setup(b) {
    b.onResolve({ filter: /^@deepseek-ai\// }, (a) => ({ path: a.path, external: true }))
    b.onResolve({ filter: /^@cordisjs\// }, (a) => ({ path: a.path, external: true }))
  },
}

await build({
  entryPoints: [join(here, 'src', 'index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  plugins: [externalFramework],
  outfile: join(here, 'lib', 'index.js'),
  logLevel: 'warning',
})

console.log(`built ${ID}: lib/index.js`)
