/**
 * Shared stand-in for the Connection exact-Fetch registry — the seam
 * `ctx.connection.fetch` offers to a host plugin.
 *
 * Registration goes into a table, and {@link Host.call} dispatches a Request the
 * way the shared `/api` channel does (`createSharedFetchHandler`): an exact
 * pathname with a declared method reaches the route, everything else answers the
 * channel's own 404. That is the whole carrier contract the routes can rely on —
 * the desktop transport is a byte pipe, so no socket is involved and the request
 * object a route sees (URL, method, headers, body) is the same one built here.
 *
 * Trust is NOT part of this harness: the carrier applies its Host/Origin fence
 * and browser authentication before a route handler runs, so the routes never
 * see those headers and there is nothing here to fence.
 *
 * The default {@link FakeNativeSeams} finds no kernel seam, which is the
 * "vanilla composition" case: a kernel-performed action then answers
 * `unsupported` instead of throwing.
 */

import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'
import type { DirectoryPicker, NativeSeams, SessionOpener } from '../src/native-actions.ts'
import { registerDesktopRoutes } from '../src/routes.ts'

/** JSON answer shape used by these routes. */
export interface JsonAnswer {
  status: number
  body: Record<string, unknown>
}

/** One hand-written request, in the shape the pipe carrier delivers. */
export interface CallInit {
  readonly method?: string
  readonly body?: string
  readonly headers?: Record<string, string>
}

/** A host stand-in: the plugin registers into it, and `call` dispatches for real. */
export interface Host {
  /** Dispatch one request below the `/api` channel, like the shared channel does. */
  call(path: string, init?: CallInit): Promise<JsonAnswer>
  /** Live route count, so a test can prove the disposer removed everything. */
  registered(): number
  close(): Promise<void>
}

/** Kernel seams a suite can expose (a fake `ctx.sessionController` / `ctx.directoryPicker`). */
export interface FakeNativeSeams {
  readonly opener?: SessionOpener
  readonly picker?: DirectoryPicker
}

/**
 * Serve the plugin's real routes from an in-process Fetch dispatch.
 * @param fakes - kernel seams to expose; omitted, every seam is absent.
 */
export async function startHost(fakes: FakeNativeSeams = {}): Promise<Host> {
  const table = new Map<string, { methods: Set<string>, fetch: (request: Request) => Promise<Response> }>()
  const seams: NativeSeams = { opener: () => fakes.opener, picker: () => fakes.picker }
  const connectionFetch: HostConnectionFetch = {
    register: (route) => {
      // The real registry refuses a duplicate exact path; a stub that silently
      // replaced one would hide exactly the wiring bug this suite is for.
      if (table.has(route.path)) throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`)
      table.set(route.path, { methods: new Set<string>(route.methods), fetch: route.fetch })
      return () => {
        table.delete(route.path)
        return Promise.resolve()
      }
    },
  }
  const disposeRoutes = registerDesktopRoutes(connectionFetch, seams)

  return {
    registered: () => table.size,
    call: async (path, init = {}) => {
      const url = `dsh-app://app${path}`
      const method = (init.method ?? 'GET').toUpperCase()
      const route = table.get(new URL(url).pathname)
      // The shared channel owns path and method resolution: an unregistered
      // path, or a method this route did not declare, is its 404 — never a
      // route body.
      if (route === undefined || !route.methods.has(method)) {
        return { status: 404, body: { ok: false, error: 'not found' } }
      }
      const response = await route.fetch(new Request(url, {
        method,
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(init.headers === undefined ? {} : { headers: init.headers }),
      }))
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    },
    close: async () => {
      await disposeRoutes()
    },
  }
}
