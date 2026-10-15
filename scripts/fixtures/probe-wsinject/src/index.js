/**
 * Probe fixture (never shipped): the sibling that GATES on `webServer`.
 *
 * Its whole body is one marker route. If the plugin activates, the route answers
 * 200 and `webServer` exists; if the service is absent, cordis never activates
 * this entry, the route 404s, and the host log says so. That is the empirical
 * form of "does a plugin that waits for `webServer` activate at all".
 *
 * Bundled into `lib/index.js` by `./build.mjs`; linked into the booted profile by
 * `scripts/probe-routes.cjs`. Nothing else reads it.
 */

export const name = 'probe-wsinject'

/** The gate under test. */
export const inject = ['connection', 'webServer']

/**
 * @param ctx - the host plugin context, `webServer` guaranteed by the gate.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/plugins/dsh-app/probe-wsinject/marker',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => new Response(JSON.stringify({
      activated: true,
      serviceCtor: typeof ctx.webServer.constructor === 'function' ? ctx.webServer.constructor.name : null,
      port: typeof ctx.webServer.port === 'number' ? ctx.webServer.port : null,
      register: typeof ctx.webServer.register,
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  }), 'probe-wsinject: marker route')
}
