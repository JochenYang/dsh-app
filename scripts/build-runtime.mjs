#!/usr/bin/env node
/**
 * Builds a dsh kernel runtime artifact (CI + local).
 *
 * Usage:
 *   node scripts/build-runtime.mjs <platform> <arch> [version]
 *
 * Example:
 *   node scripts/build-runtime.mjs win32 x64 0.1.0-rc.7
 *
 * Produces, under runtime-dist/:
 *   runtime/manifest.json
 *   runtime/node/            — the Node.js binary (copied from this process)
 *   runtime/app/             — npm-installed dsh profile (package.json + node_modules)
 *   dsh-runtime-<platform>-<arch>-<version>.tgz
 *   dsh-runtime-<platform>-<arch>-<version>.tgz.sha512
 *
 * The suite plugins (@dsh-app/plugin-*) join the runtime via file: references
 * in app/package.json; switch to registry versions once they are published.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { c as createTar } from 'tar'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const [platform = process.platform, arch = process.arch, versionArg] = process.argv.slice(2)

const DSH_VERSION = versionArg ?? process.env.DSH_VERSION ?? '0.1.0-rc.7'
const SUITE_VERSION = process.env.DSH_APP_SUITE_VERSION ?? '0.1.0'
const CHANNEL = process.env.DSH_APP_CHANNEL ?? 'stable'

const suitePlugins = ['@dsh-app/plugin-brand', '@dsh-app/plugin-client-ui']

function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(' ')}`)
  execFileSync(cmd, args, { cwd, stdio: 'inherit' })
}

async function main() {
  const work = path.join(root, 'runtime-dist', 'work')
  const runtimeDir = path.join(work, 'runtime')
  await rm(work, { recursive: true, force: true })
  await mkdir(path.join(runtimeDir, 'node'), { recursive: true })
  await mkdir(path.join(runtimeDir, 'app'), { recursive: true })

  // 1. Node.js binary for the target platform (from the CI runner's own node).
  const nodeBin = process.platform === 'win32' ? 'node.exe' : 'node'
  await cp(process.execPath, path.join(runtimeDir, 'node', nodeBin))
  if (process.platform !== 'win32') {
    // mac/linux node binary needs exec permission preserved.
    execFileSync('chmod', ['+x', path.join(runtimeDir, 'node', nodeBin)])
  }

  // 2. npm-installed dsh profile. The suite plugins are added via file: refs
  //    so npm installs them into the same flattened tree. Their lib/ outputs
  //    are build artifacts (not committed), so build each plugin first.
  for (const name of suitePlugins) {
    run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], path.join(root, 'plugins', name.replace('@dsh-app/', '')))
  }
  const appPkg = {
    name: 'dsh-app-runtime',
    private: true,
    version: DSH_VERSION,
    dependencies: {
      '@deepseek-ai/dsh': DSH_VERSION,
      ...Object.fromEntries(
        suitePlugins.map((name) => [name, `file:../../plugins/${name.replace('@dsh-app/', '')}`]),
      ),
    },
  }
  await writeFile(path.join(runtimeDir, 'app', 'package.json'), JSON.stringify(appPkg, null, 2))
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--legacy-peer-deps'], path.join(runtimeDir, 'app'))

  // 3. Runtime manifest.
  const tgzName = `dsh-runtime-${platform}-${arch}-${DSH_VERSION}.tgz`
  const manifest = {
    dshVersion: DSH_VERSION,
    suiteVersion: SUITE_VERSION,
    channel: CHANNEL,
    platform,
    arch,
    integrity: '', // filled after tarring
    publishedAt: new Date().toISOString(),
    source: 'artifact',
  }

  // 4. Tar the runtime directory (single top-level dir: runtime/).
  const tgzPath = path.join(root, 'runtime-dist', tgzName)
  await createTar({ gzip: true, file: tgzPath, cwd: work }, ['runtime'])

  // 5. sha512 of the tarball goes into the manifest AND a sidecar asset.
  const hash = createHash('sha512')
  await new Promise((resolve, reject) => {
    const stream = createReadStream(tgzPath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', resolve)
    stream.on('error', reject)
  })
  const sha512 = hash.digest('hex')
  await writeFile(`${tgzPath}.sha512`, `${sha512}\n`)

  manifest.integrity = sha512
  await writeFile(path.join(runtimeDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  await rm(path.join(runtimeDir, 'app', 'node_modules', '.package-lock.json'), { force: true })

  // 6. Keep a copy of the manifest next to the tarball for the artifact resolver.
  await cp(path.join(runtimeDir, 'manifest.json'), path.join(root, 'runtime-dist', 'manifest.json'))

  console.log(`\nRuntime artifact ready: ${tgzPath}`)
  console.log(`sha512: ${sha512}`)
  await rm(work, { recursive: true, force: true })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
