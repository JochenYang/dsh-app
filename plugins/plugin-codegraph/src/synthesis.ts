/**
 * Synthesized edges: the two halves of a key, joined across files.
 *
 * Why. A parse sees names: `ipcRenderer.invoke(PLATFORM_IPC.open)` is a call to
 * a function in Electron, and `ipcMain.handle(PLATFORM_IPC.open, handler)` is
 * another. Nothing in either file says they meet — the RUNTIME joins them, on
 * the key. So `codegraph_impact` on the handler answered "no direct callers"
 * for the one caller the application actually has, and the renderer's `open()`
 * had no callee. Measured on this repository before this module: the four
 * platform IPC channels had zero edges between their two sides. The same shape
 * recurs three ways — an IPC channel, an event name, a route path — and in each
 * the key is a string literal or a dotted identifier chain that BOTH sides
 * spell identically.
 *
 * What is a fact and what is a convention. A synthesized edge is a claim about a
 * convention, not a statement the file makes, so it carries a `provenance`
 * (`edges.provenance`) and every answer that prints one says so (`⇢ ipc`). The
 * rules are deliberately narrow:
 *
 *   - `ipc`: `ipcMain.handle / on / once (K, h)` and `ipcRenderer.on / once /
 *     addListener (K, h)` against `ipcRenderer.invoke / send / sendSync / sendTo
 *     (K)` and `<x>.webContents.send (K)` / `event.sender.send (K)`. The receivers
 *     are fixed names, so the pairing is exact, and it covers both directions.
 *   - `event`: `<r>.on / once / addListener / subscribe (K, h)` against
 *     `<r>.emit / trigger / fire / publish / dispatch (K)`, with the SAME
 *     receiver text `r` on both sides (`this` never counts) and a key that is
 *     specific — a dotted chain, or a literal with a separator (`:` `-` `/` `.`),
 *     or SCREAMING_CASE. `stream.on('data')` and `process.on('exit')` pair with
 *     nothing: their receivers are excluded and their keys are prose words.
 *   - `route`: `<app>.get / post / put / patch / delete / all / use ('/p', h)`
 *     against `fetch('/p')` (bare or through a global) and
 *     `axios|http|request|api|client .<method>('/p')`, whatever their other
 *     arguments. The receiver decides the side — clients are never registrations —
 *     and a registration's handler argument has to be a handler
 *     (`installsHandler`), because `app.post('/add', payload)` on a client
 *     instance named `app` is the same syntax as a server's.
 *
 * A registration is stored (`registrations`) rather than kept in memory: the
 * incremental pass rebuilds only the changed file's edges, and the dispatch it
 * must link lives on after the file that registered was last parsed. The
 * converse is the pass's standing limitation, shared with every parsed edge: a
 * registration that appears, moves or disappears after the dispatching file was
 * last parsed reaches that file's edges only when the file is parsed again (or
 * when the target it named retires). A rebuild makes it exact.
 *
 * An inline handler has no declaration to point at, so one is synthesized
 * (kind `handler`, the extent of the registering call); a route gets one too
 * (kind `route`, `GET /x`), so `codegraph_impact` on a named handler lists the
 * route among its callers and a `fetch` of the path has a target.
 *
 * @module @dsh-app/plugin-codegraph/synthesis
 */

import type { DatabaseSync } from 'node:sqlite'
import type { EdgeRecord, Registration, RegistrationKind, SymbolRecord } from './store.ts'
import { NAME_RESOLVABLE } from './store.ts'

/** A call as the parse reports it (`ParsedCall` in parse.ts): the same optional fields. */
export interface Call {
  readonly name: string
  readonly line: number
  /** The call's last line; absent for the schema-file scanners, which read no tree. */
  readonly endLine?: number | undefined
  readonly owner: string | undefined
  readonly receiver?: string | undefined
  readonly key?: string | undefined
  readonly handler?: string | undefined
}

/** What one file's calls add up to. */
export interface Synthesis {
  /** Declarations to add to the file: one per inline handler and per route. */
  readonly symbols: readonly SymbolRecord[]
  /** What the file registers, for the dispatch side of other files. */
  readonly registrations: readonly Registration[]
}

/** `ipcMain.handle(K, h)`: the receiver is a fixed name, the method says register. */
const IPC_REGISTER = new Set(['handle', 'on', 'once'])
/** `ipcRenderer.on(K, h)`: a renderer's listener for what the main process sends it. */
const IPC_RENDERER_REGISTER = new Set(['on', 'once', 'addListener'])
/** `ipcRenderer.invoke(K)`, and `webContents.send(K)` to a renderer. */
const IPC_DISPATCH = new Set(['invoke', 'send', 'sendSync', 'sendTo'])
const EVENT_REGISTER = new Set(['on', 'once', 'addListener', 'subscribe'])
const EVENT_DISPATCH = new Set(['emit', 'trigger', 'fire', 'publish', 'dispatch'])
/**
 * Receivers whose events are the platform's, not the project's. `stream.on('data')`
 * is how Node streams work; pairing it with some `bus.emit('data')` would be
 * a fiction. `this` is out because two unrelated classes both say `this`, and a
 * pairing on the receiver's TEXT would join them; `ipcRenderer` is out because its
 * listeners are the other half of an IPC channel, not a project event.
 */
const EVENT_RECEIVERS_EXCLUDED = new Set([
  'this', 'process', 'stream', 'stdout', 'stderr', 'stdin', 'child', 'socket', 'server', 'res', 'req', 'response', 'request',
  'window', 'document', 'el', 'element', 'emitter', 'worker', 'ipcRenderer', 'ipcMain',
])
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'use'])
/** `fetch(K)` and `<client>.get(K)`: a call that names a path and installs nothing. */
const HTTP_CLIENTS = /^(axios|http|https|request|api|\$http|\$api|client|fetch)$/u
/** The globals a renderer calls `fetch` through. */
const GLOBALS = /^(window|globalThis|self|global)$/u
/** The kinds a route's handler may be declared with; a value is a client's payload. */
const CALLABLE = new Set(['function', 'method', 'handler'])
/** `app.use('/x', usersRouter)`: a router is a value that installs. */
const ROUTER_NAME = /router$/iu

/** The method half of a member call (`ipcMain.handle` → `handle`); the call's own name otherwise. */
function methodOf(call: Call): string {
  const at = call.name.lastIndexOf('.')
  return at < 0 ? call.name : call.name.slice(at + 1)
}

/**
 * Whether an event key is specific enough to pair on. `user:created`,
 * `Events.user.created`, `USER_CREATED` are; `data`, `error`, `change` are words
 * every emitter uses, and two files using the same word mean nothing.
 */
export function specificEventKey(key: string): boolean {
  return key.includes('.') || /[:\-/.]/u.test(key) || /^[A-Z0-9_]+$/u.test(key)
}

/** The node a registration points at, before any project-wide resolution. */
function targetOf(path: string, key: string, handler: string | undefined, local: ReadonlyMap<string, string>, inline: string): string {
  if (handler === undefined || handler === INLINE) return inline
  return local.get(handler) ?? `file:${path}`
}

/** What the parse writes for a function passed inline. */
export const INLINE = '(inline)'

/**
 * The base id of the declaration synthesized for an inline handler; a second one
 * under the same key gets `~1`, `~2`… from {@link uniqueId}. `~` because a key is
 * a string literal's content and may hold any character, including `#` — the
 * ordinal is made unique against the ids already taken, not by a separator no
 * key can contain.
 */
export function handlerId(path: string, key: string): string {
  return `${path}#handler:${key}`
}

/** The base id of the route synthesized from `app.get('/x', h)`. */
export function routeId(path: string, method: string, key: string): string {
  return `${path}#route:${method}:${key}`
}

/**
 * `base`, or `base~n` for the first n that is not taken yet.
 *
 * Two routes to one path in one file (`app.get('/x', a)` and `router.get('/x', b)`)
 * and two inline handlers under one key would otherwise write the same primary
 * key twice, and the symbols INSERT is a bare INSERT: the second would fail the
 * whole pass. Every id the file already declares is in `taken`, so a synthesized
 * id can never take a parsed declaration's either.
 */
function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let n = 1; ; n += 1) {
    const candidate = `${base}~${String(n)}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * Source text as a row of an answer may carry it: comments out, whitespace
 * folded, every control and format character replaced, and no longer than a
 * declaration's head. The receiver of a member call is an expression (`express
 * .Router()`, `(getBus())`), and the signature it lands in reaches the model
 * under the USER's role in the request pack and the search note.
 */
function cleanText(text: string): string {
  return clip(fold(text.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(^|[\s(,;])\/\/.*$/gmu, '$1')))
}

/**
 * A key as both sides of a pairing must spell it: a string literal's content or
 * a dotted chain, folded and cleaned, never stripped as code — a key is data, and
 * `//` or `/*` inside one is part of the channel's name, not a comment. Undefined
 * when blank once cleaned.
 */
function sanitizeKey(key: string): string | undefined {
  const cleaned = clip(fold(key))
  return cleaned === '' ? undefined : cleaned
}

function fold(text: string): string {
  return text.replace(/\s+/gu, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '?').trim()
}

/** The longest a synthesized name or signature; the same bound as a parsed head. */
const MAX_SYNTHETIC_TEXT = 200

function clip(text: string): string {
  return text.length > MAX_SYNTHETIC_TEXT ? `${text.slice(0, MAX_SYNTHETIC_TEXT - 1)}…` : text
}

/** A key quoted for a signature the way JavaScript would write it. */
const quoted = (key: string): string => JSON.stringify(key)

/**
 * Classify one file's calls: the declarations it gains and what it registers.
 *
 * A registration whose handler is a NAME the file declares resolves now; a name
 * the file imports is left as the file node for {@link refineRegistrationTargets},
 * which runs once every file's symbols are in the graph. The same key registered
 * twice in one file makes two declarations, told apart by {@link uniqueId}.
 *
 * @param path - the file, project-relative POSIX.
 * @param calls - the file's calls with their keys and handlers.
 * @param localSymbols - the symbols the parse declared in this file.
 * @returns the synthesized declarations and the registrations.
 */
export function synthesizeFile(path: string, calls: readonly Call[], localSymbols: readonly SymbolRecord[], imported: ReadonlySet<string> = new Set()): Synthesis {
  const local = new Map<string, SymbolRecord>()
  for (const symbol of localSymbols) if (!local.has(symbol.name)) local.set(symbol.name, symbol)
  const localIds = new Map<string, string>()
  for (const [name, symbol] of local) localIds.set(name, symbol.id)
  const taken = new Set(localSymbols.map(symbol => symbol.id))
  const symbols: SymbolRecord[] = []
  const registrations: Registration[] = []
  for (const call of calls) {
    const kind = registrationKind(call, local, imported)
    const key = keyOf(call)
    if (kind === undefined || key === undefined) continue
    const method = methodOf(call)
    // `ipcMain.handle(K, h)`: the receiver is part of what the signature says.
    // The parse reports a member call's name as the method and the receiver
    // apart; a hand-built call may carry the whole chain already.
    const receiver = cleanText(call.receiver ?? '')
    const callee = receiver === '' || call.name.startsWith(`${receiver}.`) ? call.name : `${receiver}.${call.name}`
    let target: string
    if (kind === 'route') {
      target = uniqueId(routeId(path, method, key), taken)
      taken.add(target)
      symbols.push({
        id: target,
        path,
        name: cleanText(`${method.toUpperCase()} ${key}`),
        kind: 'route',
        line: call.line,
        // The whole registering call: an inline handler's body is inside it, and
        // `codegraph_context` on the route reads exactly that.
        endLine: Math.max(call.line, call.endLine ?? call.line),
        parent: undefined,
        signature: cleanText(`${callee}(${quoted(key)}, ${call.handler ?? '…'})`),
        doc: '',
      })
    } else {
      let inline = ''
      if (call.handler === INLINE) {
        inline = uniqueId(handlerId(path, key), taken)
        taken.add(inline)
        symbols.push({
          id: inline,
          path,
          name: key,
          kind: 'handler',
          line: call.line,
          endLine: Math.max(call.line, call.endLine ?? call.line),
          parent: undefined,
          signature: cleanText(`${callee}(${quoted(key)}, ${INLINE})`),
          doc: '',
        })
      }
      target = targetOf(path, key, call.handler, localIds, inline)
    }
    registrations.push({
      path,
      line: call.line,
      kind,
      key,
      receiver: call.receiver ?? '',
      target,
      handler: call.handler ?? '',
    })
  }
  return { symbols, registrations }
}

/**
 * The key a call names, as both sides of a pairing must spell it. Undefined when
 * the call names no key or the key is blank once cleaned. Cut to the length of a
 * head, so a key cannot spend an answer's budget on itself.
 */
function keyOf(call: Call): string | undefined {
  return call.key === undefined ? undefined : sanitizeKey(call.key)
}

/**
 * Whether a call registers a key, and for which pairing.
 *
 * @param call - the call.
 * @param local - the file's own declarations, by name, for the route rule below.
 * @param imported - the names the file's import clauses bring into scope.
 */
function registrationKind(call: Call, local: ReadonlyMap<string, SymbolRecord>, imported: ReadonlySet<string>): RegistrationKind | undefined {
  // A registration binds a key to a handler, so it has to have both: `ipcMain.handle(K)`
  // throws at runtime, and `bus.on(K)` binds nothing.
  const key = keyOf(call)
  if (key === undefined || call.handler === undefined) return undefined
  const method = methodOf(call)
  const receiver = call.receiver ?? ''
  // Both directions of Electron's IPC: the main process registers handlers, and
  // a renderer registers a listener for what the main process sends it.
  if (receiver === 'ipcMain' && IPC_REGISTER.has(method)) return 'ipc'
  if (receiver === 'ipcRenderer' && IPC_RENDERER_REGISTER.has(method)) return 'ipc'
  // The listener methods above take a handler by definition, whatever the name
  // resolves to (a parameter passed in is a handler too). `get` / `post` are shared
  // with HTTP clients, so only a route has to prove its second argument is one —
  // and `this`, which names a different object in every class, registers nothing.
  if (ROUTE_METHODS.has(method) && key.startsWith('/') && receiver !== 'this' && !HTTP_CLIENTS.test(receiver) && installsHandler(call.handler, local, imported)) return 'route'
  if (EVENT_REGISTER.has(method) && receiver !== '' && !EVENT_RECEIVERS_EXCLUDED.has(receiver) && specificEventKey(key)) return 'event'
  return undefined
}

/** Whether a declaration can be called: a function-like kind, or a value bound to a function. */
function isCallable(kind: string, signature: string): boolean {
  return CALLABLE.has(kind) || /=>|\bfunction\b/u.test(signature)
}

/**
 * Whether a registration's handler argument is a handler and not a payload.
 *
 * `app.post('/add', handler)` (a server) and `app.post('/add', payload)` (an HTTP
 * client instance that happens to be called `app`) are the same syntax. What tells
 * them apart is what the name is in the file: an inline function, a declaration the
 * file knows to be callable (including `const h = (req, res) => …`, which the
 * grammar records as a variable), a router (`app.use('/x', usersRouter)`), or a
 * name an import clause brings in — resolved against the whole graph by
 * {@link refineRegistrationTargets}. A parameter, a member chain (`req.body`) or
 * a value the file declares is a payload, and the call is a dispatch.
 */
function installsHandler(handler: string, local: ReadonlyMap<string, SymbolRecord>, imported: ReadonlySet<string>): boolean {
  if (handler === INLINE) return true
  const declared = local.get(handler)
  if (declared !== undefined) return isCallable(declared.kind, declared.signature ?? '') || ROUTER_NAME.test(handler)
  // A member chain (`handlers.users`) is a payload; only a bare name can be an import.
  return !handler.includes('.') && imported.has(handler)
}

/**
 * Whether a call dispatches a key, and for which pairing.
 *
 * Decided by the receiver and the method, never by the arguments: a dispatch
 * carries a payload (`invoke(K, page)`, `emit(K, user)`, `fetch('/x', init)`,
 * `axios.post('/x', body)`), and a payload that is a plain identifier is
 * indistinguishable from a handler at the syntax level. Routes need no
 * exception: `registrationKind` already refuses every HTTP-client receiver, so
 * `fetch` and the clients are dispatches here whatever their second argument.
 */
function dispatchKind(call: Call): RegistrationKind | undefined {
  const key = keyOf(call)
  if (key === undefined) return undefined
  const method = methodOf(call)
  const receiver = call.receiver ?? ''
  if (receiver === 'ipcRenderer' && IPC_DISPATCH.has(method)) return 'ipc'
  // The main process sending TO a renderer: `view.webContents.send(K)`, and the
  // `event.sender.send(K)` with which a handler answers.
  if (method === 'send' && /(?:^|\.)(?:webContents|sender)$/u.test(receiver)) return 'ipc'
  if (key.startsWith('/')) {
    // `fetch` bare or through a global (`window.fetch`, `globalThis.fetch`).
    if (method === 'fetch' && (receiver === '' || GLOBALS.test(receiver))) return 'route'
    if (receiver !== '' && HTTP_CLIENTS.test(receiver) && ROUTE_METHODS.has(method)) return 'route'
    return undefined
  }
  if (EVENT_DISPATCH.has(method) && receiver !== '' && !EVENT_RECEIVERS_EXCLUDED.has(receiver) && specificEventKey(key)) return 'event'
  return undefined
}

/**
 * The edges a file's dispatches make, against the registrations the graph holds.
 *
 * An event pairs only with a registration on the same receiver; IPC and routes
 * pair on the key alone, their receivers being fixed names or any. The edge
 * starts where a call edge starts — the enclosing declaration, or the file.
 *
 * @param calls - the file's calls.
 * @param fileId - the file node, for a dispatch at file scope.
 * @param lookup - the registrations under a key, as the graph stores them.
 * @returns the synthesized reference edges.
 */
export function dispatchEdges(calls: readonly Call[], fileId: string, lookup: (kind: RegistrationKind, key: string) => readonly Registration[]): EdgeRecord[] {
  const edges: EdgeRecord[] = []
  for (const call of calls) {
    const kind = dispatchKind(call)
    const key = keyOf(call)
    if (kind === undefined || key === undefined) continue
    for (const registration of lookup(kind, key)) {
      if (kind === 'event' && registration.receiver !== (call.receiver ?? '')) continue
      edges.push({ from: call.owner ?? fileId, to: registration.target, kind: 'references', line: call.line, narrowed: false, provenance: kind })
    }
  }
  return edges
}

/**
 * A handler name to the declaration it means, for a registration in `path`.
 *
 * The file's own declaration first, then — only when exactly one callable in the
 * whole graph carries the name — that one. A shared name keeps the file node,
 * which is where the registering call is, rather than guessing among declarations.
 * Exported for the indexer, which resolves route handlers the same way.
 */
export function resolveHandler(db: DatabaseSync, handler: string, path: string): string | undefined {
  type Row = { id: string, kind: string, signature: string }
  const local = db.prepare(`SELECT id, kind, signature FROM symbols WHERE path = ? AND name = ? AND ${NAME_RESOLVABLE} AND line > 0 ORDER BY line LIMIT 8`).all(path, handler) as Row[]
  const callable = local.find(row => isCallable(row.kind, row.signature))
  if (callable !== undefined) return callable.id
  if (local.length > 0) return undefined
  const found = db.prepare(`SELECT id, kind, signature FROM symbols WHERE name = ? AND ${NAME_RESOLVABLE} LIMIT 2`).all(handler) as Row[]
  if (found.length !== 1 || !isCallable(found[0]!.kind, found[0]!.signature)) return undefined
  return found[0]!.id
}

/**
 * Point every registration whose handler is an imported name at that name's
 * declaration, now that the whole graph is present — and pull back the ones
 * whose declaration went away.
 *
 * Phase 1 knows a file's own symbols; a handler imported from a sibling file is
 * only findable once the sibling's symbols are written, which may be after this
 * file in the same pass. The reverse also happens: the handler is renamed or its
 * file forgotten, its id retires, and a target still naming it would send every
 * later dispatch to a node that no longer exists — so a target that names no
 * symbol goes back to the file node first, and is resolved again here if the name
 * still means something.
 *
 * @param db - the open database.
 */
export function refineRegistrationTargets(db: DatabaseSync): void {
  db.exec("UPDATE registrations SET target = 'file:' || path WHERE target NOT LIKE 'file:%' AND NOT EXISTS (SELECT 1 FROM symbols s WHERE s.id = registrations.target)")
  type Row = { path: string, handler: string }
  const rows = db.prepare("SELECT path, handler FROM registrations WHERE target = 'file:' || path AND handler <> '' AND handler <> ?").all(INLINE) as Row[]
  const update = db.prepare('UPDATE registrations SET target = ? WHERE path = ? AND handler = ? AND target = ?')
  for (const row of rows) {
    const resolved = resolveHandler(db, row.handler, row.path)
    if (resolved === undefined) continue
    update.run(resolved, row.path, row.handler, `file:${row.path}`)
  }
}

/**
 * The edges from a route to the handler it installs, once the handler resolves.
 *
 * This is what lets `codegraph_impact` on a named handler list `GET /x` among
 * its callers: the route is a declaration, the handler is its callee.
 *
 * @param registrations - the registrations of one pass's files.
 * @param resolve - a handler name and its registering file to the symbol id, or undefined.
 * @returns the route-to-handler edges.
 */
export function routeEdges(registrations: readonly Registration[], resolve: (handler: string, path: string) => string | undefined): EdgeRecord[] {
  const edges: EdgeRecord[] = []
  for (const registration of registrations) {
    if (registration.kind !== 'route' || registration.handler === '' || registration.handler === INLINE) continue
    const handler = resolve(registration.handler, registration.path)
    if (handler === undefined || handler === registration.target) continue
    edges.push({ from: registration.target, to: handler, kind: 'references', line: registration.line, narrowed: false, provenance: 'route' })
  }
  return edges
}
