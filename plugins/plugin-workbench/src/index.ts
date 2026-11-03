/**
 * DSH APP workbench hub — host half.
 *
 * Two jobs, one of them new:
 *
 * 1. A loader row, so the client-modules scan sees this package's `dsh.client`
 *    declaration and serves `lib/client.js`. The same shape
 *    `@dsh-app/plugin-effort` uses for its own pure UI plugin.
 * 2. Install the seat-contract skill (`src/skill.ts`) into
 *    `$DSH_HOME/skills/dsh-app-workbench-card/`. The container's extension seats
 *    are ours, so the Creator mode that is asked to fill them needs a contract
 *    it can read; the host half is the half that owns a filesystem.
 *
 * The install is fire-and-forget and content-compared: the skill file outlives
 * this fiber, so there is nothing to undo on unmount, and a mount whose skill
 * write fails must not take the plugin (and with it the whole workbench UI)
 * down. It logs and degrades instead.
 *
 * @module @dsh-app/plugin-workbench
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { installSkill, SKILL_NAME } from './skill.ts'

export const name = 'plugin-workbench'

/** Message of an unknown cause, for the one log line that needs it. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Host plugin body: install the seat-contract skill.
 *
 * @param ctx - the host plugin context.
 */
export function apply(ctx: Context): void {
  const log = ctx.logger(name)
  void installSkill(resolveDshHome()).then(
    (change) => {
      if (change === 'installed') log.info(`workbench skill installed: ${SKILL_NAME}`)
      // A file at our name whose body is not ours is kept, not overwritten:
      // `dsh-app-workbench-card` is a legal market slug, so the directory can
      // hold somebody else's skill. Keep the log line — ours never appearing is
      // otherwise unexplainable.
      if (change === 'kept-foreign') log.info(`kept skill directory "${SKILL_NAME}": its body is not this plugin's`)
    },
    (cause: unknown) => {
      log.warn(`workbench skill install failed: ${messageOf(cause)}`)
    },
  )
}
