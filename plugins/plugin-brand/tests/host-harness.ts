/**
 * Shared wire-level host stand-in for plugin-brand's route suites.
 *
 * The plugin registers into this stub through the same structural seam the
 * host web server offers, and a real `node:http` server then serves those
 * routes on loopback — so fences, methods, status codes and JSON shapes are
 * all exercised over the network rather than by calling handlers directly.
 *
 * `rawRequest` exists because `fetch` refuses to set some headers (`Host`),
 * and the fence's non-loopback case can only be tested by hand.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { registerDesktopRoutes } from '../src/routes.ts'

/** JSON answer shape used by these routes. */
export interface JsonAnswer {
  status: number
  body: Record<string, unknown>
}

/** A host stand-in: the plugin registers into it, and it serves HTTP for real. */
export interface Host {
  url: string
  port: number
  /** Live route count, so a test can prove the disposer removed everything. */
  registered(): number
  close(): Promise<void>
}

interface StubRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** Serve the plugin's real routes from a real loopback server. */
export async function startHost(): Promise<Host> {
  const table: StubRoute[] = []
  const disposeRoutes = registerDesktopRoutes({
    register: (route) => {
      table.push(route)
      return () => {
        const index = table.indexOf(route)
        if (index >= 0) table.splice(index, 1)
      }
    },
  })
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const match = table.find((route) => (route.kind === 'exact'
      ? route.path === pathname
      : pathname === route.path || pathname.startsWith(`${route.path}/`)))
    if (match === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"ok":false,"error":"no route"}')
      return
    }
    void match.handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    registered: () => table.length,
    close: async () => {
      disposeRoutes()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        // Keep-alive sockets from fetch would otherwise hold the server open.
        server.closeAllConnections()
      })
    },
  }
}

/** One hand-written request, needed where fetch cannot set a header (`Host`). */
export function rawRequest(port: number, request: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    socket.setEncoding('utf8')
    socket.setTimeout(10_000, () => {
      socket.destroy()
      reject(new Error('raw request timed out'))
    })
    let received = ''
    socket.on('connect', () => socket.write(request))
    socket.on('data', (chunk: string) => { received += chunk })
    socket.on('end', () => resolve(received))
    socket.on('error', reject)
  })
}

/** Status line + body of a hand-written response. */
export function parseRaw(response: string): JsonAnswer {
  const [head, body = ''] = response.split('\r\n\r\n')
  const status = Number(/^HTTP\/1\.1 (\d{3})/u.exec(head ?? '')?.[1] ?? 0)
  return { status, body: JSON.parse(body === '' ? '{}' : body) as Record<string, unknown> }
}
