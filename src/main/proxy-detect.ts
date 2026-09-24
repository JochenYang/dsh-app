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
 * The second state is why injection is not unconditional, and it is the whole
 * rule: nothing here inspects what the resolver answers. A machine whose TUN
 * client hands out placeholder addresses (198.18.0.0/15) still gets the proxy —
 * it is the only thing that makes the kernel's web_fetch skip its address
 * validation, and the traffic needs the route either way.
 *
 * Detection is a TCP connect first, then a single HTTP CONNECT probe. The
 * probe is deliberately narrow in what it ACCEPTS, but it is not proof of a
 * proxy: any listener that answers the CONNECT with an HTTP status is taken —
 * a real proxy always does (200 for the tunnel, 4xx/5xx when the target is
 * unreachable), while anything that is not an HTTP server at all (a raw TCP
 * daemon, a port that only accepts and closes) is refused. Telling a proxy
 * apart from a generic HTTP service would need a full tunnel round-trip, and
 * the candidate ports below are the proxy clients' OWN defaults; the old
 * behaviour (a bare connect) adopted any listener whatsoever, so this is
 * strictly narrower.
 */

import net from 'node:net'
import http from 'node:http'

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
 * Whether the listener on this host:port answers AS AN HTTP SERVER.
 *
 * A CONNECT to a loopback address that refuses connections is the cheapest
 * question an HTTP server answers without side effects: a proxy replies with a
 * status (200 for the tunnel, or 4xx/5xx when the target is unreachable), and
 * any other HTTP service replies with its own status too. What is refused is a
 * listener that does not speak HTTP at all — it times out or drops the
 * connection. The status itself is not inspected (see the module header for
 * why a full tunnel round-trip is not worth it here).
 *
 * @param host - loopback host to probe.
 * @param port - port to probe.
 * @returns true when an HTTP response came back from the port.
 */
function speaksProxy(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: boolean): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    let req: http.ClientRequest
    try {
      req = http.request({
        host,
        port,
        method: 'CONNECT',
        // A refused loopback target: a proxy answers this without opening an
        // upstream connection of its own.
        path: '127.0.0.1:1',
        agent: false,
        timeout: PROBE_TIMEOUT_MS,
      }, (res) => {
        res.resume()
        finish(true)
      })
    } catch {
      finish(false)
      return
    }
    // A CONNECT answered with 200 does NOT emit 'response': node's client
    // hands the tunnel to the 'connect' event (res, socket, head) and leaves
    // the response callback uninvoked — without this listener the probe would
    // never settle against exactly the proxies it is meant to accept.
    req.on('connect', (_res, socket) => {
      socket.destroy()
      finish(true)
    })
    req.on('timeout', () => {
      req.destroy()
      finish(false)
    })
    req.on('error', () => finish(false))
    req.end()
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
      if (!(await canConnect(host, port))) continue
      if (!(await speaksProxy(host, port))) {
        // Something listens, but it is not a proxy (a dev server, a stray
        // daemon): handing it the kernel's outbound traffic would be worse
        // than having no proxy at all.
        continue
      }
      // `::1` needs brackets inside a URL.
      const authority = host === '::1' ? `[::1]:${String(port)}` : `${host}:${String(port)}`
      return `http://${authority}`
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
    // Same predicate as hasProxyEnv: a whitespace-only value is "not set" in
    // both places, or the two would disagree about the same environment.
    return value !== undefined && value.trim() !== ''
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
