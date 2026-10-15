#!/usr/bin/env node
// Builds the workbench probe fixture's two halves with the suite's own recipe,
// so the DOM the probe asserts against is the DOM a shipped plugin produces.
//
// Run from the dsh-app root (esbuild resolves out of dsh-app/node_modules):
//   node scripts/fixtures/probe-workbench/build.mjs
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDual } from '../../../plugins/build-lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))

await buildDual(here, '@dsh-app/probe-workbench')
