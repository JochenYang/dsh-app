/**
 * Probe fixture (never shipped): the host half that answers the route-carrier
 * questions from HTTP responses alone.
 *
 *   1. `ctx.connection.fetch.register({ path })` — the carrier's own doc says
 *      `exact`. `/tree` must answer, `/tree/a/b/c.js` must not.
 *   2. the handler is `(request: Request) => Promise<Response>`, so it CAN build
 *      a 206. `/tree` with a `Range` header answers one, and `/stream` answers a
 *      `ReadableStream` whose chunks are 400ms apart — the only way to tell a
 *      streamed body from a buffered one.
 *   3. `ctx.get('webServer')` at apply time, and — through the optional
 *      `ctx.inject(['webServer'], …)` door, which does NOT gate activation — the
 *      same service once it is available. Both answers, plus whether a
 *      `kind: 'prefix'` route registered on it serves a deep sub-path, are
 *      reported by `/facts`.
 *
 * Every fact is captured into one mutable object that `/facts` serialises, so a
 * reading is whatever the process really saw rather than a re-derivation.
 *
 * Bundled into `lib/index.js` by `./build.mjs`; linked into the booted profile by
 * `scripts/probe-routes.cjs`. Nothing else reads it.
 */

/** Bytes `/tree` serves, and the whole of the Range arithmetic. */
const TREE_BODY = 'ABCDEFGHIJ'

/** Service facts, read by `/facts`. */
const facts = {
  immediate: null,
  injected: null,
  prefixRoute: null,
  exactRoute: null,
  prefixSubpathObserved: [],
}

/** A service's observable shape, or `{ present: false }` when it is not there. */
function describeService(service) {
  if (service === undefined || service === null) return { present: false }
  let members = []
  try {
    const proto = Object.getPrototypeOf(service) ?? {}
    members = [...new Set([...Object.keys(service), ...Object.getOwnPropertyNames(proto)])].sort()
  } catch (error) {
    members = [`<unreadable: ${String(error && error.message)}>`]
  }
  return {
    present: true,
    ctor: typeof service.constructor === 'function' ? service.constructor.name : null,
    port: typeof service.port === 'number' ? service.port : null,
    host: typeof service.host === 'string' ? service.host : null,
    register: typeof service.register,
    members,
  }
}

/** One `Range: bytes=a-b` / `bytes=a-` slice, or the whole body when there is no usable range. */
function rangedResponse(request) {
  const range = request.headers.get('range')
  if (range === null) {
    return new Response(TREE_BODY, {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'accept-ranges': 'bytes',
        'content-length': String(TREE_BODY.length),
        'x-probe-route': 'tree',
        'x-probe-range-seen': 'none',
      },
    })
  }
  const match = /^bytes=(\d+)-(\d*)$/u.exec(range.trim())
  if (match === null) {
    return new Response('unsatisfiable', { status: 416, headers: { 'x-probe-range-seen': range } })
  }
  const start = Number(match[1])
  const end = match[2] === '' ? TREE_BODY.length - 1 : Number(match[2])
  const slice = TREE_BODY.slice(start, end + 1)
  return new Response(slice, {
    status: 206,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'accept-ranges': 'bytes',
      'content-range': `bytes ${String(start)}-${String(end)}/${String(TREE_BODY.length)}`,
      'content-length': String(slice.length),
      'x-probe-route': 'tree',
      'x-probe-range-seen': range,
    },
  })
}

/**
 * A body that is only ever a stream: three chunks, 400ms apart.
 *
 * `cache-control: no-transform` is the carrier's own documented escape from its
 * gzip middleware, which would otherwise buffer an unknown-length body and make
 * the measurement say "buffered" about a stream that was never buffered.
 */
function streamingResponse() {
  const encoder = new TextEncoder()
  const chunks = ['CHUNK-ONE;', 'CHUNK-TWO;', 'CHUNK-THREE;']
  const stream = new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        await new Promise((resolve) => setTimeout(resolve, 400))
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-transform',
      'x-probe-stream': 'yes',
    },
  })
}

/** `webServer` handler: answers the request's own pathname, so a prefix is provable. */
function webServerHandler(request, response) {
  const pathname = new URL(request.url ?? '/', 'http://x').pathname
  facts.prefixSubpathObserved.push(pathname)
  const body = `PROBE-PREFIX:${pathname}`
  response.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'x-probe-webserver': 'prefix',
    'content-length': String(Buffer.byteLength(body)),
  })
  response.end(body)
}

export const name = 'probe-routes'

/**
 * `connection` only. `webServer` is deliberately NOT injected here — this half
 * must activate whether or not that service exists, so its absence is a reading
 * rather than a dead plugin (the sibling `@dsh-app/probe-wsinject` is the one
 * that gates on it).
 */
export const inject = ['connection']

/**
 * Register the probe's routes and capture every fact the run is judged on.
 *
 * @param ctx - the host plugin context.
 */
export function apply(ctx) {
  facts.immediate = describeService(ctx.get('webServer'))

  // The optional door: runs only when the service appears, and — unlike `inject`
  // — never holds this plugin back.
  ctx.inject(['webServer'], (scoped) => {
    const service = scoped.webServer
    facts.injected = describeService(service)
    if (service === undefined || typeof service.register !== 'function') return
    try {
      service.register({ kind: 'prefix', path: '/probe-tree', handler: webServerHandler })
      facts.prefixRoute = 'registered'
    } catch (error) {
      facts.prefixRoute = `failed: ${String(error && error.message)}`
    }
    try {
      service.register({
        kind: 'exact',
        path: '/probe-exact',
        handler: (request, response) => {
          response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-probe-webserver': 'exact' })
          response.end('PROBE-EXACT')
        },
      })
      facts.exactRoute = 'registered'
    } catch (error) {
      facts.exactRoute = `failed: ${String(error && error.message)}`
    }
  })

  ctx.effect(() => {
    const disposers = [
      ctx.connection.fetch.register({
        path: '/api/plugins/dsh-app/probe-routes/tree',
        methods: ['GET', 'HEAD'],
        requestBody: 'buffered',
        fetch: async (request) => rangedResponse(request),
      }),
      ctx.connection.fetch.register({
        path: '/api/plugins/dsh-app/probe-routes/stream',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => streamingResponse(),
      }),
      ctx.connection.fetch.register({
        path: '/api/plugins/dsh-app/probe-routes/facts',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => new Response(JSON.stringify(facts), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      }),
    ]
    return async () => {
      for (const dispose of disposers) await dispose()
    }
  }, 'probe-routes: api routes')
}
