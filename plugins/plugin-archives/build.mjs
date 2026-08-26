#!/usr/bin/env node
/**
 * Builds the archives plugin's two halves:
 *   lib/index.js  — the host half (Node): archive list/delete API routes
 *     over the workspace registry's archive set. Bundled with @deepseek-ai/*
 *     and cordis EXTERNAL (they resolve from the profile's node_modules at
 *     load time), like the client half below.
 *   lib/client.js — the browser half (settings-page section), wrapped in the
 *     window.__ModuleLoader__.load({ id, factory }) closure the dsh web
 *     client loader expects (same shape as plugin-usage's build).
 *
 * Run from the dsh-app root (esbuild resolves out of dsh-app/node_modules):
 *   node plugins/plugin-archives/build.mjs
 */
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ID = '@dsh-app/plugin-archives'

/** Keep every framework import external: module-table entries only. */
const externalFramework = {
  name: 'external-framework',
  setup(b) {
    b.onResolve({ filter: /^@deepseek-ai\// }, (a) => ({ path: a.path, external: true }))
    b.onResolve({ filter: /^@cordisjs\// }, (a) => ({ path: a.path, external: true }))
    b.onResolve({ filter: /^react(\/|$)/ }, (a) => ({ path: a.path, external: true }))
    b.onResolve({ filter: /^react-dom(\/|$)/ }, (a) => ({ path: a.path, external: true }))
  },
}

// --- host half ---------------------------------------------------------------
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

// --- browser half ------------------------------------------------------------
await build({
  entryPoints: [join(here, 'src', 'client.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  plugins: [externalFramework],
  outfile: join(here, 'lib', 'client.js'),
  banner: {
    js: [
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      'var module = { exports: {} };',
      'var exports = module.exports;',
    ].join('\n'),
  },
  footer: { js: '\nreturn module.exports;\n} });' },
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
})

console.log(`built ${ID}: lib/index.js + lib/client.js`)
