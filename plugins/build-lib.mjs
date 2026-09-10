#!/usr/bin/env node
// Shared esbuild recipe for the brand suite plugins (@dsh-app/*).
//
// Every dual-face plugin bundles the same two halves:
//   lib/index.js  - the host half (Node), bundled with the framework
//                   imports EXTERNAL (they resolve from the profile's
//                   node_modules at load time).
//   lib/client.js - the browser half, wrapped in the
//                   window.__ModuleLoader__.load({ id, factory }) closure
//                   the dsh web client loader expects.
//
// Per-plugin build.mjs files are thin wrappers around buildDual /
// buildHostOnly below; only the plugin id and the small option deltas
// (css bundling, cordis externality, extra externals, host target)
// live in the wrapper.
//
// Run from the dsh-app root (esbuild resolves out of dsh-app/node_modules):
//   node plugins/plugin-<name>/build.mjs
import { build } from 'esbuild'
import { join } from 'node:path'

// esbuild plugin marking every framework import external: the composed
// loader's module table answers these specifiers at runtime, so inlining
// them would duplicate runtime instances (cordis, react) or require a
// specifier the table cannot answer.
export function externalFramework(extraFilters = [], withCordis = true) {
  return {
    name: 'external-framework',
    setup(b) {
      b.onResolve({ filter: /^@deepseek-ai\// }, (a) => ({ path: a.path, external: true }))
      if (withCordis) {
        b.onResolve({ filter: /^@cordisjs\// }, (a) => ({ path: a.path, external: true }))
      }
      b.onResolve({ filter: /^react(\/|$)/ }, (a) => ({ path: a.path, external: true }))
      b.onResolve({ filter: /^react-dom(\/|$)/ }, (a) => ({ path: a.path, external: true }))
      for (const filter of extraFilters) {
        b.onResolve({ filter }, (a) => ({ path: a.path, external: true }))
      }
    },
  }
}

// Closure-factory handoff consumed by the vendored client module loader.
function clientBanner(id) {
  return {
    js: [
      'window.__ModuleLoader__.load({ id: ' + JSON.stringify(id) + ', factory: (require) => {',
      'var module = { exports: {} };',
      'var exports = module.exports;',
    ].join('\n'),
  }
}

// Bundle the host half (src/index.ts) into lib/index.js.
export async function buildHost(here, options = {}) {
  const { target = 'node20', external = externalFramework() } = options
  await build({
    entryPoints: [join(here, 'src', 'index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target,
    plugins: [external],
    outfile: join(here, 'lib', 'index.js'),
    logLevel: 'warning',
  })
}

// Bundle the browser half (src/client.ts) into lib/client.js.
export async function buildClient(here, id, options = {}) {
  const { css = false, external = externalFramework() } = options
  await build({
    entryPoints: [join(here, 'src', 'client.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    ...(css ? { loader: { '.css': 'text' } } : {}),
    plugins: [external],
    outfile: join(here, 'lib', 'client.js'),
    banner: clientBanner(id),
    footer: { js: '\nreturn module.exports;\n} });' },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  })
}

// Standard dual-face plugin: host half + browser half.
// Options: { cordis, css, extra, hostTarget } - see externalFramework.
export async function buildDual(here, id, options = {}) {
  const { cordis = true, css = false, extra = [], hostTarget = 'node20' } = options
  const external = externalFramework(extra, cordis)
  await buildHost(here, { target: hostTarget, external })
  await buildClient(here, id, { css, external })
  console.log('built ' + id + ': lib/index.js + lib/client.js')
}

// Host-only plugin (no client half, e.g. plugin-fff).
export async function buildHostOnly(here, id, options = {}) {
  const { extra = [], hostTarget = 'node20' } = options
  await buildHost(here, { target: hostTarget, external: externalFramework(extra) })
  console.log('built ' + id + ': lib/index.js')
}
