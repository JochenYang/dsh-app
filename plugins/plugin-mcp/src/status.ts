/**
 * Fleet status, read from the kernel's MCP manager.
 *
 * 0.2.2-rc.2's `@deepseek-ai/dsh-mcp-manager` mounts and supervises one
 * `dsh-mcp-client` per configured server; this plugin no longer mounts
 * anything, so the page's per-entry state comes from the manager's own view
 * (`ctx.mcpManager.list()`) instead of a loader entry this plugin created.
 *
 * The mapping is deliberately lossy in one direction only: a state this version
 * does not recognise reads as `starting` rather than as `mounted`, so an
 * unknown new state can never claim that tools are available.
 *
 * @module @dsh-app/plugin-mcp/status
 */

import type { HostText, McpMountStatus, McpServerEntry } from './wire.ts'

/** The reference syntax this line resolves; `$ENV:` is the retired one. */
const CREDENTIAL_REFERENCE = /\$\{credential:([A-Za-z_][A-Za-z0-9_]*)\}/
/** The retired reference syntax: stored values may still carry it. */
const LEGACY_REFERENCE = /^\$ENV:([A-Za-z_][A-Za-z0-9_]*)$/

/**
 * Warnings for values the manager will not resolve.
 *
 * `$ENV:NAME` was this plugin's own syntax before the fleet moved to the kernel
 * manager, which resolves `${credential:NAME}`. A stored `$ENV:` value is now a
 * literal handed to the child, so the page has to say so — otherwise the card
 * reads "mounted" while the server cannot authenticate, which is exactly the
 * silent failure this warning channel exists for.
 *
 * @param entry - the configured entry.
 * @returns one coded warning per un-resolvable value found.
 */
function referenceWarnings(entry: McpServerEntry): readonly HostText[] {
  const found: HostText[] = []
  for (const field of ['env', 'headers'] as const) {
    for (const [key, value] of Object.entries(entry[field] ?? {})) {
      if (LEGACY_REFERENCE.test(value)) {
        found.push({ code: 'env.legacyRef', params: { field: `${field}.${key}`, name: value.slice(5) } })
      } else if (value.includes('${credential:') && !CREDENTIAL_REFERENCE.test(value)) {
        found.push({ code: 'env.inlineRef', params: { value: value.slice(0, 40) } })
      }
    }
  }
  return found
}

/** One managed server as the manager lists it. */
export interface ManagedServerView {
  readonly name: string
  readonly configured: boolean
  readonly status: unknown
}

/** Structural slice of the manager (`ctx.mcpManager`). */
export interface McpFleetLike {
  list(): readonly ManagedServerView[]
}

/** The manager's states this plugin maps; anything else reads as `starting`. */
type FleetState = {
  readonly state?: unknown
  readonly toolCount?: unknown
  readonly lastError?: unknown
  readonly attempt?: unknown
  readonly reason?: unknown
  readonly result?: unknown
}

function asState(value: unknown): FleetState {
  return typeof value === 'object' && value !== null ? value as FleetState : {}
}

/**
 * Translate one managed server's status into the page's terms.
 *
 * `waiting-credentials` is the one state the page can act on, so it carries a
 * code the client renders as "this server needs a credential" rather than as a
 * generic failure; a load or cleanup failure carries the manager's own English
 * diagnostic as `text`, which is the only prose that crosses this boundary
 * because it belongs to a third party.
 */
function toMountStatus(status: unknown): McpMountStatus {
  const state = asState(status)
  switch (state.state) {
    case 'connected':
      return typeof state.toolCount === 'number'
        ? { state: 'mounted', toolCount: state.toolCount }
        : { state: 'mounted' }
    case 'disabled':
      return { state: 'disabled' }
    case 'waiting-credentials':
      return {
        state: 'error',
        message: { code: 'mount.needsCredentials', ...(typeof state.lastError === 'string' ? { text: state.lastError } : {}) },
      }
    case 'failed':
      return {
        state: 'error',
        message: {
          code: 'mount.failed',
          params: { reason: typeof state.reason === 'string' ? state.reason : 'load' },
          ...(typeof state.lastError === 'string' ? { text: state.lastError } : {}),
        } as HostText,
      }
    case 'closed':
      return {
        state: 'error',
        message: {
          code: 'mount.closed',
          ...(typeof asState(state.result).reason === 'string' ? { text: String(asState(state.result).reason) } : {}),
        },
      }
    // `connecting`, `reconnecting`, and any state a newer line adds: the server
    // is not serving tools yet, and saying "starting" is the honest answer.
    default:
      return { state: 'starting' }
  }
}

/** Per-entry status over the kernel manager's live view. */
export class McpFleetStatus {
  /**
   * @param fleetOf - resolves the manager per call; it may be mounted after this
   *   plugin activates, or replaced on a reload.
   */
  constructor(private readonly fleetOf: () => McpFleetLike | undefined) {}

  /** Whether a manager is mounted at all; false degrades the page to read-only. */
  get available(): boolean {
    return this.fleetOf() !== undefined
  }

  /**
   * The manager's view, read once.
   *
   * The page asks for one state per entry, so reading `list()` inside
   * {@link statusFor} made a page read O(n²) — invisible at five servers,
   * visible at two hundred.
   *
   * @returns a lookup over the current fleet; empty when no manager is mounted.
   */
  snapshot(): (entry: McpServerEntry) => McpMountStatus {
    const fleet = this.fleetOf()
    if (fleet === undefined) return () => ({ state: 'unavailable' })
    let views: Map<string, ManagedServerView>
    try {
      views = new Map(fleet.list().map((view) => [view.name, view]))
    } catch {
      // A disposed manager must degrade the page, not throw out of the route.
      return () => ({ state: 'unavailable' })
    }
    return (entry) => {
      // An entry this version cannot parse may still be mounted by the manager,
      // so its status is reported before the disabled check: the page must not
      // say "disabled" about a server whose tools are live.
      if (entry.invalid !== undefined) return { state: 'error', message: entry.invalid }
      if (!entry.enabled) return { state: 'disabled' }
      const view = views.get(entry.serverName)
      if (view === undefined) return { state: 'starting' }
      // `configured: false` is a runtime record the manager kept for a key that
      // is no longer in the row (a removal whose cleanup did not finish): the
      // page must not present it as an ordinary configured server.
      if (!view.configured) return { state: 'error', message: { code: 'mount.retained' } }
      const status = toMountStatus(view.status)
      const warnings = referenceWarnings(entry)
      // A mounted server whose credentials cannot resolve is not healthy: keep
      // the manager's state, attach what makes it fail.
      return warnings.length === 0 ? status : { ...status, warnings }
    }
  }

  /**
   * The state of one configured entry (single-shot; prefer {@link snapshot}
   * when reading a whole page).
   *
   * @param entry - the configured entry.
   * @returns its state as the page shows it.
   */
  statusFor(entry: McpServerEntry): McpMountStatus {
    return this.snapshot()(entry)
  }
}
