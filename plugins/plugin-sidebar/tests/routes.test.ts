/**
 * Host-route contract tests for the sidebar dock's git face.
 *
 * The migration this file guards: the plugin no longer registers a prefix
 * route on the dsh web server (`/plugins/@dsh-app/plugin-sidebar/api`, gone
 * with the desktop host's disabled `webserver` row) but one EXACT Fetch route
 * per git path on the shared Connection `/api` channel. Captures the
 * registrations with a fake registry, so no HTTP server, no Electron and no
 * kernel composition are involved.
 *
 * @module plugin-sidebar/tests/routes
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ROUTE_PREFIX as CLIENT_PREFIX } from '../src/client/api.ts'
import { handleGitRequest, registerGitRoutes, ROUTE_PREFIX } from '../src/git-routes.ts'
import type { GitRunner, GitSessionScope } from '../src/git-routes.ts'

/** One captured registration: its exact path, methods and handler. */
interface Captured {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody: string
  readonly fetch: (request: Request) => Promise<Response>
}

/** Capture every route one `registerGitRoutes` call contributes. */
function harness(scope: GitSessionScope): Map<string, Captured> {
  const routes = new Map<string, Captured>()
  const registry = {
    register(route: Captured) {
      routes.set(route.path, route)
      return Promise.resolve()
    },
  }
  registerGitRoutes(registry as never, scope)
  return routes
}

/** The session scope every request below is checked against. */
const scope: GitSessionScope = {
  cwdForSession: (sessionId: string) => (sessionId === 'live' ? 'D:\\repo' : undefined),
}

/** Call one captured route with a query string, the way the client does. */
async function call(
  routes: Map<string, Captured>,
  path: string,
  query = '',
  init?: RequestInit,
): Promise<{ status: number, body: { ok: boolean, value?: unknown, error?: { code: string, message: string, host?: { code: string } } } }> {
  const route = routes.get(path)
  assert.ok(route !== undefined, `no route registered at ${path}`)
  const response = await route.fetch(new Request(`dsh-app://app${path}${query}`, init))
  return { status: response.status, body: await response.json() as never }
}

describe('git route registration', () => {
  it('registers one exact route per git path under the Connection prefix', () => {
    const routes = harness(scope)
    assert.deepEqual([...routes.keys()].sort(), [
      `${ROUTE_PREFIX}/git/action`,
      `${ROUTE_PREFIX}/git/diff`,
      `${ROUTE_PREFIX}/git/log`,
      `${ROUTE_PREFIX}/git/ls`,
      `${ROUTE_PREFIX}/git/show`,
      `${ROUTE_PREFIX}/git/status`,
    ])
  })

  it('declares the methods the registry admits, and only those', () => {
    const routes = harness(scope)
    for (const [path, route] of routes) {
      assert.deepEqual(route.methods, path.endsWith('/action') ? ['POST'] : ['GET'], path)
      assert.equal(route.requestBody, 'buffered', path)
    }
  })

  it('carries no `@` in any path segment (the registry rejects it)', () => {
    for (const path of harness(scope).keys()) {
      for (const segment of path.split('/')) {
        assert.match(segment, /^[A-Za-z0-9_$.-]*$/u, `${path} segment ${segment}`)
      }
    }
  })

  it('serves nothing on the retired web-server prefix', () => {
    for (const path of harness(scope).keys()) {
      assert.ok(!path.startsWith('/plugins/'), path)
    }
  })

  it('keeps the client prefix and the host prefix identical', () => {
    assert.equal(CLIENT_PREFIX, ROUTE_PREFIX)
  })
})

describe('git route envelopes', () => {
  it('answers 400 when a GET carries no session id', async () => {
    const answer = await call(harness(scope), `${ROUTE_PREFIX}/git/status`, '?cwd=D%3A%5Crepo')
    assert.equal(answer.status, 400)
    assert.equal(answer.body.ok, false)
    assert.equal(answer.body.error?.code, 'bad-request')
  })

  it('names a folder that is not a repository instead of "git failed"', async () => {
    // Measured on a real machine: the Git tab on a plain folder answered 400
    // with git's stderr wrapped in the generic sentence, on BOTH the status and
    // the log prefetch. It is a state, so the host answers its own code and the
    // tab can stop asking.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-norepo-'))
    try {
      const answer = await call(
        harness({ cwdForSession: sessionId => (sessionId === 'norepo' ? dir : undefined) }),
        `${ROUTE_PREFIX}/git/status`,
        `?cwd=${encodeURIComponent(dir)}&sessionId=norepo`,
      )
      assert.equal(answer.status, 400)
      assert.equal(answer.body.error?.code, 'not-a-repo')
      assert.equal(answer.body.error?.host?.code, 'git.notARepo')
    } finally {
      // The async form: the repo's recursive-delete guard measures it as safe
      // around links, and its sync twin has followed a junction and cost a tree.
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('answers 403 for a session the host does not have', async () => {
    const answer = await call(harness(scope), `${ROUTE_PREFIX}/git/log`, '?cwd=D%3A%5Crepo&sessionId=ghost')
    assert.equal(answer.status, 403)
    assert.equal(answer.body.error?.code, 'forbidden')
    assert.equal(answer.body.error?.host?.code, 'forbidden')
  })

  it('answers 403 when the requested cwd is not the session cwd', async () => {
    const answer = await call(harness(scope), `${ROUTE_PREFIX}/git/ls`, '?cwd=D%3A%5Cother&sessionId=live')
    assert.equal(answer.status, 403)
    assert.equal(answer.body.error?.code, 'forbidden')
  })

  it('rejects a POST action carrying a cwd outside the session', async () => {
    const answer = await call(harness(scope), `${ROUTE_PREFIX}/git/action`, '', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'branch.list', cwd: 'D:\\other', sessionId: 'live' }),
    })
    assert.equal(answer.status, 403)
    assert.equal(answer.body.error?.code, 'forbidden')
  })

  it('rejects an action with no op before touching git', async () => {
    const answer = await call(harness(scope), `${ROUTE_PREFIX}/git/action`, '', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: 'D:\\repo', sessionId: 'live' }),
    })
    assert.equal(answer.status, 400)
    assert.equal(answer.body.error?.code, 'bad-request')
  })
})

describe('git request dispatch', () => {
  it('answers an unknown route name with a 404 envelope', async () => {
    const response = await handleGitRequest('nope' as never, new Request(`dsh-app://app${ROUTE_PREFIX}/git/nope`), scope)
    assert.equal(response.status, 404)
    const body = await response.json() as { ok: boolean, error: { code: string } }
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'not-found')
  })
})

/**
 * The two output ceilings, and the difference between them.
 *
 * Measured on a real machine: a 5 MB single-file diff overflowed execFile's
 * shared 4 MiB buffer and the tab answered 400 `git-error` whose detail was
 * the first 1000 characters of the diff. Content reads therefore run on the
 * larger ceiling (the existing MAX_DIFF_CHARS truncation bounds the answer),
 * while `status` keeps the small one — a status list that overflows is a
 * structural problem no larger read fixes. A fake runner stands in for the
 * spawn, so no multi-megabyte fixture or real repository is involved.
 */
describe('git output ceilings', () => {
  const MIB = 1024 * 1024
  const STATUS_CEILING = 4 * MIB
  const CONTENT_CEILING = 32 * MIB

  /** The error node's execFile throws when a child passes maxBuffer. */
  function maxBufferError(stdout: string): Error & { code: string, stdout: string, stderr: string } {
    const error = new Error('stdout maxBuffer length exceeded') as Error & { code: string, stdout: string, stderr: string }
    error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    error.stdout = stdout
    error.stderr = ''
    return error
  }

  it('reads a 5 MiB diff past the old ceiling and truncates it at MAX_DIFF_CHARS', async () => {
    const diff = 'd'.repeat(5 * MIB)
    const ceilings: (number | undefined)[] = []
    const runner: GitRunner = (_cwd, _args, options) => {
      ceilings.push(options?.maxBufferBytes)
      return Promise.resolve(diff)
    }
    const response = await handleGitRequest(
      'diff',
      new Request(`dsh-app://app${ROUTE_PREFIX}/git/diff?cwd=${encodeURIComponent('D:\\repo')}&sessionId=live&path=pnpm-lock.yaml`),
      scope,
      runner,
    )
    assert.equal(response.status, 200)
    const body = await response.json() as { ok: boolean, value: { text: string, truncated: boolean } }
    assert.equal(body.value.truncated, true)
    assert.equal(body.value.text.length, 500_000)
    assert.deepEqual(ceilings, [CONTENT_CEILING])
  })

  it('answers a coded error, with no stdout fragment, past the content ceiling', async () => {
    const fragment = 'diff --git a/huge.lock b/huge.lock'
    // 33 MiB of theoretical output: the fake enforces the declared ceiling the
    // way execFile would, without materialising the string.
    const runner: GitRunner = (_cwd, _args, options) => {
      const ceiling = options?.maxBufferBytes ?? STATUS_CEILING
      return 33 * MIB > ceiling ? Promise.reject(maxBufferError(fragment)) : Promise.resolve('')
    }
    const response = await handleGitRequest(
      'diff',
      new Request(`dsh-app://app${ROUTE_PREFIX}/git/diff?cwd=${encodeURIComponent('D:\\repo')}&sessionId=live&path=pnpm-lock.yaml`),
      scope,
      runner,
    )
    assert.equal(response.status, 413)
    const body = await response.json() as {
      ok: boolean
      error: { code: string, message: string, host: { code: string, text?: string } }
    }
    assert.equal(body.error.code, 'output-too-large')
    assert.equal(body.error.host.code, 'git.outputTooLarge')
    assert.ok(!JSON.stringify(body.error).includes(fragment), 'the stdout fragment must not travel as detail')
  })

  it('does not read a maxBuffer failure as "diff --no-index found differences"', async () => {
    // `git diff --no-index` exits 1 for "differences found", and the route's
    // inner catch turns that exit into a success carrying stdout. A killed
    // child also leaves stdout behind, so the code check is what keeps the two
    // apart: the maxBuffer code must escape to the outer mapping instead.
    const fragment = 'diff --git a/untracked.bin b/untracked.bin'
    const runner: GitRunner = (_cwd, args) => (
      args[0] === 'rev-parse' ? Promise.resolve('D:\\repo') : Promise.reject(maxBufferError(fragment))
    )
    const response = await handleGitRequest(
      'diff',
      new Request(`dsh-app://app${ROUTE_PREFIX}/git/diff?cwd=${encodeURIComponent('D:\\repo')}&sessionId=live&path=untracked.bin&untracked=1`),
      scope,
      runner,
    )
    assert.equal(response.status, 413)
    const body = await response.json() as {
      ok: boolean
      error: { code: string, message: string, host: { code: string, text?: string } }
    }
    assert.equal(body.error.code, 'output-too-large')
    assert.equal(body.error.host.code, 'git.outputTooLarge')
    assert.ok(!JSON.stringify(body.error).includes(fragment), 'the stdout fragment must not travel as detail')
  })

  it('keeps the status read on the 4 MiB ceiling', async () => {
    const fragment = '?? node_modules/'
    const ceilings: (number | undefined)[] = []
    const runner: GitRunner = (_cwd, _args, options) => {
      ceilings.push(options?.maxBufferBytes)
      const ceiling = options?.maxBufferBytes ?? STATUS_CEILING
      return 5 * MIB > ceiling ? Promise.reject(maxBufferError(fragment)) : Promise.resolve('')
    }
    const response = await handleGitRequest(
      'status',
      new Request(`dsh-app://app${ROUTE_PREFIX}/git/status?cwd=${encodeURIComponent('D:\\repo')}&sessionId=live`),
      scope,
      runner,
    )
    assert.equal(response.status, 413)
    const body = await response.json() as { ok: boolean, error: { code: string, host: { code: string } } }
    assert.equal(body.error.code, 'output-too-large')
    assert.equal(body.error.host.code, 'git.outputTooLarge')
    assert.deepEqual(ceilings, [STATUS_CEILING])
  })

  it('reads show on the content ceiling as well', async () => {
    const ceilings: (number | undefined)[] = []
    const runner: GitRunner = (_cwd, args, options) => {
      ceilings.push(options?.maxBufferBytes)
      return Promise.resolve(args[0] === 'log' ? 'message' : 'stat')
    }
    const response = await handleGitRequest(
      'show',
      new Request(`dsh-app://app${ROUTE_PREFIX}/git/show?cwd=${encodeURIComponent('D:\\repo')}&sessionId=live&sha=abcdef`),
      scope,
      runner,
    )
    assert.equal(response.status, 200)
    assert.deepEqual(ceilings, [CONTENT_CEILING, CONTENT_CEILING])
  })
})
