#!/usr/bin/env node
/**
 * Copies the platform/arch-matching kernel tarball from runtime-dist/ into
 * bundled-kernel/ (as kernel.tgz + kernel.tgz.sha512) so electron-builder's
 * extraResources can ship it inside the installer.
 *
 * Usage:
 *   node scripts/prepare-bundled-kernel.mjs [platform] [arch]
 *
 * Defaults to the current process platform/arch (local packaging). CI passes
 * the target matrix platform/arch explicitly so an x64 runner can bundle an
 * arm64 kernel built in a separate runtime job.
 *
 * Run `npm run runtime:build` first to produce runtime-dist/.
 */
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const [platform = process.platform, arch = process.arch] = process.argv.slice(2)

const runtimeDist = path.join(root, 'runtime-dist')
const bundled = path.join(root, 'bundled-kernel')

async function main() {
  // Match dsh-runtime-<platform>-<arch>-<version>.tgz; version may contain
  // anything (rc.8, 0.1.0, …), so glob on the platform/arch prefix.
  const prefix = `dsh-runtime-${platform}-${arch}-`
  const files = await readdir(runtimeDist).catch(() => [])
  const tgz = files.find((f) => f.startsWith(prefix) && f.endsWith('.tgz'))
  if (!tgz) {
    console.error(`No kernel tarball found for ${platform}-${arch} in runtime-dist/.`)
    console.error(`Expected a file matching: ${prefix}*.tgz`)
    console.error('Run `npm run runtime:build` first.')
    process.exit(1)
  }
  const sha = `${tgz}.sha512`
  const shaExists = files.includes(sha)
  if (!shaExists) {
    console.error(`Missing sidecar ${sha} for ${tgz}.`)
    process.exit(1)
  }

  await rm(bundled, { recursive: true, force: true })
  await mkdir(bundled, { recursive: true })
  await copyFile(path.join(runtimeDist, tgz), path.join(bundled, 'kernel.tgz'))
  await copyFile(path.join(runtimeDist, sha), path.join(bundled, 'kernel.tgz.sha512'))

  console.log(`bundled kernel: ${tgz} -> bundled-kernel/kernel.tgz (+ .sha512)`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
