import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { CurrentKernel, KernelManifest } from '../shared/types'
import { CURRENT_FILE } from '../shared/constants'

/** Read a JSON file; null when missing. A corrupt file is backed up then null. */
export async function readJson<T>(file: string): Promise<T | null> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (err) {
    // ENOENT is the ordinary "nothing installed yet". Anything else is a real
    // fault worth a log line — and it still answers null, because every caller
    // treats null as "install one" rather than as a reason to crash.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[kernel] cannot read ${file}: ${String(err)}`)
    }
    return null
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    const backup = `${file}.corrupt-${process.pid}-${Date.now()}.bak`
    await fs.rename(file, backup).catch(() => undefined)
    return null
  }
}

/** Atomically write a JSON file (random tmp + fsync + rename + dir fsync). */
export async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
    const handle = await fs.open(tmp, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(tmp, file)
    // Directory fsync makes the rename durable on POSIX, and must never fail
    // the call: the rename above already published the content, so throwing
    // here reports a completed write as a failure. Windows refuses to open a
    // directory for reading at all (EPERM) — which silently broke kernel
    // activation, because activateTarball's save threw right after its rename
    // and every field written after it (sha512, bundledStamp) never landed.
    try {
      const dir = await fs.open(path.dirname(file), 'r')
      try {
        await dir.sync()
      } finally {
        await dir.close()
      }
    } catch {
      // best effort: durability nicety, not a correctness requirement
    }
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

export async function loadCurrentKernel(root: string): Promise<CurrentKernel | null> {
  return readJson<CurrentKernel>(path.join(root, CURRENT_FILE))
}

export async function saveCurrentKernel(root: string, current: CurrentKernel): Promise<void> {
  await writeJson(path.join(root, CURRENT_FILE), current)
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

/** Read a KernelManifest from inside an extracted runtime directory. */
export async function readRuntimeManifest(runtimeDir: string): Promise<KernelManifest | null> {
  return readJson<KernelManifest>(path.join(runtimeDir, 'manifest.json'))
}
