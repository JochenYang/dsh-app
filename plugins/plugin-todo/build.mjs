#!/usr/bin/env node
// Builds the todo plugin's two halves (host storage/routes/tools + browser
// workbench card and view) via the shared suite recipe.
//
// Run from the dsh-app root (esbuild resolves out of dsh-app/node_modules):
//   node plugins/plugin-todo/build.mjs
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDual } from '../build-lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))

// `svg: true` inlines src/assets/*.svg as data URLs, so the illustrations travel
// inside the client bundle and the plugin ships no runtime asset directory.
await buildDual(here, '@dsh-app/plugin-todo', { svg: true })
