import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { KernelManifest } from '../../shared/types'

export interface DevSourceResult {
  dshVersion: string
  suiteVersion: string
}

/**
 * Dev mode: the "kernel" is a local deepseek-harness checkout on disk.
 * No download, no artifact — the shell spawns `pnpm dsh web` inside it.
 */
export async function readDevManifest(checkoutDir: string): Promise<KernelManifest> {
  const pkg = await fs
    .readFile(path.join(checkoutDir, 'package.json'), 'utf8')
    .then((raw) => JSON.parse(raw) as { version?: string })
    .catch(() => ({}) as { version?: string })

  const suiteVersion = process.env.DSH_APP_SUITE_VERSION ?? '0.0.0-dev'
  return {
    dshVersion: pkg.version ?? '0.0.0-dev',
    suiteVersion,
    channel: 'stable',
    platform: process.platform,
    arch: process.arch,
    integrity: 'dev',
    publishedAt: new Date().toISOString(),
    source: 'dev',
  }
}
