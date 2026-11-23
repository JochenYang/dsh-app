/**
 * The synthesized edges, on shapes: what pairs with what, what is refused, and
 * what the graph gains (an inline handler's declaration, a route's).
 *
 * The rules are conventions about keys (`synthesis.ts`'s header), so these pin
 * the three pairings and every refusal that keeps a convention from becoming a
 * fiction: a Node stream's `'data'`, an emitter with another name, a route
 * registration mistaken for a dispatch. The store round trip is exercised too,
 * because the incremental pass depends on a registration outliving the parse
 * that made it.
 *
 * @module plugin-codegraph/tests/synthesis
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forgetFile, openGraph, registrationsFor, registrationsIn, replaceFile, type FileRecord, type Graph, type SymbolRecord } from '../src/store.ts'
import { dispatchEdges, handlerId, refineRegistrationTargets, routeEdges, routeId, synthesizeFile, type Call } from '../src/synthesis.ts'
import { removeTree } from '../../../scripts/lib/remove-tree.mjs'

const scratch: string[] = []
const graphs: Graph[] = []

after(async () => {
  for (const graph of graphs.splice(0)) {
    try { graph.close() } catch { /* already closed */ }
  }
  for (const dir of scratch.splice(0)) await removeTree(dir)
})

function graph(): Graph {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cg-synth-'))
  scratch.push(dir)
  const opened = openGraph(join(dir, 'graph.db'))
  graphs.push(opened)
  return opened
}

/** A call as the parse reports it; only what a case needs is spelled out. */
const call = (name: string, line: number, over: Partial<Call> = {}): Call => ({ name, line, owner: undefined, receiver: undefined, key: undefined, handler: undefined, ...over })

const file = (path: string): FileRecord => ({ path, mtime: 1, size: 1, hash: 'h', lang: 'typescript' })
const sym = (path: string, name: string, kind: SymbolRecord['kind'] = 'function', line = 1): SymbolRecord => ({
  id: `${path}#${kind}:${name}`, path, name, kind, line, endLine: line, parent: undefined,
})

describe('registration shapes', () => {
  it('pairs an ipcMain registration with an ipcRenderer dispatch by the key, named or inline', () => {
    const main = sym('src/main.ts', 'onOpen')
    const synthesized = synthesizeFile('src/main.ts', [
      call('ipcMain.handle', 10, { receiver: 'ipcMain', key: 'PLATFORM_IPC.open', handler: 'onOpen' }),
      call('ipcMain.handle', 12, { receiver: 'ipcMain', key: 'PLATFORM_IPC.close', handler: '(inline)', endLine: 20 }),
    ], [main])
    assert.equal(synthesized.registrations.length, 2)
    assert.deepEqual(synthesized.registrations.map(reg => [reg.kind, reg.key, reg.target, reg.receiver]), [
      ['ipc', 'PLATFORM_IPC.open', 'src/main.ts#function:onOpen', 'ipcMain'],
      ['ipc', 'PLATFORM_IPC.close', handlerId('src/main.ts', 'PLATFORM_IPC.close'), 'ipcMain'],
    ])
    assert.deepEqual(synthesized.symbols.map(symbol => [symbol.kind, symbol.name, symbol.line, symbol.endLine, symbol.signature]), [
      ['handler', 'PLATFORM_IPC.close', 12, 20, 'ipcMain.handle("PLATFORM_IPC.close", (inline))'],
    ], 'the key is quoted the way JavaScript would write it')

    const preload = 'src/preload.ts'
    const edges = dispatchEdges([
      call('ipcRenderer.invoke', 40, { receiver: 'ipcRenderer', key: 'PLATFORM_IPC.open', owner: 'src/preload.ts#function:open' }),
      call('ipcRenderer.send', 41, { key: 'PLATFORM_IPC.close', receiver: 'ipcRenderer' }),
      call('ipcRenderer.invoke', 42, { receiver: 'ipcRenderer', key: 'PLATFORM_IPC.unknown' }),
      call('win.webContents.send', 43, { key: 'PLATFORM_IPC.close', receiver: 'win.webContents' }),
    ], `file:${preload}`, (kind, key) => synthesized.registrations.filter(reg => reg.kind === kind && reg.key === key))
    assert.deepEqual(edges, [
      { from: 'src/preload.ts#function:open', to: 'src/main.ts#function:onOpen', kind: 'references', line: 40, narrowed: false, provenance: 'ipc' },
      { from: `file:${preload}`, to: handlerId('src/main.ts', 'PLATFORM_IPC.close'), kind: 'references', line: 41, narrowed: false, provenance: 'ipc' },
      { from: `file:${preload}`, to: handlerId('src/main.ts', 'PLATFORM_IPC.close'), kind: 'references', line: 43, narrowed: false, provenance: 'ipc' },
    ])
  })

  it('pairs events only on the same receiver and a specific key', () => {
    const bus = sym('src/bus.ts', 'onUser')
    const synthesized = synthesizeFile('src/bus.ts', [
      call('bus.on', 5, { receiver: 'bus', key: 'user:created', handler: 'onUser' }),
      call('bus.once', 6, { receiver: 'bus', key: 'Events.ready', handler: '(inline)' }),
      call('bus.on', 7, { receiver: 'bus', key: 'data', handler: 'onUser' }),
      call('stream.on', 8, { receiver: 'stream', key: 'data', handler: 'onUser' }),
      call('process.on', 9, { receiver: 'process', key: 'uncaughtException', handler: '(inline)' }),
      call('bus.subscribe', 11, { receiver: 'bus', key: 'USER_REMOVED', handler: 'onUser' }),
    ], [bus])
    assert.deepEqual(synthesized.registrations.map(reg => reg.key), ['user:created', 'Events.ready', 'USER_REMOVED'], 'prose keys and platform receivers register nothing')
    const lookup = (kind: string, key: string) => synthesized.registrations.filter(reg => reg.kind === kind && reg.key === key)
    const edges = dispatchEdges([
      call('bus.emit', 30, { receiver: 'bus', key: 'user:created', owner: 'src/api.ts#function:create' }),
      call('other.emit', 31, { receiver: 'other', key: 'user:created' }),
      call('bus.trigger', 32, { receiver: 'bus', key: 'Events.ready' }),
      call('bus.publish', 33, { receiver: 'bus', key: 'USER_REMOVED' }),
    ], 'file:src/api.ts', lookup)
    assert.deepEqual(edges.map(edge => [edge.from, edge.to, edge.provenance]), [
      ['src/api.ts#function:create', 'src/bus.ts#function:onUser', 'event'],
      ['file:src/api.ts', handlerId('src/bus.ts', 'Events.ready'), 'event'],
      ['file:src/api.ts', 'src/bus.ts#function:onUser', 'event'],
    ], 'another emitter with the same event name is a different channel')
  })

  it('makes a route a declaration, links it to its handler, and pairs a fetch of the path with it', () => {
    const handler = sym('src/routes.ts', 'getUser')
    const router = sym('src/routes.ts', 'usersRouter', 'variable')
    const synthesized = synthesizeFile('src/routes.ts', [
      call('app.get', 20, { receiver: 'app', key: '/users/:id', handler: 'getUser', endLine: 22 }),
      call('app.use', 23, { receiver: 'app', key: '/users', handler: 'usersRouter' }),
      call('app.get', 24, { receiver: 'app', key: '/health' }),
    ], [handler, router])
    assert.deepEqual(synthesized.registrations.map(reg => [reg.key, reg.target, reg.handler]), [
      ['/users/:id', routeId('src/routes.ts', 'get', '/users/:id'), 'getUser'],
      ['/users', routeId('src/routes.ts', 'use', '/users'), 'usersRouter'],
    ], 'a call with no handler installs nothing: it is a dispatch')
    assert.deepEqual(synthesized.symbols.map(symbol => [symbol.id, symbol.kind, symbol.name, symbol.line, symbol.endLine]), [
      [routeId('src/routes.ts', 'get', '/users/:id'), 'route', 'GET /users/:id', 20, 22],
      [routeId('src/routes.ts', 'use', '/users'), 'route', 'USE /users', 23, 23],
    ])
    const resolve = (name: string): string | undefined => [handler, router].find(symbol => symbol.name === name)?.id
    assert.deepEqual(routeEdges(synthesized.registrations, name => resolve(name)).map(edge => [edge.from, edge.to, edge.provenance]), [
      [routeId('src/routes.ts', 'get', '/users/:id'), 'src/routes.ts#function:getUser', 'route'],
      [routeId('src/routes.ts', 'use', '/users'), 'src/routes.ts#variable:usersRouter', 'route'],
    ])
    const lookup = (kind: string, key: string) => synthesized.registrations.filter(reg => reg.kind === kind && reg.key === key)
    assert.deepEqual(dispatchEdges([
      call('fetch', 50, { key: '/users/:id', owner: 'src/client.ts#function:load' }),
      call('axios.post', 51, { receiver: 'axios', key: '/users/:id' }),
      call('client.get', 52, { receiver: 'client', key: '/health' }),
      call('app.get', 53, { receiver: 'app', key: '/users/:id', handler: 'later' }),
    ], 'file:src/client.ts', lookup).map(edge => [edge.from, edge.to]), [
      ['src/client.ts#function:load', routeId('src/routes.ts', 'get', '/users/:id')],
      ['file:src/client.ts', routeId('src/routes.ts', 'get', '/users/:id')],
    ])
  })

  it('tells two registrations of one key in one file apart, and leaves an imported handler to the refinement', () => {
    const synthesized = synthesizeFile('src/a.ts', [
      call('ipcMain.handle', 3, { receiver: 'ipcMain', key: 'K', handler: '(inline)' }),
      call('ipcMain.handle', 9, { receiver: 'ipcMain', key: 'K', handler: '(inline)', endLine: 12 }),
      call('ipcMain.handle', 14, { receiver: 'ipcMain', key: 'K2', handler: 'importedHandler' }),
    ], [], new Set(['importedHandler']))
    assert.deepEqual(synthesized.registrations.map(reg => reg.target), [
      handlerId('src/a.ts', 'K'),
      `${handlerId('src/a.ts', 'K')}~1`,
      'file:src/a.ts',
    ], 'a key may hold any character, so the ordinal is a suffix nothing else took')
    assert.deepEqual(synthesized.symbols.map(symbol => [symbol.id, symbol.line, symbol.endLine]), [
      [handlerId('src/a.ts', 'K'), 3, 3],
      [`${handlerId('src/a.ts', 'K')}~1`, 9, 12],
    ])
    // For a route, a name no import clause brings in is a parameter or a member of
    // one: a payload, not a handler the refinement should go looking for.
    const parameter = synthesizeFile('src/api.ts', [call('app.post', 14, { receiver: 'app', key: '/k', handler: 'token' })], [])
    assert.deepEqual(parameter.registrations, [])
  })

  it('never writes one id twice: two routes to one path in one file, and a key that ends like an ordinal', () => {
    // Both were a primary-key collision that failed the whole pass.
    const router = sym('src/api.ts', 'auth')
    const routes = synthesizeFile('src/api.ts', [
      call('app.use', 3, { receiver: 'app', key: '/api', handler: 'auth' }),
      call('app.use', 4, { receiver: 'app', key: '/api', handler: 'auth' }),
    ], [router])
    assert.deepEqual(routes.symbols.map(symbol => symbol.id), [routeId('src/api.ts', 'use', '/api'), `${routeId('src/api.ts', 'use', '/api')}~1`])
    const ordinals = synthesizeFile('src/a.ts', [
      call('ipcMain.handle', 3, { receiver: 'ipcMain', key: 'k', handler: '(inline)' }),
      call('ipcMain.handle', 5, { receiver: 'ipcMain', key: 'k~1', handler: '(inline)' }),
    ], [])
    assert.equal(new Set(ordinals.symbols.map(symbol => symbol.id)).size, 2, `${ordinals.symbols.map(symbol => symbol.id).join(', ')}`)
  })

  it('takes a client call with arguments for a dispatch, and an arrow-constant for a handler', () => {
    // `fetch('/x', init)` and `axios.post('/x', body)` are the common shapes; the
    // second argument is a payload, and deciding by it dropped every one of them.
    const registrations = synthesizeFile('src/api.ts', [
      call('app.get', 3, { receiver: 'app', key: '/users', handler: 'listUsers' }),
    ], [{ ...sym('src/api.ts', 'listUsers', 'variable'), signature: 'const listUsers = (req, res) =>' }])
    assert.deepEqual(registrations.registrations.map(reg => reg.key), ['/users'], 'a const bound to an arrow function is callable')
    const lookup = (kind: string, key: string) => registrations.registrations.filter(reg => reg.kind === kind && reg.key === key)
    assert.deepEqual(dispatchEdges([
      call('fetch', 10, { key: '/users', handler: 'init' }),
      call('axios.post', 11, { receiver: 'axios', key: '/users', handler: 'body' }),
    ], 'file:src/c.ts', lookup).map(edge => edge.to), [routeId('src/api.ts', 'get', '/users'), routeId('src/api.ts', 'get', '/users')])
  })

  it('joins the renderer-side listener with the main-side send, and refuses `this`', () => {
    const listener = synthesizeFile('src/preload.ts', [
      call('ipcRenderer.on', 5, { receiver: 'ipcRenderer', key: 'PLATFORM_IPC.localeChanged', handler: '(inline)' }),
      call('this.on', 6, { receiver: 'this', key: 'user:created', handler: '(inline)' }),
    ], [])
    assert.deepEqual(listener.registrations.map(reg => [reg.kind, reg.key]), [['ipc', 'PLATFORM_IPC.localeChanged']], '`this` names a different object in every class')
    const edges = dispatchEdges([
      call('view.webContents.send', 20, { receiver: 'view.webContents', key: 'PLATFORM_IPC.localeChanged' }),
      call('event.sender.send', 21, { receiver: 'event.sender', key: 'PLATFORM_IPC.localeChanged' }),
      call('this.emit', 22, { receiver: 'this', key: 'user:created' }),
    ], 'file:src/main.ts', (kind, key) => listener.registrations.filter(reg => reg.kind === kind && reg.key === key))
    assert.deepEqual(edges.map(edge => [edge.to, edge.provenance]), [[handlerId('src/preload.ts', 'PLATFORM_IPC.localeChanged'), 'ipc'], [handlerId('src/preload.ts', 'PLATFORM_IPC.localeChanged'), 'ipc']])
  })

  it('cleans the receiver, the key and the signature like a head, and never strips a key as code', () => {
    // A receiver is an expression: multi-line, commented, possibly carrying a
    // bidi override. A key is DATA: `//` inside one is the channel's name.
    const synthesized = synthesizeFile('src/a.ts', [
      call('get', 3, {
        receiver: 'express\n  .Router() /* the app\u202E */',
        key: '  /a\u0001b\n c  ',
        handler: '(inline)',
      }),
      call('ipcMain.handle', 5, { receiver: 'ipcMain', key: '//odd/channel', handler: '(inline)' }),
      call('ipcMain.handle', 7, { receiver: 'ipcMain', key: 'x'.repeat(400), handler: '(inline)' }),
    ], [], new Set())
    assert.equal(synthesized.symbols[0]?.signature, 'express .Router().get("/a?b c", (inline))', 'comments out, whitespace folded, control and format characters replaced')
    assert.equal(synthesized.registrations[0]?.receiver, 'express\n  .Router() /* the app\u202E */', 'the raw receiver is kept for the pairing, cleaned only for display')
    assert.equal(synthesized.registrations[1]?.key, '//odd/channel', 'a key beginning with // is a key')
    assert.equal(synthesized.registrations[2]?.key?.length, 200, 'a key is cut to the length of a head')
    assert.ok(synthesized.registrations[2]?.key?.endsWith('…'))
    assert.equal(synthesized.symbols[2]?.name.length, 200)
  })

  it('takes a global fetch, and refuses a route registered on `this`', () => {
    const registrations = synthesizeFile('src/api.ts', [call('app.get', 3, { receiver: 'app', key: '/users', handler: 'listUsers' })], [sym('src/api.ts', 'listUsers')])
    const lookup = (kind: string, key: string) => registrations.registrations.filter(reg => reg.kind === kind && reg.key === key)
    assert.deepEqual(dispatchEdges([
      call('window.fetch', 10, { receiver: 'window', key: '/users', handler: 'init' }),
      call('globalThis.fetch', 11, { receiver: 'globalThis', key: '/users' }),
    ], 'file:src/c.ts', lookup).map(edge => edge.to), [routeId('src/api.ts', 'get', '/users'), routeId('src/api.ts', 'get', '/users')])
    const onThis = synthesizeFile('src/c.ts', [call('this.get', 12, { receiver: 'this', key: '/users', handler: 'cb' })], [sym('src/c.ts', 'cb')])
    assert.deepEqual(onThis.registrations, [], 'an instance method call on `this` is a client call, not a server route')
  })

  it('does not take an HTTP client call for a route registration when the second argument is a payload', () => {
    // Measured on this repository: `app.post('/add', payload)` on a client instance
    // named `app`, with `payload` a value the file declares. The same syntax as a
    // server route, told apart only by what the name is in the file.
    const payload = sym('src/api.ts', 'payload', 'variable')
    const client = synthesizeFile('src/api.ts', [call('app.post', 5, { receiver: 'app', key: '/add', handler: 'payload' })], [payload])
    assert.deepEqual(client.registrations, [], 'a value is a payload: the call dispatches')
    assert.deepEqual(client.symbols, [])
    const server = synthesizeFile('src/api.ts', [
      call('app.post', 5, { receiver: 'app', key: '/add', handler: 'addTodo' }),
      call('app.use', 6, { receiver: 'app', key: '/todos', handler: 'todosRouter' }),
      call('app.get', 7, { receiver: 'app', key: '/x', handler: '(inline)' }),
    ], [sym('src/api.ts', 'addTodo'), payload, sym('src/api.ts', 'todosRouter', 'variable')])
    assert.deepEqual(server.registrations.map(reg => reg.key), ['/add', '/todos', '/x'], 'a callable, a router and an inline function install')
  })
})

describe('registrations in the graph', () => {
  const fileRow = (path: string): FileRecord => ({ path, mtime: 1, size: 1, hash: 'h', lang: 'typescript' })

  it('outlive the pass that made them; an imported handler resolves once the graph has it, and the resolution is local first and reversible', () => {
    const g = graph()
    // File A registers a handler it imports; file B declares it. Phase 1 writes
    // A before B exists, so the target is the file node until the refinement.
    const a = synthesizeFile('src/a.ts', [call('ipcMain.handle', 5, { receiver: 'ipcMain', key: 'K', handler: 'shared' })], [], new Set(['shared']))
    replaceFile(g.db, fileRow('src/a.ts'), [...a.symbols], [], a.registrations)
    assert.deepEqual(registrationsFor(g.db, 'ipc', 'K').map(reg => reg.target), ['file:src/a.ts'])
    replaceFile(g.db, fileRow('src/b.ts'), [sym('src/b.ts', 'shared')], [])
    refineRegistrationTargets(g.db)
    assert.deepEqual(registrationsFor(g.db, 'ipc', 'K').map(reg => reg.target), ['src/b.ts#function:shared'], 'a unique name resolves once it is in the graph')

    // The dispatch in a third file, re-parsed alone in a later pass, finds it.
    const edges = dispatchEdges([call('ipcRenderer.invoke', 30, { receiver: 'ipcRenderer', key: 'K', owner: 'src/c.ts#function:go' })], 'file:src/c.ts', (kind, key) => registrationsFor(g.db, kind, key))
    assert.deepEqual(edges.map(edge => edge.to), ['src/b.ts#function:shared'])
    assert.equal(registrationsIn(g.db, 'src/a.ts').length, 1)

    // A second declaration of the name makes it ambiguous again: the refinement
    // leaves what it cannot resolve alone rather than picking one.
    replaceFile(g.db, fileRow('src/a.ts'), [...a.symbols], [], a.registrations)
    replaceFile(g.db, fileRow('src/d.ts'), [sym('src/d.ts', 'shared')], [])
    refineRegistrationTargets(g.db)
    assert.deepEqual(registrationsFor(g.db, 'ipc', 'K').map(reg => reg.target), ['file:src/a.ts'])

    // The handler's file goes away: the target naming a retired id is pulled
    // back to the file node instead of sending later dispatches to nothing.
    replaceFile(g.db, fileRow('src/a.ts'), [...a.symbols], [], a.registrations)
    refineRegistrationTargets(g.db)
    forgetFile(g.db, 'src/b.ts')
    forgetFile(g.db, 'src/d.ts')
    g.db.prepare("UPDATE registrations SET target = 'src/b.ts#function:shared' WHERE key = 'K'").run()
    refineRegistrationTargets(g.db)
    assert.deepEqual(registrationsFor(g.db, 'ipc', 'K').map(reg => reg.target), ['file:src/a.ts'])

    // Local first: the registering file's own declaration wins over a namesake
    // elsewhere, exactly as a call in that file would resolve.
    replaceFile(g.db, fileRow('src/b.ts'), [sym('src/b.ts', 'shared')], [])
    replaceFile(g.db, fileRow('src/d.ts'), [sym('src/d.ts', 'shared')], [])
    replaceFile(g.db, fileRow('src/a.ts'), [...a.symbols, sym('src/a.ts', 'shared')], [], a.registrations)
    refineRegistrationTargets(g.db)
    assert.deepEqual(registrationsFor(g.db, 'ipc', 'K').map(reg => reg.target), ['src/a.ts#function:shared'])
  })

  it('go with their file when it is forgotten or re-registered without them', () => {
    const g = graph()
    const a = synthesizeFile('src/a.ts', [call('ipcMain.handle', 5, { receiver: 'ipcMain', key: 'K', handler: '(inline)' })], [])
    replaceFile(g.db, fileRow('src/a.ts'), [...a.symbols], [], a.registrations)
    assert.equal(registrationsIn(g.db, 'src/a.ts').length, 1)
    replaceFile(g.db, fileRow('src/a.ts'), [], [])
    assert.equal(registrationsIn(g.db, 'src/a.ts').length, 0, 'a re-parse with no registration removes the old one')
  })
})
