#!/usr/bin/env node
// Builds the sidebar dock plugin's two halves (host fs routes + browser
// dock UI) via the shared suite recipe in plugins/build-lib.mjs.
//
// Run from the dsh-app root (esbuild resolves out of dsh-app/node_modules):
//   node plugins/plugin-sidebar/build.mjs
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDual } from '../build-lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))

await buildDual(here, '@dsh-app/plugin-sidebar')
