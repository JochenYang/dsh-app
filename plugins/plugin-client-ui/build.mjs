#!/usr/bin/env node
// Builds the brand client plugin's two halves (browser theme bundle + no-op
// host loader entry) via the shared suite recipe. Deltas from the default:
// the client bundle inlines plain CSS text, @cordisjs stays bundled (the
// client purity rule only externalizes @deepseek-ai/* + react), and the host
// entry targets es2022.
//
// Run from the dsh-app root (esbuild resolves out of dsh-app/node_modules):
//   node plugins/plugin-client-ui/build.mjs
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDual } from '../build-lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))

await buildDual(here, '@dsh-app/plugin-client-ui', { cordis: false, css: true, hostTarget: 'es2022' })
