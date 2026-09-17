/**
 * Proxy auto-detection for the kernel child process.
 *
 * Why this exists: on a machine whose VPN client runs in TUN/fake-IP mode,
 * every hostname resolves into 198.18.0.0/15 (the RFC 2544 benchmark range).
 * The kernel's `web-fetch-http` provider validates resolved addresses to keep
 * the agent off internal networks, so it refuses those — unless the request
 * goes through a proxy, in which case the proxy does the DNS and the check is
 * skipped by design.
 *
 * The kernel only takes that proxied branch when it can see a proxy in its
 * environment. Inheriting `HTTPS_PROXY` unconditionally would break the
 * opposite case: with the VPN off, a stale proxy URL sends every request to a
 * dead port. So the variable is injected only when a proxy is actually
 * listening — the two states then behave correctly without the user editing
 * anything:
 *
 *   proxy up   → injected → proxied branch → web_fetch works
 *   proxy down → not injected → direct fetch → web_search works, web_fetch
 *                falls back to whatever the local DNS allows
 *
 * Detection is a TCP connect, not an HTTP request: it must be cheap, must not
 * depend on the proxy answering a particular path, and must not outlive the
 * boot by more than the timeout below.
 */

import net from 'node:net'

/** Proxy env names the kernel reads, in the order it prefers them. */
const PROXY_ENV_NAMES = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY'] as const

/** Where a local proxy client commonly listens, when no override says otherwise. */
const DEFAULT_CANDIDATE_PORTS = [7897, 7890, 7891, 10809, 10808, 1080, 8080, 2080] as const

/**
 * Ports to probe, in order.
 *
 * `DSH_APP_PROXY_PORTS` replaces the list — a comma-separated set of ports —
 * for a proxy on a non-standard port, and for the probe script that exercises
 * the watchdog against a controlled listener.
 */
function candidatePorts(): readonly number[] {
  const raw = process.env.DSH_APP_PROXY_PORTS?.trim()
  if (raw === undefined || raw === '') return DEFAULT_CANDIDATE_PORTS
  const parsed = raw
    .split(',')
    .map(entry => Number.parseInt(entry.trim(), 10))
    .filter(port => Number.isInteger(port) && port > 0 && port <= 65_535)
  return parsed.length > 0 ? parsed : DEFAULT_CANDIDATE_PORTS
}

/** Loopback hosts a local proxy may bind. */
const CANDIDATE_HOSTS = ['127.0.0.1', '::1'] as const

/** Bound on one probe; a listener answers instantly, so this is generous. */
const PROBE_TIMEOUT_MS = 250

/**
 * Whether something is accepting TCP connections on this host:port.
 *
 * @param host - loopback host to probe.
 * @param port - port to probe.
 * @returns true when a connection was established within the timeout.
 */
function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const finish = (result: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(PROBE_TIMEOUT_MS)
    socket.once('connect', () => { finish(true) })
    socket.once('timeout', () => { finish(false) })
    socket.once('error', () => { finish(false) })
    socket.connect(port, host)
  })
}

/**
 * Whether the proxy at this URL is still accepting connections.
 *
 * Used by the shell's watchdog: the proxy is installed into the kernel's
 * dispatcher once at boot, so a proxy that stops listening afterwards leaves
 * every outbound request pointed at a closed port until the server restarts.
 * Only a loopback proxy URL is checked — anything else is not ours to probe.
 *
 * @param proxyUrl - the injected proxy URL, as produced by {@link detectLocalProxy}.
 * @returns true while a connection can still be established.
 */
export async function isProxyAlive(proxyUrl: string): Promise<boolean> {
  let parsed: URL
  try {
    parsed = new URL(proxyUrl)
  } catch {
    // An unparseable URL cannot be re-checked, so report it as alive: the
    // watchdog must never restart the server over a value it cannot evaluate.
    return true
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  const isLoopback = host === '127.0.0.1' || host === '::1' || host === 'localhost'
  if (!isLoopback) return true
  const port = Number.parseInt(parsed.port, 10)
  if (!Number.isInteger(port) || port <= 0) return true
  return await canConnect(host, port)
}

/**
 * Find a listening local proxy.
 *
 * @returns the proxy URL, or undefined when nothing answered.
 */
export async function detectLocalProxy(): Promise<string | undefined> {
  for (const port of candidatePorts()) {
    for (const host of CANDIDATE_HOSTS) {
      if (await canConnect(host, port)) {
        // `::1` needs brackets inside a URL.
        const authority = host === '::1' ? `[::1]:${String(port)}` : `${host}:${String(port)}`
        return `http://${authority}`
      }
    }
  }
  return undefined
}

/**
 * Whether an environment carries a proxy the kernel's launcher would accept.
 *
 * The shell spawns the host directly rather than through the `dsh` CLI's profile
 * boot, and no other path installs the outbound proxy policy (see
 * `hostProxyBootstrapUrl`). This is the condition that decides whether that
 * bootstrap rides along: a proxy present in the child's environment, whether the
 * shell detected it or the user exported it.
 *
 * Both cases are read because Windows keeps the authored case while POSIX does
 * not, and the kernel resolves lowercase first.
 *
 * @param env - the environment the host child is about to be spawned with.
 * @returns true when at least one proxy variable holds a non-blank value.
 */
export function hasProxyEnv(env: NodeJS.ProcessEnv): boolean {
  return PROXY_ENV_NAMES.some((name) => {
    const value = env[name] ?? env[name.toLowerCase()]
    return value !== undefined && value.trim() !== ''
  })
}

/**
 * The environment to spawn the kernel with.
 *
 * An explicit proxy in the parent environment always wins — a user who set one
 * has already decided, and probing would only second-guess them. Otherwise the
 * result of {@link detectLocalProxy} is applied, or nothing when no proxy is up.
 *
 * @param base - the environment the kernel would otherwise inherit.
 * @param detected - the probe's answer (undefined = no proxy listening).
 * @returns the environment plus any proxy variables to inject.
 */
export function withDetectedProxy(
  base: NodeJS.ProcessEnv,
  detected: string | undefined,
): { env: NodeJS.ProcessEnv, injected: boolean } {
  const alreadySet = PROXY_ENV_NAMES.some((name) => {
    const value = base[name] ?? base[name.toLowerCase()]
    return value !== undefined && value !== ''
  })
  if (alreadySet) return { env: base, injected: false }
  if (detected === undefined) return { env: base, injected: false }

  const env: NodeJS.ProcessEnv = { ...base }
  for (const name of PROXY_ENV_NAMES) env[name] = detected
  // Loopback must never be proxied: the kernel's own web server, MCP endpoints
  // on 127.0.0.1, and the agent-comm-hub all live there.
  const existingNoProxy = base.NO_PROXY ?? base.no_proxy
  const noProxyEntries = ['localhost', '127.0.0.1', '::1']
  if (existingNoProxy !== undefined && existingNoProxy !== '') {
    for (const entry of existingNoProxy.split(',')) {
      const trimmed = entry.trim()
      if (trimmed !== '' && !noProxyEntries.includes(trimmed)) noProxyEntries.push(trimmed)
    }
  }
  env.NO_PROXY = noProxyEntries.join(',')
  return { env, injected: true }
}
