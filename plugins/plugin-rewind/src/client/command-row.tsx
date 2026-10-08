/**
 * The transcript row for the `/rewind` command.
 *
 * A command's result text is rendered verbatim by the kernel's generic card, and
 * this repo's rule is that a host half sends a stable code rather than
 * user-visible prose. Without a renderer of its own, `/rewind` would therefore
 * print the raw `{"code":"rewind.host.list",…}` payload into the conversation —
 * which is exactly what it did before this module existed.
 *
 * This renderer is registered into the keyed `conversation.chat.commandview`
 * slot under the command's name, so it replaces the generic card for `/rewind`
 * only. It resolves the coded payload through this plugin's dictionary and falls
 * back to the host's English diagnostic for a code this build does not know.
 *
 * @module @dsh-app/plugin-rewind/client/command-row
 */

import type { ReactNode } from 'react'
import type { CommandNode, CommandRowProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import { hostMessage } from './messages.ts'

/** Props of this row: the command node plus this plugin's `t` seat. */
export type RewindCommandRowProps = CommandRowProps & PropsLocale<typeof NS>

/**
 * Render one `/rewind` outcome as a sentence.
 *
 * @param props - the command row's props.
 * @returns the rendered row.
 */
export function RewindCommandRow({ node, t }: RewindCommandRowProps): ReactNode {
  const command: CommandNode = node
  const outcome = command.outcome
  const raw = outcome?.text
  const rendered = hostMessage(raw, t)
  const failed = outcome?.kind === 'error'
  return (
    <div className="dshRewind-commandRow" data-tone={failed ? 'error' : 'info'} role="status">
      <span className="dshRewind-commandText">{rendered ?? ''}</span>
    </div>
  )
}
