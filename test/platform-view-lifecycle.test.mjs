// The embedded Platform view's lifetime, run against a fake Electron.
//
// `PlatformView` is where the account credential lives while a usage or top-up
// page is open, and every rule about it is about what the view DOES: who it hands
// the credential to, what it clears when the document goes away, what a disposed
// instance refuses. None of that shows in a pure helper's return value, so this
// file instantiates the class with the smallest Electron that lets `open` run — a
// recording Session, a WebContentsView whose load settles at once — and asserts on
// the calls the view made.
//
// It replaces the source assertions platform-view.test.mjs used to carry for the
// same rules. Measured on those: with `dispose()` no longer marking the instance
// and the preload's main-frame guard neutralised, all 26 of the cases the file
// had then stayed green. A text assertion sees that a line exists, never that it
// runs.
//
// Two things here are deliberately NOT instant, because the rules about them are
// rules of ORDER: the document is gone only when a test says so, and a Session's
// clears can be held and released. A fake that settled everything at once could
// not tell a cleanup that waits for the document from one that races it.
//
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { beforeEach, test } from 'node:test'

const require = createRequire(import.meta.url)

// ----------------------------------------------------------------- fake Electron

/** Every Session the view asked for, by partition name (emptied before each case). */
const sessions = new Map()

class FakeWebContents extends EventEmitter {
  constructor() {
    super()
    this.mainFrame = { url: '' }
    this.session = undefined
    this.loaded = []
    this.gone = false
  }
  isDestroyed() { return this.gone }
  // `close()` only asks. The document is gone when the test says `destroy()`,
  // which is what lets a case see the cleanup waiting for it.
  close() { /* the document is still alive until destroy() */ }
  destroy() { this.gone = true; this.emit('destroyed') }
  async loadURL(url) { this.loaded.push(url); this.mainFrame.url = url }
  setWindowOpenHandler() { /* the view always denies; nothing to record */ }
}

class FakeWebContentsView {
  // Electron hands the constructor `{ webPreferences }`; the preload, the session
  // and the command-line arguments live inside that.
  constructor(options) {
    this.webPreferences = options.webPreferences
    this.webContents = new FakeWebContents()
    this.webContents.session = options.webPreferences.session
    this.visible = undefined
    this.bounds = undefined
  }
  setVisible(visible) { this.visible = visible }
  setBounds(bounds) { this.bounds = bounds }
}

/**
 * A Session as the view uses it. Every handler and every clear is recorded as it
 * STARTS; `fail` names the one clear a test wants to refuse, and `hold` keeps
 * every clear pending until the test calls `release()`.
 *
 * @param {string} name - the partition name the view asked by.
 * @returns the Session.
 */
function fakeSession(name) {
  if (sessions.has(name)) return sessions.get(name)
  const session = new EventEmitter()
  const held = []
  const step = (method) => {
    if (session.fail === method) throw new Error(`${method} refused`)
    session.calls.push(method)
    return session.hold ? new Promise((resolve) => { held.push(resolve) }) : Promise.resolve()
  }
  // The request-handler object, with its current handlers readable as properties.
  const webRequest = {
    onBeforeSendHeaders(fn) { webRequest.beforeSend = fn },
    onCompleted(fn) { webRequest.completed = fn },
    onErrorOccurred(fn) { webRequest.errorOccurred = fn },
  }
  Object.assign(session, {
    name,
    /** Which clear should fail, or null. */
    fail: null,
    /** While true, every clear records itself and then waits for `release()`. */
    hold: false,
    /** The order of the calls, open and close alike. */
    calls: [],
    /** Every `clearStorageData` argument, in order. */
    storageClears: [],
    webRequest,
    isPersistent: () => name.startsWith('persist:'),
    setPermissionRequestHandler(fn) { session.permissionRequest = fn },
    setPermissionCheckHandler(fn) { session.permissionCheck = fn },
    flushStorageData() { session.calls.push('flushStorageData') },
    closeAllConnections: async () => step('closeAllConnections'),
    clearStorageData: async (options) => { session.storageClears.push(options); await step('clearStorageData') },
    clearCache: async () => step('clearCache'),
    clearAuthCache: async () => step('clearAuthCache'),
    /** Let every held clear finish, and stop holding the ones after them. */
    release: () => {
      session.hold = false
      for (const resolve of held.splice(0)) resolve()
    },
  })
  sessions.set(name, session)
  return session
}

const electron = {
  WebContentsView: FakeWebContentsView,
  nativeTheme: { themeSource: 'system' },
  session: { fromPartition: fakeSession },
  shell: { openExternal: async () => {} },
  ipcMain: new EventEmitter(),
  BrowserWindow: class {},
}
// `dist/main/platform-view.js` requires Electron as it loads; it must get the fake.
const electronPath = require.resolve('electron')
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electron, paths: [], children: [], parent: null }
const { PlatformView, platformPartition } = require('../dist/main/platform-view.js')

beforeEach(() => { sessions.clear() })

// -------------------------------------------------------------------- fixtures

const ORIGIN = 'https://platform.deepseek.com'
const BOUNDS = { x: 0, y: 40, width: 800, height: 600 }
/** A signed-in account: its ID makes the partition persistent. */
const ACCOUNT = { origin: ORIGIN, token: 'tok-1', userId: 'uid-1' }
/** The names of the clears a cleanup runs, in the order the view starts them. */
const CLEARS = ['closeAllConnections', 'clearStorageData', 'clearCache', 'clearAuthCache']

/** Let every promise the view has already chained run up to its next wait. */
const settle = () => new Promise((resolve) => { setImmediate(resolve) })

/** The window a view belongs to, with a content view that records its children. */
function fakeOwner() {
  const owner = new EventEmitter()
  owner.webContents = new EventEmitter()
  owner.contentView = {
    children: [],
    addChildView(view) { this.children.push(view) },
    removeChildView(view) { this.children = this.children.filter((child) => child !== view) },
  }
  owner.isDestroyed = () => false
  return owner
}

/** A signed-in view. */
function signedIn(account = ACCOUNT) {
  const view = new PlatformView('C:\\app\\dist\\main\\platform-preload.js', () => 'zh_CN', () => 'dark', '0.19.9', 'win32')
  view.setSession(account)
  return view
}

/**
 * A signed-in view with a page open.
 *
 * @param {object} [account] the account to open under.
 * @returns the view, its owner, the native view and its web contents.
 */
async function opened(account) {
  const view = signedIn(account)
  const owner = fakeOwner()
  await view.open(owner, 'usage', BOUNDS)
  const native = owner.contentView.children[0]
  return { view, owner, native, contents: native.webContents }
}

/**
 * Close a view the way the process would — the document goes away — and wait for
 * the cleanup that follows.
 *
 * @param {object} open - what `opened()` returned.
 * @returns when every cleanup the close scheduled has settled.
 */
async function closed({ view, native }) {
  view.close()
  native.webContents.destroy()
  return view.closeAndWait()
}

// ------------------------------------------------------------- credential handoff

test('the credential is handed only to this view\'s own main frame, on the session\'s origin', async () => {
  const { view, contents } = await opened()
  assert.deepEqual(view.bootstrap(contents, contents.mainFrame), { origin: ORIGIN, token: 'tok-1', locale: 'zh_CN' })
  // A same-origin SUBFRAME carries the main frame's URL, so a URL check cannot
  // tell them apart: identity is compared against the main frame itself.
  assert.throws(() => view.bootstrap(contents, { url: contents.mainFrame.url }), /rejected bootstrap frame/u)
  // Another webContents, and no frame at all.
  assert.throws(() => view.bootstrap(new FakeWebContents(), contents.mainFrame), /rejected bootstrap$/u)
  assert.throws(() => view.bootstrap(contents, null), /rejected bootstrap$/u)
  // The main frame itself, navigated off the session's origin.
  const loaded = contents.mainFrame.url
  contents.mainFrame.url = 'https://evil.test/usage'
  assert.throws(() => view.bootstrap(contents, contents.mainFrame), /rejected bootstrap origin/u)
  contents.mainFrame.url = loaded
  // And nobody, once the document is gone.
  view.close()
  assert.throws(() => view.bootstrap(contents, contents.mainFrame), /rejected bootstrap$/u)
  contents.destroy()
})

test('the page is created sandboxed, with this view\'s origin on its command line', async () => {
  const { native } = await opened()
  // The preload gates the credential on that argument, so it is what the page is
  // opened with — and nothing the page could turn into Node.
  const { preload, session: browserSession, ...rest } = native.webPreferences
  assert.equal(preload, 'C:\\app\\dist\\main\\platform-preload.js')
  assert.deepEqual(rest, {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    additionalArguments: [`--dsh-platform-origin=${ORIGIN}`],
  })
  assert.equal(browserSession, sessions.get(platformPartition(ORIGIN, 'uid-1')))
  // The page asks for nothing: both permission handlers answer no.
  let granted
  browserSession.permissionRequest({}, 'camera', (answer) => { granted = answer })
  assert.equal(granted, false)
  assert.equal(browserSession.permissionCheck(), false)
})

test('a request carries this client\'s identity only on the session\'s origin, and a redirect drops it', async () => {
  const { native } = await opened({ ...ACCOUNT, requestHeaders: { 'x-deployment': 'prod' } })
  const beforeSend = native.webPreferences.session.webRequest.beforeSend
  const headersFor = (details) => {
    let answer
    beforeSend({ requestHeaders: { accept: '*/*' }, ...details }, (result) => { answer = result })
    return answer.requestHeaders
  }
  const onOrigin = headersFor({ id: 7, url: `${ORIGIN}/usage` })
  assert.equal(onOrigin['x-deployment'], 'prod')
  assert.equal(onOrigin['x-client-platform'], 'desktop-win')
  assert.equal(onOrigin.accept, '*/*')
  // The user's token reaches the page through the preload's bootstrap channel,
  // which is why a redirect cannot carry it anywhere.
  assert.ok(!JSON.stringify(onOrigin).includes('tok-1'), 'the token travelled in a header')
  // The same request, redirected to another host: everything this view injected
  // is stripped, and the page's own header stays.
  assert.deepEqual(headersFor({
    id: 7, url: 'https://elsewhere.test/lib.js', requestHeaders: { accept: '*/*', 'x-deployment': 'prod', 'x-client-platform': 'desktop-win' },
  }), { accept: '*/*' })
  // A request that was never injected is left alone.
  assert.deepEqual(headersFor({ id: 8, url: 'https://elsewhere.test/x', requestHeaders: { accept: 'text/html', 'x-deployment': 'mine' } }),
    { accept: 'text/html', 'x-deployment': 'mine' })
})

// --------------------------------------------------------------------- lifetime

test('a disposed view refuses to be resurrected', async () => {
  const { view, owner, native } = await opened()
  native.webContents.destroy()
  await view.dispose()
  await assert.rejects(view.open(owner, 'usage', BOUNDS), /platform view: disposed/u)
  // A later publication is not adopted either: the credential is gone for good.
  view.setSession(ACCOUNT)
  assert.equal(view.available, false)
})

test('closing clears what authenticates, and keeps a persisted partition\'s preferences', async () => {
  const { view, owner, native } = await opened()
  const browserSession = native.webPreferences.session
  const callsBefore = browserSession.calls.length
  await closed({ view, native })
  assert.deepEqual(owner.contentView.children, [], 'the document is detached from its window')
  // The flush first, then the four clears. The last three run together, so only
  // their presence is asserted, not their order.
  const afterClose = browserSession.calls.slice(callsBefore)
  assert.deepEqual(afterClose.slice(0, 3), ['flushStorageData', ...CLEARS.slice(0, 2)])
  assert.deepEqual([...afterClose.slice(3)].sort(), [...CLEARS.slice(2)].sort())
  // A PERSISTED partition keeps local storage (that is what makes the page's
  // preferences survive reopening) and loses everything that authenticates.
  const cleared = browserSession.storageClears.at(-1)
  assert.deepEqual(cleared, { storages: ['cookies', 'filesystem', 'indexdb', 'shadercache', 'serviceworkers', 'cachestorage'] })
  // The request handlers belong to the closed document: a stale one would inject
  // this account's headers into a page it was never given an account for.
  assert.equal(browserSession.webRequest.beforeSend, null)
})

test('a throwaway partition has no preferences worth keeping, so it is cleared whole', async () => {
  const { view, native } = await opened({ origin: ORIGIN, token: 'tok-1', userId: null })
  const browserSession = native.webPreferences.session
  await closed({ view, native })
  assert.equal(browserSession.isPersistent(), false)
  // Cleared (open and close each ran a cleanup), and every time without a storage
  // set: omitted, Electron clears everything.
  assert.equal(browserSession.storageClears.length, 2)
  assert.ok(browserSession.storageClears.every((entry) => entry === undefined))
})

test('the cleanup of a partition waits until the document using it is gone', async () => {
  const { view, native } = await opened()
  const browserSession = native.webPreferences.session
  const clearedBefore = browserSession.storageClears.length
  view.close()
  await settle()
  assert.equal(browserSession.storageClears.length, clearedBefore,
    'the partition was cleared while the document could still write to it')
  native.webContents.destroy()
  await view.closeAndWait()
  assert.equal(browserSession.storageClears.length, clearedBefore + 1)
})

test('a persisted partition is sanitized before any page loads in it', async () => {
  // A partition can carry authentication left by an UNCLEAN previous exit.
  const browserSession = fakeSession(platformPartition(ORIGIN, 'uid-1'))
  browserSession.hold = true
  const view = signedIn()
  const owner = fakeOwner()
  const opening = view.open(owner, 'usage', BOUNDS)
  await settle()
  assert.ok(browserSession.calls.includes('closeAllConnections'), 'the cleanup did not start')
  assert.deepEqual(owner.contentView.children, [], 'a page was created before the partition was clean')
  browserSession.release()
  await opening
  assert.equal(owner.contentView.children[0].webContents.loaded.length, 1)
  assert.ok(browserSession.calls.includes('clearAuthCache'), 'the page loaded before the cleanup finished')
})

test('a cleanup on the same partition waits for the one before it', async () => {
  // Without that ordering a late `clearStorageData` wipes the preferences a
  // freshly opened view has just written.
  const { view, owner, native } = await opened()
  const browserSession = native.webPreferences.session
  browserSession.hold = true
  view.close()
  native.webContents.destroy()
  await settle()
  const of = (name) => browserSession.calls.filter((call) => call === name).length
  assert.equal(of('closeAllConnections'), 2, 'the close did not start its cleanup') // one at open, one now
  const reopening = view.open(owner, 'usage', BOUNDS)
  await settle()
  assert.equal(of('closeAllConnections'), 2, 'a second cleanup started while the first was still clearing')
  browserSession.release()
  await reopening
  assert.equal(of('closeAllConnections'), 3)
})

test('a failed clear is reported to whoever waits for it, never swallowed', async () => {
  // A partition that kept its cookies would leave the credential replayable by a
  // later view, which is the one thing the cleanup exists to prevent.
  const { view, native } = await opened()
  native.webPreferences.session.fail = 'clearStorageData'
  view.close()
  native.webContents.destroy()
  await assert.rejects(view.closeAndWait(), AggregateError)
})

test('a cleanup that fails refuses to open a page in that partition', async () => {
  const browserSession = fakeSession(platformPartition(ORIGIN, 'uid-1'))
  browserSession.fail = 'clearStorageData'
  const view = signedIn()
  const owner = fakeOwner()
  await assert.rejects(view.open(owner, 'usage', BOUNDS),
    (error) => error instanceof AggregateError && error.errors.some((cause) => /clearStorageData refused/u.test(cause.message)),
    'the open must fail with the cleanup\'s own failure')
  assert.deepEqual(owner.contentView.children, [], 'a page was opened on a partition that could not be cleaned')
})

test('a download is refused, and the refusal is registered once per session', async () => {
  const { view, owner, native } = await opened()
  const browserSession = native.webPreferences.session
  assert.equal(browserSession.listenerCount('will-download'), 1)
  // A persisted partition is the SAME Session on every open, so a listener added
  // per open would accumulate forever.
  view.close()
  native.webContents.destroy()
  await view.open(owner, 'top-up', BOUNDS)
  assert.equal(browserSession.listenerCount('will-download'), 1, 'a second open added a second refusal')
  // And close() leaves it in place: the guard belongs to the session, not the view.
  const again = owner.contentView.children[0]
  view.close()
  again.webContents.destroy()
  assert.equal(browserSession.listenerCount('will-download'), 1)
  let prevented = false
  browserSession.emit('will-download', { preventDefault() { prevented = true } })
  assert.ok(prevented, 'a download from the embedded page must not silently land on disk')
})

test('a hidden window\'s page comes back on show; any other close forgets it', async () => {
  const { view, owner, contents, native } = await opened()
  // `suspend` releases the whole renderer for a surface nobody can see, and
  // REMEMBERS the page: the client overlay above the native view has no way to
  // learn the page went away, so the next show has to put the same one back.
  view.suspend()
  assert.deepEqual(owner.contentView.children, [], 'a hidden window must not keep the page alive')
  native.webContents.destroy()
  await view.resume(owner)
  const back = owner.contentView.children[0]
  assert.equal(back.webContents.loaded.at(-1), contents.loaded[0], 'the same page comes back')
  assert.deepEqual(back.bounds, BOUNDS)
  assert.equal(back.visible, true)
  // A close that is not a suspend is the user going back or signing out.
  view.close()
  back.webContents.destroy()
  await view.resume(owner)
  assert.deepEqual(owner.contentView.children, [], 'a later show must not resurrect a surface nobody asked for')
})
