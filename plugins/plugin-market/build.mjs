#!/usr/bin/env node
// Builds the plugin market plugin's two halves (host catalog/install routes +
// browser market panel) via the shared suite recipe.
//
// The host half needs `require.resolve` to locate the kernel CLI package at
// runtime; that handoff is written in-source (createRequire over
// import.meta.url in src/npm.ts), so no post-build banner patch is required.
//
// Run from the dsh-app root (esbuild resolves out of dsh-app/node_modules):
//   node plugins/plugin-market/build.mjs
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDual } from '../build-lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))

await buildDual(here, '@dsh-app/plugin-market')
