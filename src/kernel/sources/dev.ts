import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { KernelManifest } from '../../shared/types'

/**
 * Dev mode: the "kernel" is a local deepseek-harness checkout on disk.
 * No download, no artifact — the shell spawns `pnpm dsh web` inside it.
 */
export async function readDevManifest(checkoutDir: string, platform?: string, arch?: string): Promise<KernelManifest> {
  let pkg: { version?: string }
  try {
    const raw = await fs.readFile(path.join(checkoutDir, 'package.json'), 'utf8')
    pkg = JSON.parse(raw) as { version?: string }
  } catch {
    throw new Error(`开发模式内核目录无效：${checkoutDir} 下缺少可读的 package.json，请确认 DSH_APP_DEV_RUNTIME 指向 deepseek-harness 源码根目录`)
  }
  if (!pkg.version) throw new Error(`开发模式内核目录无效：${checkoutDir}/package.json 缺少 version 字段`)
  const suiteVersion = process.env.DSH_APP_SUITE_VERSION ?? '0.0.0-dev'
  return {
    dshVersion: pkg.version,
    suiteVersion,
    channel: 'stable',
    platform: platform ?? process.platform,
    arch: arch ?? process.arch,
    integrity: 'dev',
    publishedAt: new Date().toISOString(),
    source: 'dev',
  }
}
