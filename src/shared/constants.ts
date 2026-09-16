/** Application-wide constants for the DSH APP desktop shell. */

export const APP_ID = 'com.dshapp.desktop'
export const APP_NAME = 'DSH APP'

/**
 * dsh profile the brand suite boots under.
 *
 * The suite owns a profile of its own — upstream's desktop does the same
 * (a reserved profile, its own bundle list, its own package-manager state,
 * shared data layer). A user's own `dsh` / `dsh web` runs keep `web`, and our
 * plugin market follows the profile actually booted via `DSH_APP_PROFILE`, so
 * the two plugin worlds never disagree about where installs land.
 *
 * Data is untouched by this: sessions, settings, credentials, workspaces and
 * plugin storages are resolved from `$DSH_HOME` and are profile-independent.
 */
export const SUITE_PROFILE = 'dsh-app'

/** Profile the suite booted before it had one of its own (pre-migration). */
export const LEGACY_PROFILE = 'web'

/**
 * Bundle layers a fresh suite profile is seeded with: the shipped `web`
 * template's list (`PROFILE_TEMPLATES.web` in app-boot). Migration copies the
 * user's own dependencies on top and lets `dsh plugin install` reconcile the
 * rest. If upstream retargets that template, this list has to follow — the
 * suite smoke run fails loudly when the composed layers are wrong.
 */
export const SUITE_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] as const

/** GitHub owner/repo hosting kernel runtime + shell update artifacts. */
export const DEFAULT_ARTIFACT_OWNER = 'JochenYang'
export const DEFAULT_ARTIFACT_REPO = 'dsh-app'

/** Resolve the artifact owner/repo, honoring the DSH_APP_ARTIFACT_* overrides. */
export function resolveArtifactOwner(): string {
  const raw = (process.env.DSH_APP_ARTIFACT_OWNER ?? '').trim()
  return raw !== '' ? raw : DEFAULT_ARTIFACT_OWNER
}

/** Resolve the artifact repo, honoring the DSH_APP_ARTIFACT_* overrides. */
export function resolveArtifactRepo(): string {
  const raw = (process.env.DSH_APP_ARTIFACT_REPO ?? '').trim()
  return raw !== '' ? raw : DEFAULT_ARTIFACT_REPO
}

/**
 * ModelScope mirror of this repo's GitHub release assets (byte-identical
 * files, `latest.yml`'s sha512 stays valid). It is the first update source on
 * Windows because GitHub and its proxies are routinely unreachable from
 * mainland China. Fixed to the upstream repo on purpose: the artifact
 * overrides above point at forks, which mirror their own releases separately.
 */
export const MODELSCOPE_ENDPOINT = 'https://www.modelscope.cn'
export const MODELSCOPE_REPO = 'jochenYang/dsh-app'

/** Human-facing mirror page, offered when every update source fails. */
export const MODELSCOPE_RELEASES_URL = `${MODELSCOPE_ENDPOINT}/models/${MODELSCOPE_REPO}/files`
/** Host the local dsh web server binds to (loopback only — never 0.0.0.0). */
export const DEFAULT_HTTP_HOST = '127.0.0.1'

/** Directory (under app userData) that holds versioned kernel runtimes. */
export const KERNEL_ROOT_DIR = 'kernel'
export const CURRENT_FILE = 'current.json'
export const STAGING_DIR = 'staging'
export const TARBALL_FILE = 'runtime.tgz'
/**
 * Layer cache (under the kernel root): the split runtime's layer tarballs,
 * named by their cache key. Never swept as a version directory — it survives
 * cleanup() so an update only fetches the layers that actually changed.
 */
export const LAYERS_DIR = 'layers'
/** Layer index file shipped beside the layer tarballs. */
export const LAYER_INDEX_FILE = 'layers.json'
/**
 * Subdirectory of `STAGING_DIR` holding in-flight layer downloads. A layer
 * enters the cache only by an atomic rename out of here, so a half-written or
 * unverified file can never be mistaken for a cache entry.
 */
export const LAYER_STAGING_DIR = 'layers'

/** How often to poll for kernel updates while running. */
export const KERNEL_CHECK_INTERVAL_MS = 1000 * 60 * 60 * 6 // 6 hours

/** How long to wait for the dsh web server to answer before declaring failure. */
export const SERVER_HEALTH_TIMEOUT_MS = 90_000
export const SERVER_HEALTH_POLL_MS = 200

/** Grace period before force-killing the dsh server child on shutdown. */
export const SERVER_SHUTDOWN_GRACE_MS = 8_000
