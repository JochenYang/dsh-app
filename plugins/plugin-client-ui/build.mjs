#!/usr/bin/env node
/**
 * Builds the brand client plugin's two halves:
 *   lib/client.js — the browser bundle, wrapped in the
 *     window.__ModuleLoader__.load({ id, factory }) closure the dsh web client
 *     loader expects. Every @deepseek-ai/* and react import stays EXTERNAL and
 *     resolves through the injected `require` (the loader module table); the
 *     bundle inlines only our own files + the plain CSS text.
 *   lib/index.js  — the no-op host loader entry (a dsh.client package still
 *     needs a resolvable node half).
 *
 * Run from the dsh-app root (esbuild resolves out of dsh-app/node_modules):
 *   node plugins/plugin-client-ui/build.mjs
 */
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ID = '@dsh-app/plugin-client-ui'

/**
 * Mark every framework/brand-package import external. The client bundle purity
 * rule means none of these may be inlined: they are module-table entries the
 * injected require answers at runtime. Bundling them would duplicate runtime
 * instances (cordis, react) or require a specifier the table cannot answer.
 */
const externalFramework = {
  name: 'external-framework',
  setup(b) {
    b.onResolve({ filter: /^@deepseek-ai\// }, (a) => ({ path: a.path, external: true }))
    b.onResolve({ filter: /^react(\/|$)/ }, (a) => ({ path: a.path, external: true }))
    b.onResolve({ filter: /^react-dom(\/|$)/ }, (a) => ({ path: a.path, external: true }))
  },
}

// --- browser client bundle ---------------------------------------------------
await build({
  entryPoints: [join(here, 'src', 'client.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  loader: { '.css': 'text' },
  plugins: [externalFramework],
  outfile: join(here, 'lib', 'client.js'),
  // Closure-factory handoff consumed by the vendored client module loader.
  banner: {
    js: [
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      'var module = { exports: {} };',
      'var exports = module.exports;',
    ].join('\n'),
  },
  footer: {
    js: '\nreturn module.exports;\n} });',
  },
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
})

// --- no-op host loader entry -------------------------------------------------
await build({
  entryPoints: [join(here, 'src', 'index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  plugins: [externalFramework],
  outfile: join(here, 'lib', 'index.js'),
  logLevel: 'warning',
})

console.log(`built ${ID}: lib/client.js + lib/index.js`)
