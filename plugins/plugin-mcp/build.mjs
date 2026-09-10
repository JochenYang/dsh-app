#!/usr/bin/env node
// Builds the MCP manager plugin's two halves (host store/mount manager +
// browser settings section) via the shared suite recipe.
//
// Run from the dsh-app root (esbuild resolves out of dsh-app/node_modules):
//   node plugins/plugin-mcp/build.mjs
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDual } from '../build-lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))

await buildDual(here, '@dsh-app/plugin-mcp')
