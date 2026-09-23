/**
 * Native view-tab entry points (conversation.view registrants — the same
 * ring that renders 对话/审查/轨迹).
 *
 * The registration shape mirrors ui-trajectory (the official template):
 * thunk label + per-session inject face.
 *
 * Session facts (cwd) resolve through the session LIST row —
 * `sessions.list.getSnapshot().byId[sessionId]?.cwd` — which is the only
 * accessor upstream itself uses for this (`ui-chat/src/client/ChatView.tsx:104`,
 * `ui-conversation/src/client/skeleton/ConversationContent.tsx:34`,
 * `ui-deliverables/src/client/Deliverables.tsx:76`). The session-scoped client
 * `SessionSnapshot` carries no `cwd`, so the earlier
 * `sessions.binding(id).session.getSnapshot().cwd` branch read a field that
 * does not exist on that contract; it never resolved and is gone.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the session-scoped SlotMap merges — `SessionStandardProps`
// declares `sessionId: SessionId` for every session-scope `inject` face, and
// ui-conversation declares the 'conversation.view' SlotMap row.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { GitTab } from './git-tab.tsx'
import { NS as SIDEBAR_NS } from './locales.ts'

/** Narrowed sessions service face (the list store carries the cwd column). */
interface SessionsService {
  list: {
    getSnapshot(): { byId?: Readonly<Record<string, { cwd?: unknown }>> }
  }
}

/** Resolve cwd for one session from its list row (upstream's own accessor). */
function cwdFor(sessions: SessionsService, sessionId: SessionId): string | undefined {
  const summary = sessions.list.getSnapshot().byId?.[sessionId]
  return typeof summary?.cwd === 'string' && summary.cwd !== '' ? summary.cwd : undefined
}

/** Register our view into the native view-tab ring. Order 110 keeps it
 * AFTER every official view (official rows order at 10). The file tree tab
 * was retired: the upstream sidebar ships file management natively. */
export function registerDockViews(ctx: ClientContext): void {
  const sessions = ctx.get('sessions') as unknown as SessionsService
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'git',
    order: 110,
    // The tab label is the brand token `Git` (upstream's own ring carries
    // 对话/审查/轨迹), so it stays out of the dictionary; `locale:` is what
    // puts the namespace-bound `t` seat on the tab body.
    locale: SIDEBAR_NS,
    label: () => 'Git',
    inject: (sessionId: SessionId) => ({ sessionId, cwd: cwdFor(sessions, sessionId) }),
  }, GitTab))
}
