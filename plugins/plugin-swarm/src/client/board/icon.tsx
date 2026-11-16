/**
 * The swarm board's guide icon: one coordinator dot fanning out to three
 * workers. Filled dots and a single 1.4-wide split read cleanly at the guide's
 * 22–26 px, where the previous outlined hub became four busy rings.
 *
 * @module @dsh-app/plugin-swarm/client/board/icon
 */

import type { ReactNode } from 'react'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/** One node splitting into three parallel workers, in the brand colour. */
export function SwarmBoardIcon({ size = 16, className }: IconProps): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      style={{ color: 'var(--dsw-alias-state-business-primary)' }}
      aria-hidden="true"
    >
      <circle cx="8" cy="2" r="1.3" fill="currentColor" />
      <path
        d="M8 3.5v2.4M8 5.9H3.4v4.1M8 5.9v4.1M8 5.9h4.6v4.1"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="3.4" cy="11.6" r="1.5" fill="currentColor" opacity="0.78" />
      <circle cx="8" cy="11.6" r="1.5" fill="currentColor" opacity="0.78" />
      <circle cx="12.6" cy="11.6" r="1.5" fill="currentColor" opacity="0.78" />
    </svg>
  )
}
