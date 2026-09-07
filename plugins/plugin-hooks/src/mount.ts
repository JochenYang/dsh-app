/**
 * Dynamic mount manager for hooks bridges — same pattern as plugin-mcp's
 * mount but simpler (no tool counting, no env resolution). One loader entry
 * per enabled bridge; per-entry promise chains serialize mutations; the
 * profile root the loader writes back to is reset by the harness each boot
 * (process-scoped entries), so config.json stays the only durable truth.
 *
 * @module @dsh-app/plugin-hooks/mount
 */

import type { HooksMountStatus, HooksBridge } from './wire.ts'
import { KERNEL_PLUGIN, toBridgeConfig } from './wire.ts'

const MAX_ERROR_CHARS = 200

interface LoaderLike {
  create(options: { name: string, config?: unknown }): Promise<string>
  remove(id: string): Promise<void>
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}…` : message
}

interface MountRecord {
  loaderId?: string
  configKey?: string
  error?: string
}

export class HooksMountManager {
  private readonly records = new Map<string, MountRecord>()
  private readonly chains = new Map<string, Promise<void>>()

  constructor(
    private readonly log: (m: string) => void,
    loader: unknown,
  ) {
    this.loader = typeof loader === 'object' && loader !== null && typeof (loader as LoaderLike).create === 'function'
      ? loader as LoaderLike
      : undefined
  }

  private readonly loader: LoaderLike | undefined

  get available(): boolean { return this.loader !== undefined }

  private enqueue(id: string, op: () => Promise<void>): Promise<void> {
    const next = (this.chains.get(id) ?? Promise.resolve()).catch(() => undefined).then(op)
    this.chains.set(id, next)
    return next
  }

  async syncAll(bridges: readonly HooksBridge[]): Promise<void> {
    if (this.loader === undefined) return
    const desired = new Set(bridges.map(b => b.id))
    for (const id of [...this.records.keys()]) {
      if (!desired.has(id)) await this.unmount(id)
    }
    for (const b of bridges) {
      if (b.enabled && !this.records.has(b.id)) this.records.set(b.id, {})
    }
    await Promise.all(bridges.map(b => this.enqueue(b.id, () => this.syncOneNow(b))))
  }

  private async syncOneNow(bridge: HooksBridge): Promise<void> {
    // Native entries are handled by the NativeHookRuntime, never mounted as
    // kernel bridges; if one slips through, unmount and skip.
    if (bridge.dialect === 'native' || !bridge.enabled || this.loader === undefined) {
      await this.unmountNow(bridge.id)
      return
    }
    const record = this.records.get(bridge.id) ?? {}
    const config = toBridgeConfig(bridge)
    const configKey = JSON.stringify(config)
    if (record.loaderId !== undefined && record.configKey === configKey && record.error === undefined) return
    try {
      if (record.loaderId !== undefined) {
        await this.loader.remove(record.loaderId).catch(() => undefined)
        record.loaderId = undefined
      }
      const loaderId = await this.loader.create({ name: KERNEL_PLUGIN[bridge.dialect], config })
      record.loaderId = loaderId
      record.configKey = configKey
      record.error = undefined
      this.log(`hooks mount: ${bridge.dialect} (${bridge.configPath}) mounted (${loaderId})`)
    } catch (error) {
      record.loaderId = undefined
      record.configKey = undefined
      record.error = describeError(error)
      this.log(`hooks mount: ${bridge.dialect} (${bridge.configPath}) failed: ${record.error}`)
    }
    this.records.set(bridge.id, { ...record })
  }

  syncOne(bridge: HooksBridge): Promise<void> {
    return this.enqueue(bridge.id, () => this.syncOneNow(bridge))
  }

  async unmount(id: string): Promise<void> {
    return this.enqueue(id, () => this.unmountNow(id))
  }

  private async unmountNow(id: string): Promise<void> {
    const record = this.records.get(id)
    if (record?.loaderId !== undefined && this.loader !== undefined) {
      try { await this.loader.remove(record.loaderId) } catch (error) { this.log(`hooks unmount ${id}: ${describeError(error)}`) }
    }
    this.records.delete(id)
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.records.keys()].map(id => this.unmount(id)))
  }

  statusFor(bridge: HooksBridge): HooksMountStatus {
    if (!bridge.enabled) return { state: 'disabled' }
    if (this.loader === undefined) return { state: 'unavailable', message: '当前内核不支持动态挂载，Hooks 功能不可用' }
    const record = this.records.get(bridge.id)
    if (record === undefined) return { state: 'starting' }
    if (record.error !== undefined) return { state: 'error', message: record.error }
    if (record.loaderId === undefined) return { state: 'starting' }
    return { state: 'mounted' }
  }
}
