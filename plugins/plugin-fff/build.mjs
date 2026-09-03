#!/usr/bin/env node
/**
 * Builds the fff plugin's host half:
 *   lib/index.js — the host half (Node): the PickerManager over
 *     @ff-labs/fff-node and the fffind/ffgrep/fff-glob LLM tools.
 *
 * Bundled with @deepseek-ai/* and cordis EXTERNAL (they resolve from the
 * profile's node_modules at load time), and — CRITICALLY — with @ff-labs/*
 * external too: fff-node loads its native C library through ffi-rs at RUNTIME
 * (platform-selected optionalDependency binary), so inlining it into the
 * bundle would break binary resolution. The runtime dependency is declared in
 * package.json (dependencies) and installed by build-runtime.mjs into the
 * kernel's app/node_modules — keep both pins in sync (see build-runtime.mjs
 * `appPkg.dependencies`).
 *
 * Run from the dsh-app root (esbuild resolves out of dsh-app/node_modules):
 *   node plugins/plugin-fff/build.mjs
 */
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ID = '@dsh-app/plugin-fff'

/** Keep every framework import and the native-backed fff runtime external. */
const externalFramework = {
  name: 'external-framework',
  setup(b) {
    b.onResolve({ filter: /^@deepseek-ai\// }, (a) => ({ path: a.path, external: true }))
    b.onResolve({ filter: /^@cordisjs\// }, (a) => ({ path: a.path, external: true }))
    b.onResolve({ filter: /^@ff-labs\// }, (a) => ({ path: a.path, external: true }))
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