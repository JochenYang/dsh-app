/**
 * Contract tests for the Git tab's media preview.
 *
 * Two defects are pinned here, both measured on a real repository:
 *
 * 1. The right pane had no media branch at all. `git diff` answers an image
 *    with one line — `Binary files a/logo.svg and b/logo.svg differ` — so the
 *    pane printed an English marker where a picture belongs. The classification
 *    and the route URL are pure, so they are asserted directly.
 * 2. The two file listings disagreed about their base. `status --porcelain`
 *    spells paths relative to the REPOSITORY ROOT, while `ls-files` without
 *    `--full-name` answers them relative to the CWD — so a session opened in a
 *    subdirectory saw the same file under two spellings, and every path-keyed
 *    lookup resolved against the wrong base for one of the two lists.
 *
 * The second one is asserted end to end against a real `git` binary, because
 * the mismatch lives in git's own conventions rather than in this plugin.
 *
 * @module plugin-sidebar/tests/media
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { isBinaryDiffOnly, isPreviewableImage, mediaRouteUrl, workspaceAbsolutePath } from '../src/client/media.ts'
import { handleGitRequest, ROUTE_PREFIX } from '../src/git-routes.ts'

/** Run one git command inside the fixture repository. */
function git(cwd: string, args: string[]): string {
  return execFileSync(process.platform === 'win32' ? 'git.exe' : 'git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  })
}

/** Scratch repositories created by a test, removed when the file finishes. */
const created: string[] = []

after(async () => {
  // Async on purpose: the repository's recursive-delete guard rates the sync
  // recursive call unsafe around links, and its sync twin has followed one and
  // cost a tree. `rm` from `node:fs/promises` is what the guard admits here.
  for (const dir of created) await rm(dir, { recursive: true, force: true })
})

/** A repository whose only content is one nested PNG, committed then modified. */
function nestedImageRepo(): { root: string, nested: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-media-'))
  created.push(root)
  git(root, ['init', '-q', '.'])
  git(root, ['config', 'user.email', 't@example.com'])
  git(root, ['config', 'user.name', 't'])
  const nested = join(root, 'sub', 'deep')
  mkdirSync(nested, { recursive: true })
  // Real PNG signature bytes: git only reports "Binary files … differ" for
  // content it cannot read as text, so a textual placeholder would make the
  // fixture exercise the TEXT path and the assertions below would be about the
  // wrong branch.
  writeFileSync(join(nested, 'logo.png'), pngBytes(0x11))
  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', 'init'])
  writeFileSync(join(nested, 'logo.png'), pngBytes(0x22))
  return { root, nested }
}

/** A minimal buffer with the PNG signature and one varying byte. */
function pngBytes(seed: number): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed, 0x00, 0x01, 0x02])
}

describe('image classification', () => {
  it('accepts the suffixes a browser can paint inline', () => {
    for (const name of ['a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.svg', 'a.webp', 'a.bmp', 'a.ico', 'a.avif']) {
      assert.equal(isPreviewableImage(`docs/${name}`), true, name)
    }
  })

  it('is case-insensitive and survives Windows separators', () => {
    assert.equal(isPreviewableImage('assets\\Logo.SVG'), true)
    assert.equal(isPreviewableImage('assets\\photo.PNG'), true)
  })

  it('refuses non-images and dotfile-looking names', () => {
    for (const path of ['src/main.ts', 'README.md', 'data.json', '.png', 'noext']) {
      assert.equal(isPreviewableImage(path), false, path)
    }
  })
})

describe('workspace path resolution', () => {
  it('joins a repository-relative path onto the root it was spelled against', () => {
    assert.equal(workspaceAbsolutePath('D:\\repo', 'sub/logo.png'), 'D:\\repo\\sub\\logo.png')
    assert.equal(workspaceAbsolutePath('/home/u/repo/', 'sub/logo.png'), '/home/u/repo/sub/logo.png')
  })

  it('leaves an already-absolute path alone', () => {
    assert.equal(workspaceAbsolutePath('D:\\repo', 'C:\\other\\logo.png'), 'C:\\other\\logo.png')
    assert.equal(workspaceAbsolutePath('/repo', '/abs/logo.png'), '/abs/logo.png')
  })

  it('adapts the separator to the root style', () => {
    assert.ok(workspaceAbsolutePath('D:\\repo', 'a/b.png').includes('\\'), 'Windows root keeps backslashes')
    assert.ok(workspaceAbsolutePath('/home/u', 'a/b.png').includes('/'), 'POSIX root keeps slashes')
  })
})

describe('media route URL', () => {
  it('addresses the authenticated file route on the app origin', () => {
    const url = mediaRouteUrl('dsh-app://app/index.html', 'D:\\repo\\logo.png')
    assert.ok(url !== undefined)
    const parsed = new URL(url)
    assert.equal(parsed.pathname, '/api/file')
    assert.equal(parsed.searchParams.get('path'), 'D:\\repo\\logo.png')
  })

  it('keeps a deployment prefix carried by the base', () => {
    const url = mediaRouteUrl('https://host/prefix/', '/repo/logo.png')
    assert.ok(url !== undefined)
    assert.ok(url.startsWith('https://host/prefix/api/file?'), url)
  })

  it('refuses a base that is neither the app origin nor HTTP(S)', () => {
    assert.equal(mediaRouteUrl('file:///app/index.html', '/repo/logo.png'), undefined)
  })

  it('refuses paths the route would reject anyway', () => {
    assert.equal(mediaRouteUrl('dsh-app://app/', 'relative/logo.png'), undefined)
    assert.equal(mediaRouteUrl('dsh-app://app/', '\\\\server\\share\\logo.png'), undefined)
    assert.equal(mediaRouteUrl('dsh-app://app/', '/repo/bad\u0001.png'), undefined)
  })
})

describe('binary diff detection', () => {
  it('recognises git\'s marker with no hunk', () => {
    const text = 'diff --git a/a.png b/a.png\nindex d2c32f4..6661cf7 100644\nBinary files a/a.png and b/a.png differ\n'
    assert.equal(isBinaryDiffOnly(text), true)
  })

  it('does not mistake a text diff for a binary one', () => {
    const text = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n'
    assert.equal(isBinaryDiffOnly(text), false)
  })

  it('does not mistake an empty diff for a binary one', () => {
    assert.equal(isBinaryDiffOnly(''), false)
  })
})

describe('repository path base (real git)', () => {
  it('reports the repository root beside the status entries', async () => {
    const { root, nested } = nestedImageRepo()
    const scope = { cwdForSession: (id: string) => (id === 'live' ? nested : undefined) }
    const response = await handleGitRequest(
      'status',
      new Request(`dsh-app://app${ROUTE_PREFIX}/git/status?cwd=${encodeURIComponent(nested)}&sessionId=live`),
      scope,
    )
    const body = await response.json() as { ok: boolean, value: { root: string, entries: { path: string }[] } }
    assert.equal(body.ok, true)
    // The client needs this root to turn a row's path into a preview URL; the
    // session cwd (a subdirectory) is the wrong base for it. Compared by real
    // path because a Windows temp directory can be reached through both its
    // long and its 8.3 name (`ADMINI~1`); `.native` is the mode that expands
    // the short form on this platform.
    assert.equal(realpathSync.native(body.value.root).toLowerCase(), realpathSync.native(root).toLowerCase())
    assert.deepEqual(body.value.entries.map(entry => entry.path), ['sub/deep/logo.png'])
  })

  it('spells ls-files paths against the same root as status', async () => {
    const { nested } = nestedImageRepo()
    const scope = { cwdForSession: (id: string) => (id === 'live' ? nested : undefined) }
    const response = await handleGitRequest(
      'ls',
      new Request(`dsh-app://app${ROUTE_PREFIX}/git/ls?cwd=${encodeURIComponent(nested)}&sessionId=live`),
      scope,
    )
    const body = await response.json() as { ok: boolean, value: { files: string[] } }
    assert.equal(body.ok, true)
    // Without `--full-name` this is `logo.png` — a CWD-relative spelling that
    // would resolve against the wrong base and address a file that is not the
    // one the status list showed.
    assert.deepEqual(body.value.files, ['sub/deep/logo.png'])
  })

  it('addresses a nested image through the root, not the session cwd', async () => {
    const { nested } = nestedImageRepo()
    const scope = { cwdForSession: (id: string) => (id === 'live' ? nested : undefined) }
    const response = await handleGitRequest(
      'status',
      new Request(`dsh-app://app${ROUTE_PREFIX}/git/status?cwd=${encodeURIComponent(nested)}&sessionId=live`),
      scope,
    )
    const body = await response.json() as { value: { root: string, entries: { path: string }[] } }
    const entry = body.value.entries[0]
    assert.ok(entry !== undefined)
    const absolute = workspaceAbsolutePath(body.value.root, entry.path)
    const url = mediaRouteUrl('dsh-app://app/index.html', absolute)
    assert.ok(url !== undefined)
    // The one assertion that would have caught the original defect: the URL
    // must name a real file, so a wrong base fails here rather than as a blank
    // image pane in front of a user.
    const parsed = new URL(url)
    const served = parsed.searchParams.get('path') ?? ''
    // `realpathSync` throws on a path that does not exist, which is exactly the
    // failure a wrong base produces — named here so it cannot pass silently.
    assert.ok(existsSync(served), `the preview URL must address a real file: ${served}`)
    assert.ok(realpathSync.native(served).toLowerCase().endsWith('logo.png'), served)
  })
})

describe('git renders an image diff as a binary marker', () => {
  it('is why the pane needs a media branch at all', async () => {
    const { nested } = nestedImageRepo()
    const scope = { cwdForSession: (id: string) => (id === 'live' ? nested : undefined) }
    const response = await handleGitRequest(
      'diff',
      new Request(`dsh-app://app${ROUTE_PREFIX}/git/diff?cwd=${encodeURIComponent(nested)}&path=${encodeURIComponent('sub/deep/logo.png')}&cached=0&untracked=0&sessionId=live`),
      scope,
    )
    const body = await response.json() as { ok: boolean, value: { text: string } }
    assert.equal(body.ok, true)
    assert.equal(isBinaryDiffOnly(body.value.text), true, body.value.text)
  })

  it('diffs an untracked file from a subdirectory cwd against the repository root', async () => {
    // `--no-index` compares two paths on disk and understands no pathspec
    // syntax, so its operand is resolved by hand. Resolving it against the cwd
    // addressed `<cwd>/sub/deep/new.png` and produced an empty diff — the pane
    // showed "no differences" for a brand-new file the list had just listed.
    const { root, nested } = nestedImageRepo()
    mkdirSync(join(root, 'sub', 'deep'), { recursive: true })
    writeFileSync(join(root, 'sub', 'deep', 'new.png'), pngBytes(0x33))
    const scope = { cwdForSession: (id: string) => (id === 'live' ? nested : undefined) }
    const response = await handleGitRequest(
      'diff',
      new Request(`dsh-app://app${ROUTE_PREFIX}/git/diff?cwd=${encodeURIComponent(nested)}&path=${encodeURIComponent('sub/deep/new.png')}&cached=0&untracked=1&sessionId=live`),
      scope,
    )
    const body = await response.json() as { ok: boolean, value: { text: string } }
    assert.equal(body.ok, true)
    assert.ok(body.value.text.length > 0, 'an untracked file must produce a diff, not silence')
  })
})
