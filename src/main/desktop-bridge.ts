/**
 * Desktop bridge: the one channel through which the kernel-side plugins can ask
 * the shell to perform a NATIVE action (reveal a folder, notify, save-as, pick a
 * directory).
 *
 * Why it exists at all: the native capabilities live in the Electron main
 * process, the kernel is a CHILD process, and the rendered UI is a remote-origin
 * page in a sandboxed window with no preload and no IPC. Anything else we tried
 * costs more than it buys — an out-of-band stdout channel handles one-way
 * actions but not `save-text-as`/`pick-directory`, which need a return value,
 * and preload+IPC would break the security posture the whole shell is built on.
 *
 * Fences, all of them required (a local HTTP server is reachable by every process
 * on the machine, and by any page that gets the port):
 *   1. binds loopback only;
 *   2. a per-run 32-byte bearer token, compared in constant time;
 *   3. the `Host` header must be a loopback form (blocks DNS rebinding);
 *   4. any request carrying an `Origin` header is refused — a page in a browser
 *      or in the app's own renderer always sends one, the kernel's fetch never
 *      does, so this alone keeps browsers out;
 *   5. no CORS headers are ever sent, so a page cannot even read a response;
 *   6. a body cap, so a local process cannot exhaust memory through it.
 *
 * The module deliberately knows nothing about Electron: the native actions
 * arrive as handlers, which keeps the whole fence testable without a GUI.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { t } from '../shared/locale'

/** Longest accepted string field (a path, a filename, a title). */
const MAX_TEXT = 4_096
/** Longest accepted file payload for save-text-as, and the request-body cap. */
const MAX_CONTENT = 8 * 1024 * 1024
/**
 * Socket inactivity timeout. It must outlast the longest legitimate silence on
 * the connection, and the longest one is a HUMAN: `save-text-as` and
 * `pick-directory` block while the user reads a native dialog, which can easily
 * take minutes. A short timeout would drop the connection mid-dialog and report
 * a failure for an action that actually succeeded.
 */
const REQUEST_TIMEOUT_MS = 5 * 60_000

export interface DesktopBridgeHandlers {
  /** Reveal a path in the OS file manager. */
  openInFolder?: (path: string) => Promise<void>
  /** Show a system notification. */
  notify?: (title: string, body: string) => Promise<void>
  /** Ask for a destination path; null when the user cancels. */
  saveTextAs?: (name: string, content: string) => Promise<string | null>
  /** Ask for a directory; null when the user cancels. */
  pickDirectory?: () => Promise<string | null>
  /** Reveal the shell's log directory. */
  openLogs?: () => Promise<void>
}

export interface DesktopBridge {
  /** Loopback base URL handed to the kernel child through its environment. */
  readonly url: string
  /** Per-run secret; the kernel must send it as `Authorization: Bearer`. */
  readonly token: string
  /** Environment variables to inject into the kernel child. */
  readonly env: Record<string, string>
  /** Stop listening. Safe to call twice. */
  close(): Promise<void>
}

/** Constant-time comparison that does not leak length through timing. */
function tokenMatches(expected: string, provided: string): boolean {
  const a = createHash('sha256').update(expected).digest()
  const b = createHash('sha256').update(provided).digest()
  return timingSafeEqual(a, b)
}

/**
 * True for the `Host` forms a loopback-bound server may legitimately see.
 * Anything else means either a DNS-rebinding attempt or a proxy in the middle.
 * @param hostHeader - raw `Host` header, or undefined when absent.
 */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (hostHeader === undefined) return false
  // Strip the port without parsing IPv6 brackets as a port separator.
  const withoutPort = hostHeader.startsWith('[')
    ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
    : hostHeader.split(':')[0]!
  return withoutPort === '127.0.0.1' || withoutPort === 'localhost' || withoutPort === '[::1]'
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/** An action failure with the status the caller should see. */
class BridgeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

/** Reject the caller's input (400) rather than reporting an action failure (500). */
function badRequest(message: string): BridgeError {
  return new BridgeError(message, 400)
}

/** Read the request body up to the cap; throws when the client overshoots. */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_CONTENT) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** One validated string field: present, a string, and not absurdly long. */
function textField(body: Record<string, unknown>, name: string, max = MAX_TEXT): string | null {
  const value = body[name]
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return null
  return value
}

/**
 * Start the bridge.
 * @param handlers - native action implementations; a missing handler is reported
 *   as unavailable rather than failing the whole bridge (a dev shell without an
 *   action must still boot).
 * @returns the bridge handle, or null when the port could not be bound — the
 *   caller then boots without a bridge, exactly like a kernel that ignores the
 *   environment variables.
 */
export async function startDesktopBridge(handlers: DesktopBridgeHandlers): Promise<DesktopBridge | null> {
  const token = randomBytes(32).toString('base64url')
  const server: Server = createServer((req, res) => {
    void handle(req, res, handlers, token)
  })
  server.setTimeout(REQUEST_TIMEOUT_MS)
  const listening = await new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => resolve(true))
  })
  if (!listening) {
    server.close()
    return null
  }
  const { port } = server.address() as AddressInfo
  const url = `http://127.0.0.1:${port}`
  return {
    url,
    token,
    env: { DSH_APP_BRIDGE_URL: url, DSH_APP_BRIDGE_TOKEN: token },
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve())
      // close() waits for keep-alive sockets; an idle one must not hold shutdown.
      server.closeIdleConnections()
    }),
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  handlers: DesktopBridgeHandlers,
  token: string,
): Promise<void> {
  // Fence 3, 4: never answer a request that reached us through a browser.
  if (!isLoopbackHost(req.headers.host) || req.headers.origin !== undefined) {
    sendJson(res, 403, { ok: false, error: 'forbidden' })
    return
  }
  // Fence 2: the bearer token is the only thing that distinguishes the kernel
  // child from any other local process that finds the port.
  const authorization = req.headers.authorization ?? ''
  if (!authorization.startsWith('Bearer ') || !tokenMatches(token, authorization.slice('Bearer '.length))) {
    sendJson(res, 401, { ok: false, error: 'unauthorized' })
    return
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' })
    return
  }
  const action = (req.url ?? '').split('?')[0]!.replace(/^\/bridge\//u, '')
  if (!req.url?.startsWith('/bridge/')) {
    sendJson(res, 404, { ok: false, error: 'unknown route' })
    return
  }

  let body: Record<string, unknown>
  try {
    const raw = await readBody(req)
    body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>)
  } catch (err) {
    sendJson(res, (err as Error).message === 'body too large' ? 413 : 400, { ok: false, error: (err as Error).message })
    return
  }

  try {
    const result = await dispatch(action, body, handlers)
    if (result === 'unavailable') {
      sendJson(res, 501, { ok: false, error: t('bridge.unsupported') })
      return
    }
    sendJson(res, 200, { ok: true, ...result })
  } catch (err) {
    // Never leak an internal detail: the action's own message is already the
    // actionable, user-facing one. Input validation reports 400, everything
    // else (a native action that failed) 500.
    const status = err instanceof BridgeError ? err.status : 500
    sendJson(res, status, { ok: false, error: (err as Error).message })
  }
}

/** Route one action; returns the JSON payload, or 'unavailable'. */
async function dispatch(
  action: string,
  body: Record<string, unknown>,
  handlers: DesktopBridgeHandlers,
): Promise<Record<string, unknown> | 'unavailable'> {
  switch (action) {
    case 'open-in-folder': {
      if (handlers.openInFolder === undefined) return 'unavailable'
      const target = textField(body, 'path')
      if (target === null) throw badRequest('invalid path')
      await handlers.openInFolder(target)
      return {}
    }
    case 'notify': {
      if (handlers.notify === undefined) return 'unavailable'
      const title = textField(body, 'title', 200)
      const text = textField(body, 'body', 1_000)
      if (title === null || text === null) throw badRequest('invalid notification')
      await handlers.notify(title, text)
      return {}
    }
    case 'save-text-as': {
      if (handlers.saveTextAs === undefined) return 'unavailable'
      const name = textField(body, 'name', 255)
      const content = body.content
      if (name === null || typeof content !== 'string' || content.length > MAX_CONTENT) throw badRequest('invalid payload')
      const saved = await handlers.saveTextAs(name, content)
      // A cancelled dialog is a successful call with no path, not an error: the
      // caller must be able to tell "user said no" from "that failed".
      return { path: saved }
    }
    case 'pick-directory': {
      if (handlers.pickDirectory === undefined) return 'unavailable'
      return { path: await handlers.pickDirectory() }
    }
    case 'open-logs': {
      if (handlers.openLogs === undefined) return 'unavailable'
      await handlers.openLogs()
      return {}
    }
    default:
      throw new Error(`unknown action ${action}`)
  }
}
