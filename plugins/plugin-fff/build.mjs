#!/usr/bin/env node
// Builds the fff plugin's host half (PickerManager + fffind/ffgrep/fff-glob
// tools) via the shared suite recipe. Host-only: no client half. @ff-labs/*
// stays EXTERNAL - fff-node loads its native C library through ffi-rs at
// RUNTIME (platform-selected optionalDependency binary), so inlining it
// would break binary resolution. The runtime dependency is declared in
// package.json (dependencies) and installed by build-runtime.mjs into the
// kernel's app/node_modules - keep both pins in sync.
//
// Run from the dsh-app root (esbuild resolves out of dsh-app/node_modules):
//   node plugins/plugin-fff/build.mjs
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildHostOnly } from '../build-lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))

await buildHostOnly(here, '@dsh-app/plugin-fff', { extra: [/^@ff-labs\//] })
