/**
 * The one `onBeforeSendHeaders` listener this shell may install.
 *
 * Electron keeps only the LAST listener per session — verified on 44.4.1 with a
 * two-filter probe: a request matched by the first filter arrived with neither
 * hook's headers, while the second hook's request arrived stamped, so the second
 * `onBeforeSendHeaders` call replaces the first rather than adding to it. That
 * is not a theoretical hazard in this app: the shell has two jobs for this hook
 * (stamp its own action requests, authenticate the client's stream handshake),
 * and when they were installed as two calls the later one silently disabled the
 * earlier — every desktop action began answering 403 (`no initiator stamp`) the
 * moment the stream hook landed.
 *
 * So the listeners are composed here instead of registered independently: one
 * install, with a filter covering both jobs and a dispatch that decides which
 * jobs apply to a request. Anything added later must join this dispatch; a
 * second `install*` function is a bug by construction.
 *
 * @module shell/session-hooks
 */

/** One rule: its URL filter, and what it does with a matching request. */
export interface SessionHeaderRule {
  /** `webRequest` filter this rule wants to see. */
  readonly urls: readonly string[]
  /**
   * Handle one matching request.
   * @param details - the request as Electron reports it.
   * @param callback - the same callback `webRequest` gave the listener.
   * @returns true when this rule owned the request (it called `callback`).
   */
  readonly handle: (details: Electron.OnBeforeSendHeadersListenerDetails, callback: HeaderCallback) => boolean
}

/** The `webRequest` callback shape, named for the rule signatures. */
export type HeaderCallback = (response: Electron.BeforeSendResponse) => void

/** The slice of `Session` this module needs, as a test seam. */
export interface HeaderListenerSession {
  readonly webRequest: Pick<Electron.Session['webRequest'], 'onBeforeSendHeaders'>
}

/**
 * Install every rule behind a single registered listener.
 *
 * The filter is the union of the rules' filters (Electron takes a URL pattern
 * list), and each request is offered to the rules in order until one claims it.
 * A request no rule claims leaves with `{}` — the untouched headers, which is
 * what a request outside both jobs deserves.
 *
 * @param session - the session the app window lives in.
 * @param rules - the rules, in the order they should get first refusal.
 */
export function installSessionHeaderRules(session: Pick<Electron.Session, 'webRequest'>, rules: readonly SessionHeaderRule[]): void {
  const urls = [...new Set(rules.flatMap((rule) => [...rule.urls]))]
  session.webRequest.onBeforeSendHeaders({ urls }, (details, callback) => {
    for (const rule of rules) {
      if (rule.handle(details, callback)) return
    }
    callback({})
  })
}
