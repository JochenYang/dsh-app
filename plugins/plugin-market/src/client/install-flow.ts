/**
 * The panel's install attempt: consume the intent the confirmation minted, and
 * re-mint ONCE when that token died while the dialog was open.
 *
 * Why a retry and not a plain await. The token's TTL is measured in the USER's
 * time, not the machine's: the mint happens when the confirmation opens
 * (`openInstallConfirm`), and the user reads, decides, and may be interrupted
 * first. Past the deadline — or once a later mint has evicted the pending entry
 * — the confirm used to be a hard failure: `POST /install` answered
 * `install.tokenExpired` / `install.tokenUnknown` and the strip told the user to
 * reopen the confirmation, so the click they had just made did nothing.
 *
 * The retry cannot widen anything. The host re-resolves the SAME row id on the
 * fresh mint, so what the install acts on is still the host's reading of that
 * row (a row that has since left the catalog is refused, exactly as before);
 * the one-shot fence is untouched, because a fresh token is still one use; and
 * every other refusal — no install target, a profile or data-directory change, a
 * same-name collision without the confirmed force — reaches the error strip
 * unchanged. So the recovery is bounded to the two codes that mean "this token
 * only": exactly one re-mint, and a failure of THAT mint or THAT install is
 * reported.
 *
 * @module @dsh-app/plugin-market/client/install-flow
 */

import { marketApi, MarketApiError, type InstallIntentValue, type InstallValue } from './api.ts'

/**
 * The two host codes that mean the token itself is gone — expired, or no longer
 * pending (already spent, or evicted by a later mint). Either is recoverable by
 * minting again for the same row.
 */
const STALE_TOKEN_CODES: readonly string[] = ['install.tokenExpired', 'install.tokenUnknown']

/** True when a failed install means only that its token died before the confirm. */
function isStaleIntent(error: unknown): boolean {
  if (!(error instanceof MarketApiError)) return false
  const code = error.host?.code
  return code !== undefined && STALE_TOKEN_CODES.includes(code)
}

/**
 * Install the row the confirmation was opened for.
 *
 * @param pending - the intent minted when the dialog opened; a rejected mint is
 *   re-attempted here, so the reason it failed reaches the error strip instead
 *   of the console.
 * @param entryId - the row id, the selector every mint uses (never a package
 *   name: the host resolves the row itself).
 * @param force - the user's confirmed same-name replacement, unchanged across
 *   the retry.
 * @returns the install result.
 * @throws MarketApiError of the failing call — including a second stale-token
 *   refusal, which is reported rather than retried again.
 */
export async function installFromRow(
  pending: Promise<InstallIntentValue>,
  entryId: string,
  force: boolean | undefined,
): Promise<InstallValue> {
  const issued = await pending.catch(() => marketApi.installIntent(entryId, force))
  try {
    return await marketApi.install(issued.token)
  } catch (error: unknown) {
    if (!isStaleIntent(error)) throw error
  }
  const reissued = await marketApi.installIntent(entryId, force)
  return await marketApi.install(reissued.token)
}
