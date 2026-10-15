#!/usr/bin/env node
// Builds the route probe's host-only fixture half (`src/index.js` → `lib/index.js`).
//
// Host-only on purpose: this package answers HTTP and registers a `webServer`
// route, so it has no browser half and needs no `__ModuleLoader__` wrapper — the
// suite's own `buildHostOnly` recipe is the same esbuild call. It is spelled out
// here rather than imported because the fixture's source is plain ESM with no
// framework imports to externalise.
//
// Run from the dsh-app root (esbuild resolves out of dsh-app/node_modules):
//   node scripts/fixtures/probe-routes/build.mjs
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
console.log('built @dsh-app/probe-routes: lib/index.js')
