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
const { isAppFrame, mergePlatformCookies, platformBounds, platformPage } = require('../dist/main/platform-view.js')

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
    embeddedPageDist: 'beta',
    requestHeaders: { 'x-deployment': 'prod' },
  })
  assert.deepEqual(full, {
    origin: 'https://platform.deepseek.com',
    token: 'tok-123',
    embeddedPageDist: 'beta',
    requestHeaders: { 'x-deployment': 'prod' },
  })
  // Optional fields are omitted rather than set to empty strings, so a consumer
  // can tell "absent" from "present but blank".
  assert.deepEqual(readPlatformSession({ origin: 'https://x.test', token: 't' }), { origin: 'https://x.test', token: 't' })
  // Header names are normalised: a request header set is case-insensitive.
  assert.deepEqual(readPlatformSession({ origin: 'https://x.test', token: 't', requestHeaders: { 'X-A': '1' } }).requestHeaders, { 'x-a': '1' })
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
