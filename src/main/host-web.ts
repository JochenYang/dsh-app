/**
 * The dsh desktop host's WEB transport (host package 0.1.6-alpha.2 and later):
 * the child serves the same routes the `dsh web` server did on an authenticated
 * loopback port and reports that URL over the IPC channel, instead of exporting
 * them over fd3/fd4 byte pipes.
 *
 * Three pieces live here, all of them Fetch-shaped so they can be driven
 * against a real local server in the tests — no child process, no Electron:
 *
 *   - the authentication exchange ({@link authenticateHostWeb}): the reported
 *     URL carries a one-shot token, and the client is expected to trade it for
 *     a `set-cookie` answer. The token is not a credential to keep: nothing
 *     here logs, stores or forwards it, only the cookie it bought.
 *   - the forward ({@link forwardHostWebRequest}): one `dsh-app://app/…`
 *     request becomes a request against the child's origin, with the
 *     hop-specific headers rewritten the way a proxy rewrites them, and the
 *     index document rewritten to carry the child's boot rows
 *     ({@link renderHostIndex}).
 *   - that rendering, because this shell's window loads the UI from its own
 *     origin with no preload of its own: unlike the upstream Electron app there
 *     is no second channel that could apply the rows page-side.
 *
 * What the module deliberately does not do is bind, name or probe a port of its
 * own: the child owns the listener, and every call here is one HTTP round trip
 * to it.
 */

/** Document region a rendered row lands in: after the opening head or body tag. */
export type HostInjectionPlacement = 'head' | 'body'

/**
 * One boot row of the child's injection table, as `webserver/index-inject`
 * emits it (index rows are JSON-serializable data for exactly this reason: the
 * same table feeds a served renderer and a page-side interpreter).
 */
export type HostIndexInjection =
  /** Assign a JSON-serializable value to a `globalThis` property, ahead of later rows. */
  | { readonly kind: 'global'; readonly name: string; readonly value: unknown }
  /** Inline classic script. `text` must not contain `</script`, which would close the element early. */
  | { readonly kind: 'script'; readonly placement: HostInjectionPlacement; readonly text: string }
  /** External classic script, executed in table order. */
  | { readonly kind: 'script-src'; readonly placement: HostInjectionPlacement; readonly src: string }
  /** Advisory preload for an external classic script. */
  | { readonly kind: 'script-preload'; readonly src: string }
  /** A `<style>` element in the head. `text` must not contain `</style`. */
  | { readonly kind: 'style'; readonly text: string }
  /** Raw markup fragment. */
  | { readonly kind: 'html'; readonly placement: HostInjectionPlacement; readonly html: string }

/** Result of the authentication exchange. */
export interface HostWebAuthentication {
  /** Origin of the reported URL; its path, query and token are dropped. */
  readonly origin: string
  /** Value for the `cookie` header of every request against that origin. */
  readonly cookie: string
}

/** Everything one forward needs: where the child is, and what the document needs. */
export interface HostWebSession extends HostWebAuthentication {
  /** Boot rows the child collected in its `ready` message. */
  readonly injections: readonly HostIndexInjection[]
  /** Origin the window loads the UI from; a request named by another origin is refused. */
  readonly appOrigin: string
}

/**
 * Creates the boot-readiness deferred ahead of the rows.
 *
 * The client entry awaits `globalThis.__DSH_BOOT_READY__?.promise` only when
 * the deferred exists, so the served document creates it before any row runs;
 * the tail below settles it. Both statements are `??=`-safe, so a document
 * carrying either one twice is still correct.
 */
const BOOT_READY_MARKUP = '<script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()</script>'

/** Settles `__DSH_BOOT_READY__` after the last row, creating it when the boot row is absent. */
const BOOT_READY_TAIL = '<script>(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()</script>'

/**
 * Marker of a document that already carries the rendered boot table.
 *
 * The client module graph row is what makes the window boot at all, and the
 * child renders this very table into its own `/` and `/index.html` answers
 * (its frontend-static route runs the webserver's renderer). Rendering the
 * table a second time would run every script row twice — a duplicated module
 * graph, a duplicated theme patch — so a document holding the marker is passed
 * through exactly as the child sent it.
 */
const RENDERED_TABLE_MARKER = 'globalThis["__DSH_BOOT__"]'

/**
 * Global the gateway reads its stream base URL from.
 *
 * `remoteStreamUrl()` builds `ws://<streamBaseUrl>/<mux path>` and falls back to
 * the page's own origin — `dsh-app://app` here, a scheme a WebSocket cannot
 * upgrade, so a client left to the fallback retries forever against an origin
 * that never answers a handshake (measured: `[connection] connection lost,
 * retry #1`, no session list). Upstream's desktop bootstrap sets this global
 * from its own preload; this shell has no preload, so the boot document carries
 * it as a row and the session's `ws://127.0.0.1/*` rewrite authenticates the
 * handshake it produces (see `host-stream-auth.ts`).
 */
const TRANSPORT_GLOBAL = '__DSH_TRANSPORT__'

/** Request headers that describe the hop to us rather than the target host. */
const HOP_LOCAL_REQUEST_HEADERS = ['host', 'origin', 'cookie', 'sec-fetch-site']

/**
 * Response headers the forwarded response must not keep: undici already
 * decoded the body, so a `content-encoding`/`content-length` pair describes
 * bytes that no longer exist, and a `set-cookie` from the child is the host's
 * own session state rather than something the app origin may set.
 */
const HOP_LOCAL_RESPONSE_HEADERS = ['content-encoding', 'content-length', 'set-cookie']

/**
 * `RequestInit` plus Node's own half-duplex flag. The DOM lib's `RequestInit`
 * has no `duplex`, because a browser cannot stream a request body; Node's fetch
 * refuses to send one without it.
 */
type NodeFetchInit = RequestInit & { readonly duplex: 'half' }

/** Paths whose document the boot rows belong in. */
function isIndexPath(pathname: string): boolean {
  return pathname === '/' || pathname === '/index.html'
}

/** Whether a response is the index document this shell may rewrite. */
function isHtmlResponse(response: Response): boolean {
  return response.status >= 200 && response.status <= 299
    && (response.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html')
}

/** Escape a row value before placing it in a quoted HTML attribute. */
function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Read a string field of a row, naming the row when it is missing. */
function rowText(row: Record<string, unknown>, field: string, kind: string): string {
  const value = row[field]
  if (typeof value !== 'string') {
    throw new Error(`dsh host: an index injection row of kind "${kind}" has no ${field}`)
  }
  return value
}

/** Read a placement field, defaulting nothing: a row that has one must carry a known one. */
function rowPlacement(row: Record<string, unknown>, kind: string): HostInjectionPlacement {
  const placement = row.placement
  if (placement !== 'head' && placement !== 'body') {
    throw new Error(`dsh host: an index injection row of kind "${kind}" has no head/body placement`)
  }
  return placement
}

/** Render one row to markup with its placement. */
function renderRow(row: HostIndexInjection | Record<string, unknown>): { placement: HostInjectionPlacement; markup: string } {
  const kind = isRecord(row) && typeof row.kind === 'string' ? row.kind : undefined
  switch (kind) {
    case 'global': {
      // `<` is escaped inside the JSON so a row-controlled string cannot close
      // the script element early.
      const name = JSON.stringify(rowText(row, 'name', kind)).replaceAll('<', '\\u003c')
      const value = (row as { value?: unknown }).value === undefined
        ? 'undefined'
        : JSON.stringify((row as { value?: unknown }).value).replaceAll('<', '\\u003c')
      return { placement: 'head', markup: `<script>globalThis[${name}] = ${value}</script>` }
    }
    case 'script':
      return { placement: rowPlacement(row, kind), markup: `<script>${rowText(row, 'text', kind)}</script>` }
    case 'script-src':
      return {
        placement: rowPlacement(row, kind),
        markup: `<script src="${escapeHtmlAttribute(rowText(row, 'src', kind))}"></script>`,
      }
    case 'script-preload':
      return {
        placement: 'head',
        markup: `<link rel="preload" as="script" href="${escapeHtmlAttribute(rowText(row, 'src', kind))}">`,
      }
    case 'style':
      return { placement: 'head', markup: `<style>${rowText(row, 'text', kind)}</style>` }
    case 'html':
      return { placement: rowPlacement(row, kind), markup: rowText(row, 'html', kind) }
    default:
      throw new Error(`dsh host: unknown index injection row kind ${JSON.stringify(kind ?? null)}`)
  }
}

/** Insert `markup` into `html` at `at`. */
function splice(html: string, at: number, markup: string): string {
  return `${html.slice(0, at)}${markup}${html.slice(at)}`
}

/** Insert `markup` right after the opening head tag, or ahead of a headless document. */
function insertAfterHead(html: string, markup: string): string {
  const open = /<head(?:\s[^>]*)?>/iu.exec(html)
  // A document without a head still gets the markup ahead of its first script:
  // prepending is the only placement the parser reads as "before everything".
  return open === null ? `${markup}${html}` : splice(html, open.index + open[0].length, markup)
}

/**
 * The row this shell contributes to every boot document: where the gateway
 * opens its stream.
 *
 * `ownsHost` and the shape mirror the global upstream's desktop bootstrap sets
 * from its preload; the value is JSON so a row cannot break out of the script
 * element, with `<` escaped the way the child escapes its own rows.
 *
 * @param streamBaseUrl - origin of the running host.
 */
function transportMarkup(streamBaseUrl: string): string {
  const value = JSON.stringify({ ownsHost: true, streamBaseUrl }).replaceAll('<', '\\u003c')
  return `<script>globalThis.${TRANSPORT_GLOBAL} = ${value}</script>`
}

/**
 * Render the child's boot rows into an index document: head rows immediately
 * after the opening head tag (led by the boot-readiness deferred), body rows
 * immediately after the opening body tag, and the readiness tail after the last
 * body row.
 *
 * @param html - the document as the child served it.
 * @param rows - the injection table from the child's `ready` message.
 * @returns the document with every row rendered.
 * @throws when a row cannot be rendered: a table this shell does not understand
 *   is a boot failure the window would otherwise show as a blank page.
 */
export function renderHostIndex(html: string, rows: readonly HostIndexInjection[], streamBaseUrl?: string): string {
  let head = BOOT_READY_MARKUP
  if (streamBaseUrl !== undefined) head += transportMarkup(streamBaseUrl)
  let body = ''
  for (const row of rows) {
    const rendered = renderRow(row)
    if (rendered.placement === 'head') head += rendered.markup
    else body += rendered.markup
  }
  body += BOOT_READY_TAIL
  const out = insertAfterHead(html, head)
  const openBody = /<body(?:\s[^>]*)?>/iu.exec(out)
  // A body-less fragment receives the rows at the end, where the parser has
  // already synthesized a body.
  return openBody === null ? `${out}${body}` : splice(out, openBody.index + openBody[0].length, body)
}

/**
 * Trade the child's launch URL for a session cookie.
 *
 * The exchange is deliberately manual: the URL answers `303` with a
 * `set-cookie`, and following the redirect would land on the application with
 * a token that was already spent. Only the cookie PAIR is kept — the rest of
 * the header carries attributes that belong to the host's own session.
 *
 * @param url - the authenticated URL from the child's `ready` message.
 * @returns the host origin and the cookie for later requests.
 * @throws when the exchange answers anything else, including a `303` without a
 *   cookie: without one, every forwarded request would be refused.
 */
export async function authenticateHostWeb(url: string): Promise<HostWebAuthentication> {
  const response = await fetch(url, { redirect: 'manual' })
  const cookie = response.headers.get('set-cookie')
  await response.body?.cancel()
  if (response.status !== 303 || cookie === null) {
    throw new Error(`dsh host: web transport authentication failed (status ${String(response.status)}, cookie ${cookie === null ? 'missing' : 'present'})`)
  }
  const end = cookie.indexOf(';')
  return { origin: new URL(url).origin, cookie: end < 0 ? cookie : cookie.slice(0, end) }
}

/**
 * Validate the injection table of a `ready` message.
 *
 * An absent table is a hard failure rather than an empty one: the window cannot
 * boot without the module graph row, so a host that reports no table would
 * produce a page that hangs instead of an error that says so. Kinds are only
 * checked for being strings here; rendering is what refuses what it cannot
 * render (see {@link renderHostIndex}), so one unrecognized row cannot turn a
 * started host into a failed start.
 *
 * @param value - the raw `injections` field of the child's `ready` message.
 * @returns the rows, in child order.
 * @throws when it is not an array of objects carrying a string `kind`.
 */
export function parseHostInjections(value: unknown): HostIndexInjection[] {
  if (!Array.isArray(value)) {
    throw new Error('dsh host: the web transport reported ready without an index injection table')
  }
  return value.map((row, index) => {
    if (!isRecord(row) || typeof row.kind !== 'string') {
      throw new Error(`dsh host: index injection row ${String(index)} is not a row`)
    }
    return row as unknown as HostIndexInjection
  })
}

/** Does this request need the rows rendered into its response body? */
function wantsRenderedIndex(request: Request): boolean {
  if (request.method === 'HEAD') return false
  try {
    return isIndexPath(new URL(request.url).pathname)
  } catch {
    return false
  }
}

/**
 * Rewrite the child's answer to one `dsh-app://app/…` request.
 *
 * Forwarding through a proxy is where headers lie: `host` names the child, not
 * the request's target; `origin`/`sec-fetch-site` describe the window's own
 * origin, which the child would refuse; and the request's own `cookie` (none
 * today) must not shadow the session cookie the exchange bought.
 *
 * @param request - the protocol request, body and abort signal included.
 * @param session - host origin, cookie, boot rows and the origin to fence against.
 * @returns the child's response, body streamed, with the index document
 *   carrying the boot rows and a foreign origin refused outright.
 */
export async function forwardHostWebRequest(request: Request, session: HostWebSession): Promise<Response> {
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== session.appOrigin) return new Response(null, { status: 403 })
  const source = new URL(request.url)
  const target = new URL(session.origin)
  target.pathname = source.pathname
  target.search = source.search
  const headers = new Headers(request.headers)
  for (const name of HOP_LOCAL_REQUEST_HEADERS) headers.delete(name)
  headers.set('cookie', session.cookie)
  const init: NodeFetchInit = {
    method: request.method,
    headers,
    body: request.body,
    signal: request.signal,
    // A streaming request body needs the half-duplex mode; a body-less request
    // ignores it. `manual` keeps the child's own redirects out of the window.
    duplex: 'half',
    redirect: 'manual',
  }
  const response = await fetch(target, init)
  const outgoing = new Headers(response.headers)
  for (const name of HOP_LOCAL_RESPONSE_HEADERS) outgoing.delete(name)
  if (!wantsRenderedIndex(request) || !isHtmlResponse(response)) {
    return new Response(response.body, { status: response.status, headers: outgoing })
  }
  const html = await response.text()
  outgoing.set('content-type', 'text/html; charset=utf-8')
  if (html.includes(RENDERED_TABLE_MARKER)) {
    // The child already rendered its own table, so only this shell's own row is
    // added: rendering the table twice would run every boot script twice.
    return new Response(insertAfterHead(html, transportMarkup(session.origin)), { status: response.status, headers: outgoing })
  }
  return new Response(renderHostIndex(html, session.injections, session.origin), { status: response.status, headers: outgoing })
}
