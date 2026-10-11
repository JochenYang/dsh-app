#!/usr/bin/env node
// Builds the effort slider's two halves via the shared suite recipe.
//
// The host half is an empty `apply`: this is a pure UI plugin, and its loader
// row exists so the client-modules scan can see the package.json `dsh.client`
// declaration and serve lib/client.js.
//
// Run from the dsh-app root (esbuild resolves out of dsh-app/node_modules):
//   node plugins/plugin-effort/build.mjs
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDual } from '../build-lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))

await buildDual(here, '@dsh-app/plugin-effort')
