#!/usr/bin/env node
// Builds the rewind plugin's two halves (host command + projection, browser
// composer button and transcript hiding) via the shared suite recipe.
//
// `zod` is marked external: the projection schema type the kernel's own
// `dsh-session-projection` service declares IS zod, and that service resolves
// its own copy at load time. Bundling a second copy would ship ~750 KB of a
// library the framework already owns, and two zod instances would make the
// schema objects foreign to the registry.
//
// Run from the dsh-app root (esbuild resolves out of dsh-app/node_modules):
//   node plugins/plugin-rewind/build.mjs
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDual } from '../build-lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))

await buildDual(here, '@dsh-app/plugin-rewind', { extra: [/^zod(\/|$)/] })
