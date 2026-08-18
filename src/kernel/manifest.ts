import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CurrentKernel, KernelManifest } from '../shared/types'
import { CURRENT_FILE } from '../shared/constants'

/** Read a JSON file; return null when missing or unparsable. */
export async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** Atomically write a JSON file (tmp + rename). */
export async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(tmp, file)
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
