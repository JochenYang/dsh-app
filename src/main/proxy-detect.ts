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
 * A third state is refused outright, and the reason is measured rather than
 * principled. On a machine whose resolver answers with placeholder addresses (the
 * SAME TUN client: everything resolves into 198.18.0.0/15) the proxy env would be
 * the only reason the kernel loads its own `undici`, and in this version pairing —
 * that undici against Node's bundled one — the kernel's BUILT-IN `fetch` then
 * reads every provider response as an unparsable body. The visible symptom is the
 * model list failing for every provider while nothing else notices; the traffic
 * still flows, because the TUN adapter routes it. Such a machine keeps the env
 * out, and {@link decideProxyOffer} owns that rule (`DSH_APP_PROXY_INJECT`
 * overrides it).
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
import { lookup } from 'node:dns/promises'

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

/** The RFC 2544 benchmarking range a TUN client answers with instead of an address. */
const FAKE_IP_SECOND_OCTETS = ['18', '19'] as const

/** Public names the fake-IP probe resolves; a real resolver answers both. */
const FAKE_IP_PROBE_HOSTS = ['example.com', 'www.example.org'] as const

/** Bound on the probe, so a blocked resolver cannot hold up the start. */
const FAKE_IP_PROBE_TIMEOUT_MS = 1_500

/** Await `work`, or reject once `ms` elapse — the timer never keeps Node alive. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('probe timed out'))
        }, ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Whether an address is the placeholder a TUN/fake-IP client hands out.
 *
 * 198.18.0.0/15 is the RFC 2544 benchmarking range: no public host is in it, and a
 * client in TUN mode answers EVERY hostname with an address in it so its own rules
 * decide where the connection really goes.
 *
 * @param address - one answer from `dns.lookup`.
 * @returns true when the address is such a placeholder.
 */
export function isFakeIpAddress(address: string): boolean {
  const parts = address.split('.')
  const second = parts[1] ?? ''
  return parts.length === 4 && parts[0] === '198' && FAKE_IP_SECOND_OCTETS.some((octet) => octet === second)
}

/**
 * Whether this machine's resolver answers with placeholder addresses.
 *
 * Measured on the machine this was written for: `cpa.geluman.cn → 198.18.1.134`,
 * `api.github.com → 198.18.0.29`, and the machine's own address `198.18.0.1` with
 * DNS `198.18.0.2` — a client in TUN mode, where the adapter routes every outbound
 * connection and a proxy environment is not what makes traffic flow.
 *
 * A resolution that fails or times out answers false, so the caller keeps the
 * behaviour it had; see {@link decideProxyOffer} for what the two answers do.
 *
 * @returns true when a public name resolves into the placeholder range.
 */
export async function resolvesToFakeIpRange(): Promise<boolean> {
  for (const host of FAKE_IP_PROBE_HOSTS) {
    let answers: readonly { address: string }[]
    try {
      answers = await withTimeout(lookup(host, { all: true }), FAKE_IP_PROBE_TIMEOUT_MS)
    } catch {
      continue
    }
    if (answers.some((entry) => isFakeIpAddress(entry.address))) return true
  }
  return false
}

/** Why the shell did or did not offer the kernel a proxy. */
export type ProxyOfferReason = 'detected' | 'none' | 'fake-ip' | 'override-off'

/**
 * The proxy to hand the kernel child, and why.
 *
 * The fake-IP rule is the surprising one, and it is a measured trade rather than a
 * preference. On such a machine the injected URL buys exactly one thing — the
 * kernel's web_fetch passes its address validation, which refuses the placeholder
 * answers unless a proxy is visible — and it costs the model list: with a proxy in
 * its environment the kernel installs an `undici` dispatcher into the global slot,
 * and in this version pairing (the npm undici the kernel ships, against Node's own
 * bundled one) the BUILT-IN `fetch` then reads a response with no headers and an
 * undecoded body, so every provider interrogation fails with "did not answer with
 * JSON". Measured both ways on one machine, same endpoint and same credential:
 * proxy env → every provider fails; no proxy env → the real model list. Traffic
 * still reaches the internet either way, because that is what the TUN adapter does.
 *
 * `DSH_APP_PROXY_INJECT` overrides the rule: `on` injects whatever was detected,
 * `off` injects nothing.
 *
 * @param options - the detected proxy, whether this machine answers with fake
 *   addresses, and the user's override.
 * @returns the URL to inject (undefined leaves the environment alone) and the
 *   reason, for the caller's log line.
 */
export function decideProxyOffer(options: {
  detected: string | undefined
  fakeIp: boolean
  override: string | undefined
}): { proxy: string | undefined; reason: ProxyOfferReason } {
  const override = options.override?.trim().toLowerCase()
  if (override === 'off') return { proxy: undefined, reason: 'override-off' }
  if (options.detected === undefined) return { proxy: undefined, reason: 'none' }
  if (override === 'on') return { proxy: options.detected, reason: 'detected' }
  if (options.fakeIp) return { proxy: undefined, reason: 'fake-ip' }
  return { proxy: options.detected, reason: 'detected' }
}
