/**
 * Native view-tab entry points (conversation.view registrants — the same
 * ring that renders 对话/审查/轨迹).
 *
 * The registration shape mirrors ui-trajectory (the official template):
 * thunk label + per-session inject face. Session facts (cwd) resolve through
 * `sessions.binding(sessionId)` — the same API the official trajectory view
 * uses — with the list store as fallback before the binding resolves.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { FileTreeTab } from './file-tree.tsx'
import { GitTab } from './git-tab.tsx'

/** Narrowed sessions service face (list store + binding both exist upstream). */
interface SessionsService {
  list: {
    getSnapshot(): { byId?: Readonly<Record<string, { cwd?: unknown }>> }
  }
  binding?(id: SessionId): { session?: { getSnapshot?: () => unknown } } | undefined
}

/** Resolve cwd for one session (official binding API, list store fallback). */
function cwdFor(sessions: SessionsService, sessionId: SessionId): string | undefined {
  const bound = sessions.binding?.(sessionId)?.session
  const snap = bound?.getSnapshot?.()
  if (typeof snap === 'object' && snap !== null) {
    const cwdField = (snap as { cwd?: unknown }).cwd
    if (typeof cwdField === 'string' && cwdField !== '') return cwdField
  }
  const summary = sessions.list.getSnapshot().byId?.[sessionId]
  return typeof summary?.cwd === 'string' && summary.cwd !== '' ? summary.cwd : undefined
}

/** Register our two views into the native view-tab ring. Order 100/110 keeps
 * them AFTER every official view (official rows order at 10). */
export function registerDockViews(ctx: ClientContext, _api: IApiClient): void {
  const sessions = ctx.get('sessions') as unknown as SessionsService
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'files',
    order: 100,
    label: () => '文件',
    inject: (sessionId: SessionId) => ({ sessionId, cwd: cwdFor(sessions, sessionId) }),
  }, FileTreeTab))
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'git',
    order: 110,
    label: () => 'Git',
    inject: (sessionId: SessionId) => ({ sessionId, cwd: cwdFor(sessions, sessionId) }),
  }, GitTab))
}
