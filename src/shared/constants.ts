/** Application-wide constants for the DSH App desktop shell. */

export const APP_ID = 'com.dshapp.desktop'
export const APP_NAME = 'DSH App'

/** Host the local dsh web server binds to (loopback only — never 0.0.0.0). */
export const DEFAULT_HTTP_HOST = '127.0.0.1'

/** Directory (under app userData) that holds versioned kernel runtimes. */
export const KERNEL_ROOT_DIR = 'kernel'
export const CURRENT_FILE = 'current.json'
export const STAGING_DIR = 'staging'
export const TARBALL_FILE = 'runtime.tgz'

/** How often to poll for kernel updates while running. */
export const KERNEL_CHECK_INTERVAL_MS = 1000 * 60 * 60 * 6 // 6 hours

/** How long to wait for the dsh web server to answer before declaring failure. */
export const SERVER_HEALTH_TIMEOUT_MS = 30_000
export const SERVER_HEALTH_POLL_MS = 500

/** Grace period before force-killing the dsh server child on shutdown. */
export const SERVER_SHUTDOWN_GRACE_MS = 8_000

/** IPC channel names (main <-> setup renderer). */
export const IPC = {
  kernelStatus: 'kernel:status',
  kernelInstall: 'kernel:install',
  kernelCancel: 'kernel:cancel',
  kernelInfo: 'kernel:info',
  kernelUpdateCheck: 'kernel:update-check',
  kernelApplyUpdate: 'kernel:apply-update',
} as const
