import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { KernelChannel, KernelManifest, KernelSource } from '../shared/types'
import { t } from '../shared/locale'
import { LAYER_INDEX_FILE } from '../shared/constants'

/**
 * Layer index for a runtime split by scripts/split-runtime-layers.mjs.
 *
 * The layer NAME is the cache key and the key is chosen so the cache behaves:
 * node/vendor/meta are content-addressed (an identical rebuild keeps the name,
 * so a client reuses the file it already has) while dsh/suite are
 * version-addressed (the name changes exactly when the content should). This
 * module only reads and validates the index — assembly lives in manager.ts.
 *
 * Every message here is localized at throw time: these faults reach the user
 * through the splash's failure card, so they read as prose, not as diagnostics.
 * The `{at}` composition (one "layer index <file>, layer <n>" prefix reused by
 * the per-entry faults) keeps the zh wording of one prefix in one key.
 */
export const LAYER_KINDS = ['node', 'vendor', 'dsh', 'suite', 'meta'] as const
export type LayerKind = (typeof LAYER_KINDS)[number]

export interface KernelLayer {
  kind: LayerKind
  /** File name inside the layer directory AND inside the layer cache. */
  name: string
  /** sha512 hex of the layer tarball; verified before anything is assembled. */
  sha512: string
  bytes: number
  /** Archive paths the layer unpacks, e.g. `runtime/node`. */
  entries: string[]
}

/**
 * `layers.json`: the runtime manifest (the same fields a single tgz carries)
 * plus the per-layer index.
 */
export interface LayerIndex extends KernelManifest {
  layers: KernelLayer[]
}

const DECIMAL_SHA512 = /^[0-9a-f]{128}$/iu
const LAYER_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*\.tgz$/u

/**
 * Release asset name of the per-cell layer index. Six matrix cells each build
 * the same `layers.json`, so the published name has to carry the target — keep
 * in sync with the upload step in .github/workflows/release.yml.
 */
export function layerIndexAssetName(platform: string, arch: string): string {
  return `layers-${platform}-${arch}.json`
}

function text(value: unknown, field: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(t('kernel.layerIndex.fieldMissing', { label, field }))
  }
  return value
}

function requireLayer(value: unknown, position: number, label: string, seen: Set<string>): KernelLayer {
  const at = t('kernel.layerIndex.entryAt', { label, position: position + 1 })
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(t('kernel.layerIndex.notObject', { at }))
  }
  const raw = value as Record<string, unknown>
  if (typeof raw.kind !== 'string' || !(LAYER_KINDS as readonly string[]).includes(raw.kind)) {
    throw new Error(t('kernel.layerIndex.badKind', { at, kind: String(raw.kind) }))
  }
  const name = text(raw.name, 'name', label)
  // The name is joined onto the cache directory, so it must be a plain base
  // name of the expected container — not a path, and never `..`.
  if (!LAYER_NAME.test(name)) throw new Error(t('kernel.layerIndex.badName', { at, name }))
  if (seen.has(name)) throw new Error(t('kernel.layerIndex.duplicateName', { at, name }))
  seen.add(name)
  const sha512 = text(raw.sha512, 'sha512', label).toLowerCase()
  if (!DECIMAL_SHA512.test(sha512)) throw new Error(t('kernel.layerIndex.badSha512', { at }))
  if (typeof raw.bytes !== 'number' || !Number.isSafeInteger(raw.bytes) || raw.bytes <= 0) {
    throw new Error(t('kernel.layerIndex.badBytes', { at }))
  }
  if (!Array.isArray(raw.entries) || raw.entries.length === 0) {
    throw new Error(t('kernel.layerIndex.noEntries', { at }))
  }
  for (const entry of raw.entries) {
    if (typeof entry !== 'string' || entry.trim() === '' || path.isAbsolute(entry) || entry.split('/').includes('..')) {
      throw new Error(t('kernel.layerIndex.badEntryPath', { at, entry: String(entry) }))
    }
  }
  return {
    kind: raw.kind as LayerKind,
    name,
    sha512,
    bytes: raw.bytes,
    entries: raw.entries as string[],
  }
}

/**
 * Validate a parsed `layers.json`. Throws — never repairs or falls back —
 * because every consumer uses the index to decide WHAT to assemble and HOW to
 * verify it, so a silently accepted index would install unverified bytes.
 */
export function parseLayerIndex(value: unknown, label: string = LAYER_INDEX_FILE): LayerIndex {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(t('kernel.layerIndex.notJsonObject', { label }))
  }
  const raw = value as Record<string, unknown>
  const channel = text(raw.channel, 'channel', label)
  if (channel !== 'stable' && channel !== 'beta' && channel !== 'alpha') {
    throw new Error(t('kernel.layerIndex.badChannel', { label, channel }))
  }
  const source = text(raw.source, 'source', label)
  if (source !== 'dev' && source !== 'artifact') {
    throw new Error(t('kernel.layerIndex.badSource', { label, source }))
  }
  // `integrity` is empty in the producer's output by design: the per-layer
  // digests below are the integrity data for a split runtime.
  if (typeof raw.integrity !== 'string') {
    throw new Error(t('kernel.layerIndex.badIntegrity', { label }))
  }
  if (!Array.isArray(raw.layers) || raw.layers.length === 0) {
    throw new Error(t('kernel.layerIndex.noLayers', { label }))
  }
  const seen = new Set<string>()
  return {
    dshVersion: text(raw.dshVersion, 'dshVersion', label),
    suiteVersion: text(raw.suiteVersion, 'suiteVersion', label),
    channel: channel as KernelChannel,
    platform: text(raw.platform, 'platform', label),
    arch: text(raw.arch, 'arch', label),
    integrity: raw.integrity,
    source: source as KernelSource,
    layers: raw.layers.map((entry, position) => requireLayer(entry, position, label, seen)),
  }
}

/**
 * Read and validate the `layers.json` that sits beside the layer tarballs in
 * `layerDir`. Any read/parse/shape fault is fatal — the index is what decides
 * which files to verify, so it is never optional.
 */
export async function readLayerIndex(layerDir: string): Promise<LayerIndex> {
  const file = path.join(layerDir, LAYER_INDEX_FILE)
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (err) {
    throw new Error(t('kernel.layerIndex.unreadable', { label: file, detail: (err as Error).message }))
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(t('kernel.layerIndex.invalidJson', { label: file, detail: (err as Error).message }))
  }
  return parseLayerIndex(parsed, file)
}

/** Refuse an index built for another target before a single file is touched. */
export function assertLayerTarget(index: LayerIndex, platform: string, arch: string): void {
  if (index.platform !== platform || index.arch !== arch) {
    throw new Error(t('kernel.layerIndex.platformMismatch', {
      indexPlatform: index.platform,
      indexArch: index.arch,
      platform,
      arch,
    }))
  }
}

/**
 * Layers the cache cannot supply: the name is absent, or it is present with a
 * different digest (a half-copied or corrupted cache entry — repairable,
 * because the verified layer directory is authoritative for a given name).
 *
 * `cached` maps layer name -> sha512 of the bytes currently in the cache.
 */
export function missingLayers(index: LayerIndex, cached: ReadonlyMap<string, string>): KernelLayer[] {
  return index.layers.filter((layer) => cached.get(layer.name) !== layer.sha512)
}
