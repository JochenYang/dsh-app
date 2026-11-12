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
  constructor(private readonly fleet: McpFleetLike | undefined) {}

  /** Whether a manager is mounted at all; false degrades the page to read-only. */
  get available(): boolean {
    return this.fleet !== undefined
  }

  /**
   * The state of one configured entry.
   *
   * A server the manager does not list at all (removed a moment ago, or a
   * composition that mounted no manager) answers `starting` while the manager
   * exists: it is about to be mounted, or it was just removed.
   */
  statusFor(entry: McpServerEntry): McpMountStatus {
    if (this.fleet === undefined) return { state: 'unavailable' }
    // An entry this version cannot parse may still be mounted by the manager,
    // so its status is reported before the disabled check: the page must not
    // say "disabled" about a server whose tools are live.
    if (entry.invalid !== undefined) return { state: 'error', message: entry.invalid }
    if (!entry.enabled) return { state: 'disabled' }
    const view = this.fleet.list().find((candidate) => candidate.name === entry.serverName)
    if (view === undefined) return { state: 'starting' }
    return toMountStatus(view.status)
  }
}
