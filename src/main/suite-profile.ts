/**
 * The suite's own dsh profile: a one-time move off the shared `web` one.
 *
 * Upstream's desktop owns a reserved profile (its CLI refuses `--profile
 * desktop`), with its own bundle list and its own package-manager state, and
 * shares only the data layer. The suite now does the same: the app boots
 * `dsh-app`, so the plugin world a user's own `dsh` / `dsh web` runs manage in
 * `web` stays theirs — including for our plugin market, which follows
 * `DSH_APP_PROFILE`, set to the profile actually booted.
 *
 * What carries over is the part that is ours to move: the profile manifest
 * (the shipped template's bundle list) and the user's own patch layer — the
 * hand-written disables and MCP rows in `cordis.patch.yml`. Third-party
 * packages declared on the old profile are deliberately NOT carried: the
 * in-app market reinstalls them into the new profile, and it is the component
 * that already knows how to satisfy pnpm's supply-chain policies, prompt for
 * build scripts and handle a spec that no longer resolves. Two "carry the
 * tree" variants were measured and rejected first:
 *
 *   - COPYING `profiles/web` across: pnpm's `.pnpm` virtual store holds
 *     SYMLINKS (peer dependencies) and Windows refuses to create them without
 *     Developer Mode or elevation — `EPERM: operation not permitted, symlink
 *     ...\.pnpm\...\cosmokit`, partway through.
 *   - REINSTALLING the old dependencies from the copied lockfile: `pnpm
 *     install` runs pnpm 11's supply-chain policy check over that lockfile and
 *     rejects entries inside the release-age cooldown
 *     (`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`, e.g. a plugin published hours
 *     ago) — the exclusion list the market writes does not apply to that
 *     check, so a migration would depend on whether the user's newest plugins
 *     happen to be old enough.
 *
 * Sessions, settings, credentials, workspaces and plugin storages live under
 * `$DSH_HOME` and are profile-independent: nothing about them moves.
 *
 * Until the marker exists the shell keeps booting `web`, so a failure costs
 * one log line and is retried on the next launch; an interrupted attempt
 * leaves no marker and its directory is removed before the retry.
 */
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { LEGACY_PROFILE, SUITE_PROFILE, SUITE_PROFILE_BUNDLES } from '../shared/constants'
import { resolveDshHome } from './brand-suite'

/** Marker inside the suite profile: present = the profile is ready to boot. */
export const SUITE_PROFILE_MARKER = '.dsh-app-ready.json'

/** pnpm settings an upstream-initialized profile carries (app-boot initProfile). */
const PNPM_WORKSPACE = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'

/** Where the marker lives for the given home. */
function markerPath(home = resolveDshHome()): string {
  return path.join(home, 'profiles', SUITE_PROFILE, SUITE_PROFILE_MARKER)
}

/** Whether the suite profile is ready to be booted. */
export function isSuiteProfileReady(home = resolveDshHome()): boolean {
  return existsSync(markerPath(home))
}

/**
 * The profile this boot should use: the suite's own once it is ready, the
 * shared `web` one until then.
 */
export function activeBootProfile(home = resolveDshHome()): string {
  return isSuiteProfileReady(home) ? SUITE_PROFILE : LEGACY_PROFILE
}

/** Outcome of one attempt. */
export interface MigrationOutcome {
  /** `already` — marker present; `seeded` — profile created now; `failed` — see detail. */
  status: 'already' | 'seeded' | 'failed'
  /** Package names the old profile declares (they stay there; the market reinstalls). */
  legacyPackages: number
  /** Whether the user's own patch layer was carried over. */
  carriedPatch: boolean
  /** Failure detail, for the log. */
  detail?: string
}

/** Package names a profile's manifest declares. */
async function declaredPackages(profileDir: string): Promise<number> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(profileDir, 'package.json'), 'utf8'))
    const dependencies = (parsed as { dependencies?: Record<string, unknown> }).dependencies
    return dependencies === undefined ? 0 : Object.keys(dependencies).length
  } catch {
    return 0
  }
}

/**
 * Materialize the suite profile, once. Idempotent: the marker short-circuits a
 * second call, and a failed attempt removes its own half-built directory so the
 * retry starts clean.
 *
 * @returns what happened, for the caller's log line.
 */
export async function migrateSuiteProfile(): Promise<MigrationOutcome> {
  const home = resolveDshHome()
  if (isSuiteProfileReady(home)) {
    return { status: 'already', legacyPackages: 0, carriedPatch: false }
  }

  const target = path.join(home, 'profiles', SUITE_PROFILE)
  const legacy = path.join(home, 'profiles', LEGACY_PROFILE)
  try {
    // A leftover directory without a marker is an interrupted attempt.
    await fs.rm(target, { recursive: true, force: true })
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(
      path.join(target, 'package.json'),
      `${JSON.stringify({
        name: `dsh-profile-${SUITE_PROFILE}`,
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: [...SUITE_PROFILE_BUNDLES], patchReload: 'live' } },
      }, undefined, 2)}\n`,
      'utf8',
    )
    await fs.writeFile(path.join(target, 'pnpm-workspace.yaml'), PNPM_WORKSPACE, 'utf8')

    // The user's own rows — hand-written disables and MCP inserts. Copied
    // verbatim: an id that does not exist in this profile is simply inert.
    let carriedPatch = false
    try {
      await fs.copyFile(path.join(legacy, 'cordis.patch.yml'), path.join(target, 'cordis.patch.yml'))
      carriedPatch = true
    } catch {
      /* the old profile has no patch layer: nothing to carry */
    }

    const legacyPackages = await declaredPackages(legacy)
    await fs.writeFile(
      markerPath(home),
      `${JSON.stringify({
        migratedAt: new Date().toISOString(),
        from: LEGACY_PROFILE,
        carriedPatch,
        legacyPackages,
      }, undefined, 2)}\n`,
      'utf8',
    )
    return { status: 'seeded', legacyPackages, carriedPatch }
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true }).catch(() => undefined)
    return { status: 'failed', legacyPackages: 0, carriedPatch: false, detail: (error as Error).message }
  }
}

/** One migration per process, whatever calls it. */
let inFlight: Promise<MigrationOutcome> | null = null

/**
 * Kick the migration off in the background and report through `log`.
 *
 * Never awaited by the caller: the profile in use this session does not change,
 * the next boot picks up the marker. A failure is retried on the next launch.
 *
 * @param log - sink for the one-line outcome (defaults to a console warning).
 * @returns the shared promise, for tests or an explicit await.
 */
export function startSuiteProfileMigration(
  log: (message: string) => void = (message) => console.warn(message),
): Promise<MigrationOutcome> {
  if (inFlight !== null) return inFlight
  inFlight = migrateSuiteProfile().then((outcome) => {
    if (outcome.status === 'failed') {
      log(`[suite-profile] migration failed; staying on "${LEGACY_PROFILE}" and retrying next start: ${outcome.detail ?? ''}`)
    } else if (outcome.status === 'seeded') {
      log(`[suite-profile] "${SUITE_PROFILE}" profile ready${outcome.carriedPatch ? ' (your patch layer carried over)' : ''}`
        + `; the ${String(outcome.legacyPackages)} package(s) declared on "${LEGACY_PROFILE}" stay there — reinstall them from 插件市场, and the next start boots the new profile`)
    }
    return outcome
  })
  return inFlight
}
