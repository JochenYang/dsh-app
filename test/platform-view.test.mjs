// The embedded Platform view's contract, and the two preloads' exposure surface.
//
// The account surface only exists when the app document sees `window.dshDesktop`
// (the kernel's `ui-settings-account` returns early without it), and the embedded
// usage / top-up page authenticates through the view's own preload. Both are
// security-relevant, so the rules that matter are pinned here rather than left to
// review: the session payload is untrusted input, the bounds come from the page,
// the page NAME is a whitelist, and the app preload exposes exactly one key.
//
// Two kinds of case live here. Most call the exported functions, or run a built
// preload, and assert on what comes back. The ones titled `source rule:` assert
// the shape of a source file instead: they guard wiring in `index.ts` and
// `updater.ts`, which cannot be booted in a test, and are tripwires for the
// defects their comments record (docs/agents/testing.md, "Source rules").
//
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const { readPlatformSession } = require('../dist/main/desktop-host.js')
const {
  PLATFORM_IPC, isAppFrame, mergePlatformCookies, platformBounds, platformClientHeaders, platformClientMetadata, platformPage, platformPartition,
} = require('../dist/main/platform-view.js')

// ------------------------------------------------------------ app-frame check
//
// This predicate shipped WRONG once: it compared `new URL(frameUrl).origin` to
// the app URL, and a custom scheme has no registrable origin — measured,
// `new URL('dsh-app://app/index.html').origin` is the STRING "null". Every
// Platform IPC therefore answered "rejected sender", and the embedded usage page,
// having loaded fine, failed its first request with "操作未完成". The predicate is
// pure and exported for exactly this reason: the failure was invisible to unit
// tests that only covered the input parsers.

test('the app document is recognised by scheme and host, not by origin', () => {
  // The real frame URL, and the shapes the shell's own pages use.
  assert.equal(isAppFrame('dsh-app://app/index.html'), true)
  assert.equal(isAppFrame('dsh-app://app/'), true)
  assert.equal(isAppFrame('dsh-app://app/index.html#/settings'), true)
  assert.equal(isAppFrame('dsh-app://app/some/deep/path?q=1'), true)
  // The regression itself, stated as a fact: the origin of that URL is not a
  // usable identity, so anything comparing origins must not be used here.
  assert.equal(new URL('dsh-app://app/index.html').origin, 'null')
})

test('nothing else is mistaken for the app document', () => {
  // The splash document is the shell's own file: page, but not the app page.
  assert.equal(isAppFrame('file:///D:/app/dist/static/startup.html'), false)
  // Another host on the same scheme (a future shell page), another scheme, and a
  // lookalike hostname that merely STARTS with "app".
  assert.equal(isAppFrame('dsh-app://shell/index.html'), false)
  assert.equal(isAppFrame('https://app/index.html'), false)
  assert.equal(isAppFrame('dsh-app://app.evil.test/index.html'), false)
  assert.equal(isAppFrame('dsh-app://evil.test/app'), false)
  // An iframe on a foreign origin, and a data/blob document.
  assert.equal(isAppFrame('https://evil.test/frame.html'), false)
  assert.equal(isAppFrame('about:blank'), false)
  assert.equal(isAppFrame('data:text/html,<p>x'), false)
  // Absent or unparseable input is a refusal, never a pass.
  assert.equal(isAppFrame(undefined), false)
  assert.equal(isAppFrame(''), false)
  assert.equal(isAppFrame('not a url'), false)
})

// ------------------------------------------------------------ session payload

test('a session is read only from a well-formed payload', () => {
  const full = readPlatformSession({
    origin: 'https://platform.deepseek.com',
    token: 'tok-123',
    userId: 'uid-9',
    embeddedPageDist: 'beta',
    requestHeaders: { 'x-deployment': 'prod' },
  })
  assert.deepEqual(full, {
    origin: 'https://platform.deepseek.com',
    token: 'tok-123',
    userId: 'uid-9',
    embeddedPageDist: 'beta',
    requestHeaders: { 'x-deployment': 'prod' },
  })
  // Optional fields are omitted rather than set to empty strings, so a consumer
  // can tell "absent" from "present but blank".
  assert.deepEqual(
    readPlatformSession({ origin: 'https://x.test', token: 't' }),
    { origin: 'https://x.test', token: 't', userId: null },
  )
  // Header names are normalised: a request header set is case-insensitive.
  assert.deepEqual(readPlatformSession({ origin: 'https://x.test', token: 't', requestHeaders: { 'X-A': '1' } }).requestHeaders, { 'x-a': '1' })
})

test('the account ID is read, and anything unusable becomes null', () => {
  // It keys the view's PERSISTENT partition, so a value this shell misreads is a
  // storage key it must never write under: only a non-empty string survives.
  assert.equal(readPlatformSession({ origin: 'https://x.test', token: 't', userId: 'uid-1' }).userId, 'uid-1')
  for (const userId of [null, undefined, '', 42, {}, [], true]) {
    assert.equal(readPlatformSession({ origin: 'https://x.test', token: 't', userId }).userId, null, JSON.stringify(userId))
  }
})

test('a malformed session becomes null rather than throwing', () => {
  // The host handshake must survive a payload this shell cannot use: the account
  // surface simply reads as signed out.
  for (const value of [
    null,
    undefined,
    'not-an-object',
    42,
    {},
    { origin: 'https://x.test' }, // no token
    { token: 't' }, // no origin
    { origin: '', token: 't' },
    { origin: 'https://x.test', token: '' },
    { origin: 5, token: 't' },
    { origin: 'https://x.test', token: 5 },
  ]) {
    assert.equal(readPlatformSession(value), null, JSON.stringify(value))
  }
})

test('a non-string header value is dropped, not forwarded', () => {
  const session = readPlatformSession({
    origin: 'https://x.test',
    token: 't',
    requestHeaders: { good: 'yes', bad: 42, empty: '', alsoBad: null },
  })
  assert.deepEqual(session.requestHeaders, { good: 'yes' })
  // A headers object that ends up empty is omitted entirely.
  assert.equal(readPlatformSession({ origin: 'https://x.test', token: 't', requestHeaders: { bad: 42 } }).requestHeaders, undefined)
})

// ------------------------------------------------------------ renderer input

test('bounds are validated and rounded before a native view uses them', () => {
  assert.deepEqual(platformBounds({ x: 10, y: 20, width: 300, height: 400 }), { x: 10, y: 20, width: 300, height: 400 })
  assert.deepEqual(platformBounds({ x: 10.4, y: 20.6, width: 300, height: 400 }), { x: 10, y: 21, width: 300, height: 400 })
  // A malformed rectangle must FAIL rather than silently become 0,0,0,0: an
  // invisible full-screen view over the app would be worse than an error.
  for (const value of [
    null, undefined, 'box', 42, {},
    { x: 0, y: 0, width: 10 }, // missing height
    { x: Number.NaN, y: 0, width: 10, height: 10 },
    { x: Number.POSITIVE_INFINITY, y: 0, width: 10, height: 10 },
    { x: -1, y: 0, width: 10, height: 10 },
    { x: 0, y: 0, width: 10, height: 200_000 },
  ]) {
    assert.throws(() => platformBounds(value), undefined, JSON.stringify(value))
  }
})

test('only the two known pages can be embedded', () => {
  assert.equal(platformPage('usage'), 'usage')
  assert.equal(platformPage('top-up'), 'top-up')
  // The renderer supplies a NAME, never a URL, so it cannot steer the view to
  // another path on the Platform origin.
  for (const value of ['top_up', '/top_up', 'https://evil.test', '', null, undefined, 42, {}, 'USAGE']) {
    assert.throws(() => platformPage(value), undefined, JSON.stringify(value))
  }
})

// ------------------------------------------------------------ cookie merging

test('deployment cookies merge with the session cookie, one per name', () => {
  // The duplicated rule from the kernel's own mergePlatformCookies: the deployment
  // value wins, and only well-formed pairs survive.
  assert.equal(mergePlatformCookies('a=1; b=2', 'b=9; c=3'), 'a=1; b=9; c=3')
  assert.equal(mergePlatformCookies('', 'a=1'), 'a=1')
  assert.equal(mergePlatformCookies('a=1', ''), 'a=1')
  // A pair without '=' is not a cookie; it must not become one.
  assert.equal(mergePlatformCookies('garbage; a=1', 'b=2'), 'a=1; b=2')
  assert.equal(mergePlatformCookies('a=', 'b=2'), 'a=; b=2')
})

// -------------------------------------------------------- client identity
//
// Platform picks its own behaviour from these headers, so they are pinned field
// for field against the kernel's `platformClientHeaders`: a drift here changes
// what the page thinks it is talking to, silently.

test('the client identity headers carry all five fields Platform reads', () => {
  assert.deepEqual(
    platformClientHeaders('win32', { version: '0.17.1', locale: 'zh_CN', timezoneOffsetSeconds: 28_800 }),
    {
      'x-client-bundle-id': '',
      'x-client-platform': 'desktop-win',
      'x-client-version': '0.17.1',
      'x-client-locale': 'zh_CN',
      'x-client-timezone-offset': '28800',
    },
  )
})

test('an unidentified platform still reports the web identity it is', () => {
  // The bundle id stays empty and `x-client-platform` stays `web`; the desktop
  // claim is a SEPARATE header the provider has to name an OS for.
  const linux = platformClientHeaders(null, { version: 'v', locale: 'en_US', timezoneOffsetSeconds: 0 })
  assert.deepEqual(linux, {
    'x-client-bundle-id': '',
    'x-client-platform': 'web',
    'x-client-version': 'v',
    'x-client-locale': 'en_US',
    'x-client-timezone-offset': '0',
  })
})

test('the UTC offset is seconds east, which is the negated platform offset', () => {
  // Measured from a real Date rather than a stub: the sign convention is the one
  // thing a hand-written expectation would get wrong. UTC+8 is 28800 east.
  const original = Date.prototype.getTimezoneOffset
  try {
    Date.prototype.getTimezoneOffset = () => -480
    const metadata = platformClientMetadata('v', 'zh_CN')
    assert.equal(metadata.timezoneOffsetSeconds, 28_800)
    // The rest of the sample is passed through untouched.
    assert.equal(metadata.version, 'v')
    assert.equal(metadata.locale, 'zh_CN')
  } finally {
    Date.prototype.getTimezoneOffset = original
  }
})

// ------------------------------------------------------------ partition choice
//
// The view's storage is keyed by ACCOUNT: page preferences must survive reopening
// and must never be shared between accounts. Both halves are pure and pinned here
// because the failures are invisible — a wrong key silently resets preferences,
// or silently shows one account another's settings.

test('a known account gets a persistent, account-scoped partition', () => {
  const name = platformPartition('https://platform.deepseek.com', 'uid-1')
  assert.match(name, /^persist:dsh-platform-[a-f0-9]{64}$/u)
  // Stable: reopening the page is what makes the preferences survive.
  assert.equal(name, platformPartition('https://platform.deepseek.com', 'uid-1'))
  // A different account, or the same account on another issuer, is a different
  // partition — neither inherits the other's storage.
  assert.notEqual(name, platformPartition('https://platform.deepseek.com', 'uid-2'))
  assert.notEqual(name, platformPartition('https://platform.example.test', 'uid-1'))
})

test('an unknown account gets a throwaway partition, never a shared one', () => {
  // Null means the kernel has no profile ID yet; there is nothing stable to key
  // on, so two opens must not collide on one shared storage.
  const first = platformPartition('https://platform.deepseek.com', null)
  const second = platformPartition('https://platform.deepseek.com', null)
  assert.match(first, /^dsh-platform-[0-9a-f-]{36}$/u)
  assert.notEqual(first, second)
  assert.ok(!first.startsWith('persist:'), 'a null account ID must not persist anything')
})

// ------------------------------------------------------------ exposed surface
//
// Both preloads RUN here. Each built file is evaluated in a fresh context against
// a fake `electron` module, and the assertions are about what it exposed and what
// that exposure does. Matching the built text instead (what this section used to
// do) cannot tell a guard that is present from one that is neutralised: measured,
// `process.isMainFrame || true` in the platform preload left every text assertion
// green while a subframe could ask for the credential.

const DIST = path.join(import.meta.dirname, '..', 'dist', 'main')
const PLATFORM = 'https://platform.deepseek.com'

/**
 * Evaluate a built preload the way Electron would, against a fake `electron`.
 *
 * The fake answers `require('electron')` with ONLY the members a test hands in,
 * so a preload that reaches for any other member fails here instead of in a page.
 *
 * @param {string} file - the built preload, under `dist/main`.
 * @param {object} globals - what the preload reads from its document and process.
 * @param {object} electron - the fake module's members.
 * @returns the exposures by name, and the context the preload ran in.
 */
function runPreload(file, globals, electron) {
  const exposed = new Map()
  const sandbox = {
    console,
    ...globals,
    exports: {},
    module: { exports: {} },
    require: (id) => {
      assert.equal(id, 'electron', `${file} must require nothing but electron`)
      return {
        contextBridge: { exposeInMainWorld: (name, value) => { exposed.set(name, value) } },
        ...electron,
      }
    },
  }
  vm.runInNewContext(readFileSync(path.join(DIST, file), 'utf8'), sandbox)
  return { exposed, sandbox }
}

/** The app preload on one document: what it exposed, and what it asked for. */
function runAppPreload({ protocol = 'dsh-app:', hostname = 'app' } = {}) {
  const invokes = []
  const { exposed } = runPreload('account-preload.js', { location: { protocol, hostname } }, {
    ipcRenderer: {
      invoke: (...args) => { invokes.push(args); return Promise.resolve() },
      // A synchronous channel blocks the page; the fake refuses one outright.
      sendSync: () => { throw new Error('the app preload used a synchronous channel') },
    },
  })
  return { exposed, invokes }
}

test('the app preload exposes the marker and the platform bridge, nothing else', async () => {
  const { exposed, invokes } = runAppPreload()
  // Exactly two exposures: the account marker, and the three-operation bridge
  // that turns the account section's usage / top-up links into an in-app view.
  assert.deepEqual([...exposed.keys()], ['dshDesktop', 'dshPlatform'])
  // The marker is the whole switch the kernel's account UI looks for; a page that
  // can see it must not be able to change it.
  assert.ok(Object.isFrozen(exposed.get('dshDesktop')), 'the marker must be frozen')
  assert.equal(exposed.get('dshDesktop').protocolVersion, 1)
  // The bridge may only ask the main process for these three things — nothing
  // else exists to reach, and this is the list a reviewer must re-check before
  // it grows: see installPlatformIpc for what each one is allowed to do.
  const bridge = exposed.get('dshPlatform')
  assert.deepEqual(Object.keys(bridge).sort(), ['close', 'open', 'setBounds'])
  const bounds = { x: 10, y: 20, width: 300, height: 400 }
  await Promise.all([bridge.open('usage', bounds), bridge.setBounds(bounds), bridge.close()])
  assert.deepEqual(invokes, [
    [PLATFORM_IPC.open, 'usage', bounds],
    [PLATFORM_IPC.bounds, bounds],
    [PLATFORM_IPC.close],
  ])
  // What it must NEVER do: send a credential to the main process, or read one
  // back. The token is main-process state and the embedded document's own
  // preload fetches it; nothing on this side has any business holding it.
  assert.ok(!invokes.some(([channel]) => channel === PLATFORM_IPC.bootstrap),
    'the app preload must not touch the credential channel')
})

test('the app preload exposes nothing to a document that is not the app', () => {
  // The same window shows the splash page first: a `file:` document, which has
  // no use for any of this. Another host on the scheme, and another scheme
  // entirely, are refused the same way.
  for (const page of [{ protocol: 'file:', hostname: '' }, { protocol: 'dsh-app:', hostname: 'shell' }, { protocol: 'https:', hostname: 'app' }]) {
    assert.deepEqual([...runAppPreload(page).exposed.keys()], [], JSON.stringify(page))
  }
})

/** The snapshot the main process answers a legitimate bootstrap with. */
const SNAPSHOT = { token: 'tok-123', origin: PLATFORM, locale: 'zh_CN' }

/**
 * The platform preload on one view: `allowedOrigin` is what the main process
 * passed on the command line, `origin` is where the document actually is.
 *
 * @param {object} [options]
 * @param {boolean} [options.isMainFrame] whether this is the view's main frame.
 * @param {string} [options.origin] the document's own origin.
 * @param {string|null} [options.allowedOrigin] the command line's origin (null: none).
 * @param {unknown} [options.bootstrap] what the main process answers, or an Error to throw.
 * @returns what was exposed, and a way to publish a language change.
 */
function runPlatformPreload({ isMainFrame = true, origin = PLATFORM, allowedOrigin = origin, bootstrap } = {}) {
  const listeners = new Map()
  const { exposed, sandbox } = runPreload('platform-preload.js', {
    console: { ...console, error() {} },
    process: { isMainFrame, argv: allowedOrigin === null ? [] : [`--dsh-platform-origin=${allowedOrigin}`] },
    location: { origin },
  }, {
    ipcRenderer: {
      on: (channel, listener) => listeners.set(channel, listener),
      sendSync: () => {
        if (bootstrap instanceof Error) throw bootstrap
        return bootstrap
      },
    },
  })
  return {
    exposed,
    sandbox,
    dsh: exposed.get('dsh'),
    localeChanged: (value) => listeners.get(PLATFORM_IPC.localeChanged)?.({}, value),
  }
}

test('the platform preload hands the credential only to this view\'s own main frame', () => {
  const own = runPlatformPreload({ bootstrap: SNAPSHOT })
  assert.deepEqual([...own.exposed.keys()], ['dsh'])
  assert.equal(own.dsh.displayMode, 'embedded')
  assert.equal(own.dsh.protocolVersion, 1)
  assert.equal(own.dsh.getAuthToken(), 'tok-123')
  assert.equal(own.dsh.getLocale(), 'zh_CN')
  // Three gates, all required. A subframe cannot ask for the credential, even on
  // the right origin...
  assert.equal(runPlatformPreload({ isMainFrame: false, bootstrap: SNAPSHOT }).exposed.size, 0, 'a subframe got a bridge')
  // ...nor a document that navigated off the origin this view was opened on,
  // even though the command line still names the real one...
  assert.equal(runPlatformPreload({ origin: 'https://evil.test', allowedOrigin: PLATFORM, bootstrap: SNAPSHOT }).exposed.size, 0, 'a foreign document got a bridge')
  // ...nor a view whose command line named no origin at all.
  assert.equal(runPlatformPreload({ allowedOrigin: null, bootstrap: SNAPSHOT }).exposed.size, 0, 'a view with no origin got a bridge')
})

test('the token comes from the main process, and is compared on the way in', () => {
  // A page cannot hand itself one: the bootstrap answer counts only when it
  // carries THIS document's origin, a non-empty token and a known language.
  for (const answer of [
    { ...SNAPSHOT, origin: 'https://evil.test' },
    { ...SNAPSHOT, token: '' },
    { ...SNAPSHOT, locale: 'fr_FR' },
    'tok-123', null, {}, [],
  ]) {
    const { exposed } = runPlatformPreload({ bootstrap: answer })
    assert.equal(exposed.size, 1, JSON.stringify(answer))
    assert.throws(() => exposed.get('dsh').getAuthToken(), /platform initialization failed/u, JSON.stringify(answer))
  }
})

test('a bootstrap that fails keeps embedded mode, and says so on the getter', () => {
  // Falling back to a plain web page would let it use whatever browser
  // credentials its own session might have.
  const { exposed } = runPlatformPreload({ bootstrap: new Error('channel closed') })
  assert.equal(exposed.size, 1)
  assert.throws(() => exposed.get('dsh').getAuthToken(), /platform initialization failed/u)
  assert.throws(() => exposed.get('dsh').getLocale(), /platform locale initialization failed/u)
})

test('the token stays in the closure: nothing the page can reach holds it', () => {
  const { sandbox, dsh } = runPlatformPreload({ bootstrap: SNAPSHOT })
  // JSON, not a property walk: a closure-held value has no property to find, so
  // what this rules out is the token sitting anywhere the page could name.
  for (const [name, value] of Object.entries(sandbox)) {
    assert.ok(!String(JSON.stringify(value)).includes('tok-123'), `${name} holds the token`)
  }
  for (const value of Object.values(dsh)) {
    assert.ok(!String(JSON.stringify(value)).includes('tok-123'), 'an exposed function carries the token')
  }
})

test('a language change from the main process reaches the page, and only a known language does', () => {
  const { dsh, localeChanged } = runPlatformPreload({ bootstrap: SNAPSHOT })
  const heard = []
  const others = []
  const unsubscribe = dsh.onLocaleChange((locale) => heard.push(locale))
  dsh.onLocaleChange(() => { throw new Error('a listener that fails') })
  dsh.onLocaleChange((locale) => others.push(locale))
  localeChanged('en_US')
  assert.deepEqual(heard, ['en_US'])
  assert.deepEqual(others, ['en_US'], 'a failing listener must not stop the others')
  assert.equal(dsh.getLocale(), 'en_US')
  localeChanged('fr_FR')
  assert.equal(dsh.getLocale(), 'en_US', 'an unknown language changes nothing')
  unsubscribe()
  localeChanged('zh_CN')
  assert.deepEqual(heard, ['en_US'], 'an unsubscribed listener hears nothing')
})

// ------------------------------------------------- the session survives ordering
//
// The account session is published by the KERNEL while it boots, and the view is
// created by the SHELL as part of its own startup — two independent events, in no
// guaranteed order. The first implementation held the session only on the view and
// applied it with an optional call, so an early publication was silently dropped
// and the embedded page failed with "no account session" (found only by signing in
// on a real machine). The fix keeps the session in shell state and hands it to the
// view at creation, which makes the ORDER irrelevant rather than merely correct.
//
// A source rule: the invariant is "who owns the state", it lives in `index.ts`,
// and nothing here can boot the shell to observe it.

test('source rule: the session lives in shell state, so the view cannot miss an early one', () => {
  const source = readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8')
  // The shell records every publication...
  const handler = /onPlatformSession:\s*\(session\)\s*=>\s*\{([\s\S]*?)\n\s*\},/u.exec(source)
  assert.ok(handler !== null, 'the host callback is where a publication arrives')
  assert.match(handler[1], /platformSession\s*=\s*session/u, 'the shell must keep the session itself')
  // ...and the view is handed that state when it is created, BEFORE the IPC that
  // can open a page exists (a page opened against a view with no session is the
  // failure this guards).
  const ensure = /function ensurePlatformView\(\)[^{]*\{([\s\S]*?)\n\}/u.exec(source)
  assert.ok(ensure !== null, 'ensurePlatformView is where the view is created')
  assert.match(ensure[1], /platformView\.setSession\(platformSession\)/u, 'the created view must be given the current session')
  const setAt = ensure[1].indexOf('setSession(platformSession)')
  const ipcAt = ensure[1].indexOf('installPlatformIpc(')
  assert.ok(setAt !== -1 && ipcAt !== -1 && setAt < ipcAt, 'the session must be applied before the IPC surface can open a page')
})

test('source rule: a publication is not lost when it arrives before the view exists', () => {
  const source = readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8')
  // The original defect, stated as the thing that must NOT come back: applying a
  // session ONLY through an optional view, with no shell-side record. That shape
  // silently discards the first publication whenever the host wins the race.
  const earlyReturnShape = /onPlatformSession:\s*\(session\)\s*=>\s*\{\s*platformView\?\.setSession\(session\)\s*\}/u
  assert.ok(
    !earlyReturnShape.test(source),
    'applying the session only through `platformView?.` drops an early publication — keep it in shell state instead',
  )
})

// ------------------------------------------------- credential lifetime on exit
//
// A persisted partition outlives the document, so the credential has to be
// removed rather than left for the next process. What the VIEW clears is run in
// platform-view-lifecycle.test.mjs; what is left here is source rules for the
// wiring in `index.ts` and `updater.ts`, which no test can boot. The cleanup is
// asynchronous, which is why both install paths must AWAIT it before handing the
// process over: a fire-and-forget clear can be lost with the process that
// scheduled it.

test('source rule: a hidden window suspends the view and a shown one resumes it', () => {
  // The embedded page is a whole renderer process for a surface nobody can see,
  // and hiding to the tray is the state a user leaves the app in. `suspend` and
  // `resume` themselves are run in platform-view-lifecycle.test.mjs; this is the
  // half that lives in the shell — the window's own events are where the pair is
  // wired, and the client overlay above the native view has no way to learn the
  // page went away.
  const shell = readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8')
  assert.match(shell, /win\.on\('hide', \(\) => \{\s*platformView\?\.suspend\(\)/u)
  assert.match(shell, /win\.on\('show', \(\) => \{\s*void platformView\?\.resume\(win\)/u)
})

test('source rule: both install paths await the discard before replacing the process', () => {
  const source = readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'updater.ts'), 'utf8')
  // Two install paths replace the process: electron-updater's quitAndInstall and
  // the Windows installer spawn. Each call site must AWAIT the discard, and the
  // discard must come first — a fire-and-forget clear can be lost with the
  // process that scheduled it. (The arguments themselves are pinned in
  // updater-click-free-install.test.mjs: both paths install silently.)
  const calls = [...source.matchAll(/await discardPlatformCredentialsForRestart\(\)/gu)]
  assert.equal(calls.length, 2, `expected both install paths to await the discard, saw ${calls.length}`)
  for (const [which, handover] of [[0, /autoUpdater\.quitAndInstall\([^)]*\)/u], [1, /spawn\(dest,/u]]) {
    const callAt = calls[which].index
    const handoverAt = source.search(handover)
    assert.ok(handoverAt !== -1, 'each discard must precede a process handover')
    assert.ok(callAt < handoverAt, 'the discard must happen BEFORE the process is replaced')
  }
  // The injected hook is what the shell fills in; unset means nothing to discard.
  assert.match(source, /let discardPlatformCredentials[\s\S]{0,200}?= null/u)
})

test('source rule: the shell wires its discard hook where the updater can find it', () => {
  const source = readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8')
  const wired = /setPlatformCredentialDiscard\(([\s\S]*?)\n/u.exec(source)
  assert.ok(wired !== null, 'the shell must hand the updater its discard operation')
  // The operation waits for `dispose()`, never the fire-and-forget `close()`.
  assert.match(source, /async function discardPlatformView\(\)[\s\S]{0,700}?await view\.dispose\(\)/u)
})

// ------------------------------------------------- the exit side, not just installs
//
// The partition is PERSISTENT once the kernel reports an account ID, so the
// credential now outlives the document. Clearing it only before an UPDATE would
// leave it on disk for every ordinary quit, a relaunch, or a crash — which is the
// regression this block pins. Every way this process stops must discard first.

test('source rule: every way this process stops discards the credential first', () => {
  const source = readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8')
  // will-quit: awaited inside the handler, because app.exit() below it does not
  // wait for pending work.
  const willQuit = /app\.on\('will-quit', \(event\) => \{([\s\S]*?)\n  \}\)/u.exec(source)
  assert.ok(willQuit !== null, 'will-quit is the last stop for an ordinary quit')
  assert.match(willQuit[1], /event\.preventDefault\(\)/u)
  assert.match(willQuit[1], /await discardPlatformView\(\)/u)
  const discardAt = willQuit[1].indexOf('await discardPlatformView()')
  const stopAt = willQuit[1].indexOf('server.stop()')
  assert.ok(discardAt !== -1 && discardAt < stopAt, 'the credential is dropped before the host that issued it stops')
  // Relaunch paths go through one helper, so a new one cannot forget the discard.
  const helper = /async function relaunchAfterDiscard\(\): Promise<void> \{([\s\S]*?)\n\}/u.exec(source)
  assert.ok(helper !== null, 'the relaunch helper is where every restart path converges')
  assert.match(helper[1], /await discardPlatformView\(\)/u)
  assert.match(helper[1], /app\.relaunch\(\)/u)
  // No path may call app.relaunch() directly any more: that is the shape that
  // shipped a persistent credential past the process boundary.
  const direct = [...source.matchAll(/^\s*app\.relaunch\(\)/gmu)].filter((match) => {
    const before = source.slice(Math.max(0, match.index - 200), match.index)
    return !/async function relaunchAfterDiscard/u.test(before)
  })
  assert.equal(direct.length, 0, 'a restart must go through relaunchAfterDiscard, which discards first')
})

