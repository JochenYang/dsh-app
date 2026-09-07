#!/usr/bin/env node
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const ID = '@dsh-app/plugin-hooks'
const externalFramework = { name: 'external-framework', setup(b) {
  b.onResolve({ filter: /^@deepseek-ai\// }, a => ({ path: a.path, external: true }))
  b.onResolve({ filter: /^@cordisjs\// }, a => ({ path: a.path, external: true }))
  b.onResolve({ filter: /^react(\/|$)/ }, a => ({ path: a.path, external: true }))
  b.onResolve({ filter: /^react-dom(\/|$)/ }, a => ({ path: a.path, external: true }))
}}
await build({ entryPoints: [join(here, 'src', 'index.ts')], bundle: true, format: 'esm', platform: 'node', target: 'node20', plugins: [externalFramework], outfile: join(here, 'lib', 'index.js'), logLevel: 'warning' })
await build({ entryPoints: [join(here, 'src', 'client.ts')], bundle: true, format: 'cjs', platform: 'browser', target: 'es2022', jsx: 'automatic', plugins: [externalFramework], outfile: join(here, 'lib', 'client.js'), banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {\nvar module = { exports: {} };\nvar exports = module.exports;` }, footer: { js: '\nreturn module.exports;\n} });' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning' })
console.log(`built ${ID}: lib/index.js + lib/client.js`)
