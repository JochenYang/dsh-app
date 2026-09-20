// The main window's navigation fence: the app origin and the shell's OWN
// splash document, and nothing else. A scheme-only check would let any local
// file be loaded into the window — the spoofing case this test pins shut.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { isShellNavigationTarget, SPLASH_PAGE } = require('../dist/main/nav-policy.js')
const { APP_ORIGIN } = require('../dist/main/desktop-host.js')

test('the app origin and its action route are allowed', () => {
  assert.equal(isShellNavigationTarget(`${APP_ORIGIN}/index.html`), true)
  assert.equal(isShellNavigationTarget(`${APP_ORIGIN}/__dsh-app/action/pick-folder`), true)
})

test('the shell\'s own splash document is allowed', () => {
  assert.equal(isShellNavigationTarget(pathToFileURL(SPLASH_PAGE).href), true)
})

test('any other file: URL is refused', () => {
  // The spoofing case: a compromised page context asking the top-level window
  // to load a local page that looks like settings.
  const elsewhere = pathToFileURL('C:/Users/attacker/fake-settings.html').href
  assert.equal(isShellNavigationTarget(elsewhere), false)
  assert.equal(isShellNavigationTarget(pathToFileURL(SPLASH_PAGE).href.replace('startup.html', 'other.html')), false)
  // Query and hash must not turn a different file into the splash page.
  assert.equal(isShellNavigationTarget(`${pathToFileURL(SPLASH_PAGE).href}?x=1`), false)
})

test('non-file external URLs and unparseable targets are refused', () => {
  assert.equal(isShellNavigationTarget('https://example.com/'), false)
  assert.equal(isShellNavigationTarget('http://127.0.0.1:9999/'), false)
  assert.equal(isShellNavigationTarget('not a url at all'), false)
  assert.equal(isShellNavigationTarget(''), false)
})

test('lookalike app URLs do not pass the fence', () => {
  // A different port is a different origin to the renderer.
  assert.equal(isShellNavigationTarget(`${APP_ORIGIN}:80/index.html`), false)
  // Userinfo before the real host, and a trailing-dot host, both resolve to
  // some other hostname.
  assert.equal(isShellNavigationTarget('dsh-app://app@evil.com/index.html'), false)
  assert.equal(isShellNavigationTarget('dsh-app://app:80@evil.com/'), false)
  assert.equal(isShellNavigationTarget('dsh-app://app./index.html'), false)
  // A scheme or host in another case is refused (fail-closed): Node's URL
  // keeps an opaque host's case, so this is not the app origin as written.
  assert.equal(isShellNavigationTarget('DSH-APP://APP/index.html'), false)
  // The splash is compared by resolved file URL, so a bare `file:` reference
  // is not it.
  assert.equal(isShellNavigationTarget('file:startup.html'), false)
  assert.equal(isShellNavigationTarget('FILE:///etc/passwd'), false)
})
