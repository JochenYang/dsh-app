/**
 * The Creator door — entering the workbench's plugin-authoring mode from the
 * sidebar.
 *
 * Creator mode is not an API of ours: it is the kernel's own agent preset
 * (`cordis`) started through the workspace controller, with a region-specific
 * opening prompt and `whenDraftExists: 'append'` so an unsent draft is kept
 * rather than replaced. The upstream client (`dsh-client-ui-entry-customization`)
 * opens it from three regions — left sidebar, conversation view, right sidebar —
 * and the workbench is the fourth surface, so this module is that same call with
 * this container's own prompt.
 *
 * WHY THE PROMPT IS A PARAMETER, NOT A CONSTANT. It is pre-filled into the
 * session's DRAFT: `startSession` splits its second argument, and `prompt` is
 * part of the draft, so the user reads and edits that text before sending. That
 * makes it user-visible copy, which this suite keeps in a plugin dictionary —
 * the kernel's own Creator rows carry one prompt per language for the same
 * reason — so the caller passes the localized string in.
 *
 * WHERE THE PROMPT'S CONTENT IS DECIDED. It names only the SKILL: the seat
 * contract lives in `dsh-app-workbench-card` (installed by the host half,
 * `src/skill.ts`), and repeating a seat name or a declaration shape here would
 * make a second copy of a contract that changes with the container. The prompt's
 * whole job is: load the skill, register one card, remember it is
 * session-scoped. `tests/create-entry.test.ts` asserts that shape on both
 * dictionaries, because a future edit is most likely to break it while
 * everything else still looks right.
 *
 * WHY THE SERVICE IS READ STRUCTURALLY, PER CALL. The same discipline as
 * `client/entry.ts`, for the same measured reasons: `ctx.get` answers undefined
 * during apply, a namespace service is a seam rather than a module this plugin
 * depends on, and the caller is a React event handler where a rejection surfaces
 * as an unhandled rejection and no copy at all. So a missing or reshaped service
 * answers `pending`, and every rejection becomes a stable code.
 *
 * @module @dsh-app/plugin-workbench/client/create
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { failureCodeOf } from './entry.ts'
import type { WorkbenchEntryStatus } from './entry.ts'

/**
 * The agent preset that turns a session into a plugin author.
 *
 * Upstream's "Create your plugin" menu row starts exactly this preset; it is the
 * only thing that makes the session a Creator session, so it is a constant here
 * rather than a caller argument.
 */
export const CREATOR_AGENT_PRESET = 'cordis'

/** Structural face of the workspace controller's session starter, as used here. */
interface CreatorSessionStart {
  startSession(
    workspaceId: undefined,
    options: {
      readonly agentPreset: string
      readonly prompt: string
      readonly whenDraftExists: 'append'
    },
  ): unknown
}

/**
 * Start a Creator session with one opening prompt, answering a status token.
 *
 * The prompt is the caller's string — the row resolves it through this plugin's
 * dictionary in the language in force at press time. Passing it in rather than
 * holding a constant here is what keeps the draft localizable; see this module's
 * header.
 */
export type CreateCreatorSession = (prompt: string) => Promise<WorkbenchEntryStatus>

/**
 * Build the entry action the sidebar row calls.
 *
 * @param ctx - the client root context.
 * @returns an action that never rejects.
 */
export function createCreatorSession(ctx: ClientContext): CreateCreatorSession {
  return async (prompt) => {
    // Resolved per call: see this module's header. A kernel without the
    // workspace line answers `pending` instead of throwing.
    const service = ctx.get('uiWorkspace') as Partial<CreatorSessionStart> | undefined
    const startSession = service?.startSession
    if (typeof startSession !== 'function') return 'pending'
    try {
      // `undefined` rather than a workspace id: the session is created in the
      // current workspace, the same shape upstream's three rows pass.
      await startSession.call(service, undefined, {
        agentPreset: CREATOR_AGENT_PRESET,
        prompt,
        whenDraftExists: 'append',
      })
      return 'ok'
    } catch (error) {
      return `error:${failureCodeOf(error)}`
    }
  }
}
