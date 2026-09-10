/**
 * The persisted store: `$DSH_HOME/storages/dsh-app-plugin-hooks/config.json`.
 * Same discipline as plugin-mcp: shell rewrites the overlay every start so
 * this file is the only durable truth; reads validate+degrade (invalid
 * entries kept aside and re-attached on save so hand-edits are never lost);
 * writes are atomic (tmp+rename). The absolute-configPath check lives here
 * (node:path; wire.ts stays browser-pure).
 *
 * @module @dsh-app/plugin-hooks/store
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { HooksValidationError, nextBridgeId, validateBridge, type HooksBridge, type HooksConfigFile } from './wire.ts'

export { HooksValidationError, nextBridgeId, validateBridge } from './wire.ts'

type Raw = Record<string, unknown>

function readRawFile(path: string, log: (m: string) => void): Raw | undefined {
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch { return undefined }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('expected object')
    return parsed as Raw
  } catch (error) {
    log(`hooks config: unreadable, starting empty: ${(error as Error).message}`)
    return undefined
  }
}

export class HooksStore {
  readonly filePath: string
  private invalidRaw: unknown[] = []

  constructor(dir: string, private readonly log: (m: string) => void) {
    this.filePath = `${dir}/config.json`
  }

  /** Managed-file path for an inline entry: `<storeDir>/hook-<n>.json`. */
  private managedPath(id: string): string {
    return join(dirname(this.filePath), `${id}.json`)
  }

  /** Read an inline entry's managed file into configContent (best-effort). */
  private readManagedContent(id: string): string | undefined {
    const p = this.managedPath(id)
    try { return readFileSync(p, 'utf8') } catch { return undefined }
  }

  /** Write/overwrite an inline entry's managed file. */
  private writeManagedContent(id: string, content: string): string {
    const p = this.managedPath(id)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content, 'utf8')
    return p
  }

  /** Delete an inline entry's managed file if it exists. */
  private deleteManagedContent(id: string): void {
    try { unlinkSync(this.managedPath(id)) } catch { /* best effort */ }
  }

  load(): HooksConfigFile {
    const raw = readRawFile(this.filePath, this.log)
    if (raw === undefined) return { version: 1, enabled: true, bridges: [] }
    this.invalidRaw = []
    const enabled = raw.enabled !== false
    const bridges: HooksBridge[] = []
    const seenIds = new Set<string>()
    if (Array.isArray(raw.bridges)) {
      for (const candidate of raw.bridges) {
        try {
          let bridge = validateBridge(candidate, seenIds)
          if (bridge.configSource === 'file') {
            if (!isAbsolute(bridge.configPath)) {
              throw new HooksValidationError(`configPath 必须是绝对路径：「${bridge.configPath}」`)
            }
          } else {
            // Inline: configPath is the managed file; fill it in if absent
            // and read the content back for display.
            const mp = this.managedPath(bridge.id)
            bridge = {
              ...bridge,
              configPath: bridge.configPath !== '' ? bridge.configPath : mp,
              configContent: this.readManagedContent(bridge.id),
            }
          }
          seenIds.add(bridge.id)
          bridges.push(bridge)
        } catch (error) {
          this.log(`hooks config: keeping an invalid entry aside: ${(error as Error).message}`)
          this.invalidRaw.push(candidate)
        }
      }
    }
    return { version: 1, enabled, bridges }
  }

  save(file: HooksConfigFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const merged = this.invalidRaw.length > 0
      ? { ...file, bridges: [...file.bridges, ...this.invalidRaw as HooksBridge[]] }
      : file
    const tmp = `${this.filePath}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
    renameSync(tmp, this.filePath)
  }

  create(raw: unknown): HooksBridge {
    const file = this.load()
    const id = nextBridgeId(file.bridges)
    let bridge = validateBridge({ ...(raw as Raw), id }, new Set(file.bridges.map(b => b.id)))
    if (bridge.configSource === 'inline') {
      if (bridge.configContent === undefined || bridge.configContent.trim() === '') {
        throw new HooksValidationError('在线编写模式下，配置内容不能为空')
      }
      this.writeManagedContent(id, bridge.configContent)
      bridge = { ...bridge, configPath: this.managedPath(id) }
    } else {
      if (!isAbsolute(bridge.configPath)) {
        throw new HooksValidationError(`configPath 必须是绝对路径：「${bridge.configPath}」`)
      }
    }
    // configContent lives in the managed file, not in config.json.
    const { configContent, ...persisted } = bridge
    void configContent
    this.save({ ...file, bridges: [...file.bridges, persisted as HooksBridge] })
    return bridge
  }

  update(id: string, raw: unknown): HooksBridge {
    const file = this.load()
    const oldBridge = file.bridges.find(b => b.id === id)
    if (oldBridge === undefined) throw new HooksValidationError(`Hook 配置 ${id} 不存在`)
    const otherIds = new Set(file.bridges.filter(b => b.id !== id).map(b => b.id))
    let bridge = validateBridge({ ...(raw as Raw), id }, otherIds)
    if (bridge.configSource === 'inline') {
      if (bridge.configContent === undefined || bridge.configContent.trim() === '') {
        throw new HooksValidationError('在线编写模式下，配置内容不能为空')
      }
      this.writeManagedContent(id, bridge.configContent)
      bridge = { ...bridge, configPath: this.managedPath(id) }
    } else {
      // Switching from inline to file: clean up the old managed file.
      if (oldBridge.configSource === 'inline') this.deleteManagedContent(id)
      if (!isAbsolute(bridge.configPath)) {
        throw new HooksValidationError(`configPath 必须是绝对路径：「${bridge.configPath}」`)
      }
    }
    const { configContent, ...persisted } = bridge
    void configContent
    this.save({ ...file, bridges: file.bridges.map(b => (b.id === id ? persisted as HooksBridge : b)) })
    return bridge
  }

  remove(id: string): void {
    const file = this.load()
    const bridge = file.bridges.find(b => b.id === id)
    if (bridge?.configSource === 'inline') this.deleteManagedContent(id)
    this.save({ ...file, bridges: file.bridges.filter(b => b.id !== id) })
  }
}
