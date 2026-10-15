#!/usr/bin/env node
// Builds the route probe's inject-gated fixture half (`src/index.js` → `lib/index.js`).
//
// Host-only, same recipe and the same reason as its sibling
// `scripts/fixtures/probe-routes/build.mjs`: one marker route, no browser half.
//
// Run from the dsh-app root (esbuild resolves out of dsh-app/node_modules):
//   node scripts/fixtures/probe-wsinject/build.mjs
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

await build({
  entryPoints: [join(here, 'src', 'index.js')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: join(here, 'lib', 'index.js'),
  logLevel: 'warning',
})
console.log('built @dsh-app/probe-wsinject: lib/index.js')
