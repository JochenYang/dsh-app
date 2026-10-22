// The embedded Platform view's contract, and the two preloads' exposure surface.
//
// The account surface only exists when the app document sees `window.dshDesktop`
// (the kernel's `ui-settings-account` returns early without it), and the embedded
// usage / top-up page authenticates through the view's own preload. Both are
// security-relevant, so the rules that matter are pinned here rather than left to
// review: the session payload is untrusted input, the bounds come from the page,
// the page NAME is a whitelist, and the app preload exposes exactly one key.
//
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { readPlatformSession } = require('../dist/main/desktop-host.js')
const {
  isAppFrame, mergePlatformCookies, platformBounds, platformClientHeaders, platformClientMetadata, platformPage, platformPartition,
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

test('the app preload exposes the marker and the platform bridge, nothing else', () => {
  const built = readFileSync(path.join(import.meta.dirname, '..', 'dist', 'main', 'account-preload.js'), 'utf8')
  // Exactly two exposures: the account marker, and the three-operation bridge
  // that turns the account section's usage / top-up links into an in-app view.
  const exposures = [...built.matchAll(/exposeInMainWorld\(\s*([A-Za-z_$][\w$.]*|'[^']*')/gu)]
    .map((match) => match[1])
  assert.equal(exposures.length, 2, `expected exactly two exposures, saw ${JSON.stringify(exposures)}`)
  assert.deepEqual(exposures, ['exports.MARKER_KEY', "'dshPlatform'"])
  assert.match(built, /exports\.MARKER_KEY = 'dshDesktop'/)
  // The bridge may only ask the main process for these three things — nothing
  // else exists to reach, and this is the list a reviewer must re-check before
  // it grows: see installPlatformIpc for what each one is allowed to do.
  const channels = [...built.matchAll(/ipcRenderer\.invoke\(\s*[A-Za-z_$][\w$.]*\.(\w+)/gu)].map((match) => match[1])
  assert.deepEqual([...new Set(channels)].sort(), ['bounds', 'close', 'open'])
  // What it must NEVER do: send a credential to the main process, or read one
  // back. The token is main-process state and the embedded document's own
  // preload fetches it; nothing on this side has any business holding it.
  const code = built.split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/u.test(line)).join('\n')
  assert.ok(!/sendSync/u.test(code), 'the app preload must not use a synchronous channel')
  assert.ok(!/dsh-platform:bootstrap|platform-origin/u.test(code), 'the app preload must not touch the credential channel')
  // No other Electron member is reachable from here.
  const electronMembers = [...code.matchAll(/electron_\d+\.([A-Za-z_$][\w$]*)/gu)].map((match) => match[1])
  assert.deepEqual([...new Set(electronMembers)].sort(), ['contextBridge', 'ipcRenderer'])
})

test('the platform preload scopes the credential to the view that owns it', () => {
  const built = readFileSync(path.join(import.meta.dirname, '..', 'dist', 'main', 'platform-preload.js'), 'utf8')
  // Three gates, all required: a main frame, an origin passed on THIS view's
  // command line, and that origin matching the document's own.
  assert.match(built, /process\.isMainFrame/u)
  assert.match(built, /--dsh-platform-origin=/u)
  assert.match(built, /location\.origin === allowedOrigin/u)
  // The token is kept in a closure and compared on the way in, so a page cannot
  // hand itself one, and it is never written to a global.
  assert.match(built, /value\.origin === location\.origin/u)
  assert.match(built, /exposeInMainWorld\('dsh'/u)
})

test('the main process re-checks the FRAME, not just the webContents', () => {
  const source = readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'platform-view.ts'), 'utf8')
  const bootstrap = /  bootstrap\(([\s\S]*?)\n  \}\n/u.exec(source)
  assert.ok(bootstrap !== null, 'bootstrap is the credential handoff')
  // A same-origin SUBFRAME has the same URL as the main frame, so a URL check
  // cannot tell them apart: identity has to be compared against the main frame.
  assert.match(bootstrap[1], /frame !== view\.webContents\.mainFrame/u)
  assert.match(bootstrap[1], /frame === null/u)
  // The IPC handler must pass the frame OBJECT for that comparison to be possible.
  const handler = /ipcMain\.on\(PLATFORM_IPC\.bootstrap,\s*\(event\)\s*=>\s*\{([\s\S]*?)\n  \}\)/u.exec(source)
  assert.ok(handler !== null, 'the bootstrap channel is where the call arrives')
  assert.match(handler[1], /view\.bootstrap\(event\.sender, event\.senderFrame\)/u)
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
// This is a structural assertion for the same reason the theme one is: the
// invariant is "who owns the state", and no return value shows it.

test('the session lives in shell state, so the view cannot miss an early one', () => {
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

test('a publication is not lost when it arrives before the view exists', () => {
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
// removed rather than left for the next process. The cleanup is asynchronous,
// which is why both install paths must AWAIT it before handing the process over:
// a fire-and-forget clear can be lost with the process that scheduled it.

test('the view clears its own partition, not just its document', () => {
  const source = readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'platform-view.ts'), 'utf8')
  const close = /  close\(\): void \{([\s\S]*?)\n  \}\n/u.exec(source)
  assert.ok(close !== null, 'close() is where the document is destroyed')
  // The four steps a persisted partition needs; any one missing leaves the
  // credential reachable by a later view.
  for (const step of [
    /webRequest\.onBeforeSendHeaders\(null\)/u,
    /flushStorageData\(\)/u,
    /cleanStorage\(browserSession/u,
    /waitForBeforeUnload: false/u,
  ]) {
    assert.match(close[1], step, `close() must ${String(step)}`)
  }
  // The clear itself: every authenticating store, and the cache/auth cache.
  const clean = /private cleanStorage\(([\s\S]*?)\n  \}\n\}/u.exec(source)
  assert.ok(clean !== null, 'cleanStorage is where a partition is sanitized')
  assert.match(clean[0], /closeAllConnections\(\)/u)
  assert.match(clean[0], /clearStorageData\(/u)
  assert.match(clean[0], /clearCache\(\)/u)
  assert.match(clean[0], /clearAuthCache\(\)/u)
  // A PERSISTED partition keeps local storage (that is what makes preferences
  // survive); a throwaway one is cleared whole. Getting this backwards silently
  // resets every preference, or silently keeps credentials.
  assert.match(clean[0], /isPersistent\(\)/u)
  assert.match(clean[0], /\? \{ storages: \[[^\]]*'cookies'[^\]]*\] \}\s*: undefined/u)
  assert.ok(!/'localstorage'/u.test(clean[0]), 'local storage must survive on a persisted partition')
  // A failure is REPORTED, never swallowed: the caller decides whether it blocks.
  assert.match(clean[0], /AggregateError/u)
})

test('the download refusal is registered once per session, not once per open', () => {
  const source = readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'platform-view.ts'), 'utf8')
  // A persisted partition is the SAME Session on every open, so a listener added
  // per open accumulates forever (and warns once it passes ten).
  assert.match(source, /downloadGuards = new WeakSet<Session>\(\)/u)
  const registration = /if \(!this\.downloadGuards\.has\(browserSession\)\) \{([\s\S]{0,200}?)\n    \}/u.exec(source)
  assert.ok(registration !== null, 'the guard must be conditional on the session')
  assert.match(registration[1], /will-download/u)
  // And close() must NOT remove it: the guard belongs to the session, not the view.
  const close = /  close\(\): void \{([\s\S]*?)\n  \}\n/u.exec(source)
  assert.ok(!/will-download/u.test(close[1]))
})

test('a disposed view refuses to be resurrected', () => {
  const source = readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'platform-view.ts'), 'utf8')
  // After dispose() the credential is gone for good; a stale reference must not
  // be able to open a signed-in page or adopt a new snapshot.
  const open = /  async open\(owner: BrowserWindow, page: PlatformPage, bounds: PlatformBounds\): Promise<void> \{\n([\s\S]{0,300}?)\n    this\.close\(\)/u.exec(source)
  assert.ok(open !== null)
  assert.match(open[1], /if \(this\.disposed\) throw/u)
  const setSession = /  setSession\(next: PlatformSession \| null\): void \{\n([\s\S]{0,300}?)const current = this\.account/u.exec(source)
  assert.ok(setSession !== null)
  assert.match(setSession[1], /if \(this\.disposed\) return/u)
})

test('both install paths await the discard before replacing the process', () => {
  const source = readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'updater.ts'), 'utf8')
  // Two install paths replace the process: electron-updater's quitAndInstall and
  // the Windows installer spawn. Each call site must AWAIT the discard, and the
  // discard must come first — a fire-and-forget clear can be lost with the
  // process that scheduled it.
  const calls = [...source.matchAll(/await discardPlatformCredentialsForRestart\(\)/gu)]
  assert.equal(calls.length, 2, `expected both install paths to await the discard, saw ${calls.length}`)
  for (const [which, handover] of [[0, /autoUpdater\.quitAndInstall\(\)/u], [1, /spawn\(dest,/u]]) {
    const callAt = calls[which].index
    const handoverAt = source.search(handover)
    assert.ok(handoverAt !== -1, 'each discard must precede a process handover')
    assert.ok(callAt < handoverAt, 'the discard must happen BEFORE the process is replaced')
  }
  // The injected hook is what the shell fills in; unset means nothing to discard.
  assert.match(source, /let discardPlatformCredentials[\s\S]{0,200}?= null/u)
})

test('the shell wires its discard hook where the updater can find it', () => {
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

test('every way this process stops discards the credential first', () => {
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

