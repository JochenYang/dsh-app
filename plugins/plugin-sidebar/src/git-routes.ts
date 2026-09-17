/**
 * Host-side git routes for the sidebar dock (Git tab), registered on the
 * Connection exact-Fetch registry the desktop host carries over its byte
 * pipes.
 *
 * One `git` binary spawned per request, never a library and no retained
 * state — the client owns nothing; repo identity comes from the host-resolved
 * session cwd, while the request cwd is only a consistency check. Git resolves
 * the real repository upward from there. Every spawn uses execFile with an argument array (no
 * shell, no injection surface), `windowsHide: true` (a console flash per
 * spawn is a known regression class), and an env baseline carrying only
 * PATH + HOME — parent-proc pollution is another known regression class.
 *
 * Failures answer `{ ok: false, error: { code, message, host } }`: `code` is
 * the transport-ish category the tab already branches on, `host` is the coded
 * message it renders in its own language (see `host-text.ts`), and `message`
 * is the English diagnostic — git's own stderr lands there verbatim, which is
 * not a sentence a user can read, so every user-facing line is the tab's.
 *
 * Routes (each one an EXACT path below the plugin namespace; a parameter
 * always rides the query string, never a path segment, and the registry
 * admits GET/HEAD/POST only):
 *   GET  /git/status?cwd=&sessionId= → porcelain entries + ahead/behind
 *                                          divergence vs the upstream (null
 *                                          without one), grouped client-side
 *   GET  /git/ls?cwd=&sessionId=         → tracked files, capped
 *   GET  /git/show?cwd=&sessionId=&sha=  → commit message + files stat
 *   GET  /git/diff?cwd=&sessionId=&path=&cached=0|1&untracked=0|1 → unified
 *                                          diff (or the whole repo diff when
 *                                          path is absent)
 *   GET  /git/log?cwd=&sessionId=        → `git log --graph --all --oneline`
 *   POST /git/action {cwd, sessionId, op, path?, message?, name?}
 *        op: 'stage' | 'unstage' | 'restore' | 'commit' | 'fetch' | 'pull' |
 *            'push' | 'branch.list' | 'branch.checkout' | 'branch.create' |
 *            'stash.push' | 'stash.pop'
 *        (fetch/pull/push are network ops and carry a hard 120 s deadline;
 *        name is the branch operand of the branch.* ops)
 *
 * Trust is the carrier's: the Connection transport applies its Host/Origin
 * fence and browser authentication before a route handler runs, so these
 * routes hold no fence of their own. The loopback-Host check the old
 * web-server registration needed has no counterpart in the desktop form —
 * the window's own `dsh-app://app` origin delivers every request there, so
 * there is no untrusted origin left to distinguish.
 */

import { execFile } from 'node:child_process'
import pathModule from 'node:path'
import { promisify } from 'node:util'
import type { ConnectionFetchMethod, HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'
import type { HostText } from './host-text.js'

const execFileAsync = promisify(execFile)

const MAX_DIFF_CHARS = 500_000
const MAX_COMMIT_MESSAGE_CHARS = 20_000
const MAX_REPO_FILES = 20_000
/** Hard deadline for network commands (fetch/pull/push); the child gets
 * SIGTERM past it so a stalled remote cannot pin a request forever. */
const NETWORK_TIMEOUT_MS = 120_000
const MAX_BRANCH_NAME_CHARS = 200
const MAX_ERROR_CHARS = 1_000
/** Bounded stdout excerpt returned by pull/push so the client can word the
 * success notice from git's own verdict ("Already up to date." etc.). */
const MAX_SYNC_OUT_CHARS = 1_000
const DEFAULT_STASH_MESSAGE = 'dsh-sidebar auto stash'

/**
 * Route namespace on the shared Connection `/api` channel. The registry admits
 * only path segments matching `[A-Za-z0-9_$.-]`, so the npm scope's `@` cannot
 * appear in the URL: `@dsh-app/plugin-sidebar` travels as
 * `dsh-app/plugin-sidebar`. Mirrored by the client half's own constant.
 */
export const ROUTE_PREFIX = '/api/plugins/dsh-app/plugin-sidebar'

/** One git route's own URL segment, after the plugin prefix. */
type GitRouteName = 'status' | 'ls' | 'show' | 'diff' | 'log' | 'action'

/** The git routes this plugin owns, one exact Fetch route each. */
const GIT_ROUTES: readonly { readonly name: GitRouteName, readonly methods: readonly ConnectionFetchMethod[] }[] = [
  { name: 'status', methods: ['GET'] },
  { name: 'ls', methods: ['GET'] },
  { name: 'show', methods: ['GET'] },
  { name: 'diff', methods: ['GET'] },
  { name: 'log', methods: ['GET'] },
  { name: 'action', methods: ['POST'] },
]

/** The host resolves the session id against the real session store. */
export interface GitSessionScope {
  cwdForSession(sessionId: string): string | undefined
}

/**
 * Register the git face on the Connection exact-Fetch registry.
 *
 * Registration is also the method gate: a route owns its methods, so a request
 * with another method on the same path falls through to the shared channel's
 * own 404 rather than reaching a handler at all.
 *
 * @param connectionFetch - the Connection exact-Fetch registry (`ctx.connection.fetch`).
 * @param scope - session-cwd resolver backing the request fence.
 * @returns disposer removing every route.
 */
export function registerGitRoutes(
  connectionFetch: HostConnectionFetch,
  scope: GitSessionScope,
): () => Promise<void> {
  const disposers = GIT_ROUTES.map(route => connectionFetch.register({
    path: `${ROUTE_PREFIX}/git/${route.name}`,
    methods: route.methods,
    requestBody: 'buffered',
    fetch: request => handleGitRequest(route.name, request, scope),
  }))
  return async () => { for (const dispose of disposers) await dispose() }
}

/**
 * A request validation failure that should not be reported as a git failure.
 *
 * Carries a coded message beside the transport category: the tab renders the
 * copy (`sidebar.fail.*`) in the active language, and `message` stays an
 * English diagnostic for logs and for a reader that does not know the code.
 */
class GitRequestError extends Error {
  /**
   * @param status - HTTP status the route answers with.
   * @param code - transport-ish category the tab branches on.
   * @param message - English diagnostic (what the old zh-CN sentence became).
   * @param hostCode - finer message identity when several messages share one
   *   transport code (the three no-remote variants); defaults to `code`.
   */
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hostCode: string = code,
  ) {
    super(message)
    this.name = 'GitRequestError'
  }

  /** The coded message, in the shape every host route speaks. */
  hostText(): HostText {
    return { code: this.hostCode, text: this.message }
  }
}

/** A network git op exceeded NETWORK_TIMEOUT_MS (client code: git-timeout). */
class GitTimeoutError extends Error {
  constructor() {
    super(`network operation timed out after ${String(NETWORK_TIMEOUT_MS / 1000)} s`)
    this.name = 'GitTimeoutError'
  }

  /** The coded message, in the shape every host route speaks. */
  hostText(): HostText {
    return { code: 'git-timeout', text: this.message }
  }
}

/** Environment baseline: PATH + HOME only (no parent-proc leakage). */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH }
  const home = process.env.HOME ?? process.env.USERPROFILE
  if (home !== undefined) env.HOME = home
  return env
}

/** Optional per-spawn options. */
interface GitRunOptions {
  /** Hard deadline in ms; the child is killed (SIGTERM) past it. */
  timeoutMs?: number
  /** Append the child's stderr to the returned text: push (and fetch)
   * report their human verdict ("Everything up-to-date", transfer stats)
   * on stderr, unlike pull's stdout "Already up to date." */
  mergeStderr?: boolean
}

/** Run one git command; throws the execFile error on a non-zero exit and a
 * GitTimeoutError when a configured timeoutMs deadline elapses. */
async function git(cwd: string, args: string[], options: GitRunOptions = {}): Promise<string> {
  const baseline = process.platform === 'win32' ? 'git.exe' : 'git'
  try {
    const { stdout, stderr } = await execFileAsync(baseline, args, {
      cwd,
      env: gitEnv(),
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs, killSignal: 'SIGTERM' as const }),
    })
    return options.mergeStderr === true ? `${stdout}${stderr}` : stdout
  } catch (error) {
    // execFile's timeout kill is distinguishable via killed + signal, so a
    // stalled fetch/pull/push surfaces as `git-timeout` instead of a bare
    // "command failed" (verified on win32: killed=true, signal=SIGTERM).
    const raw = error as { killed?: boolean, signal?: string | null }
    if (options.timeoutMs !== undefined && raw.killed === true && raw.signal !== undefined && raw.signal !== null) {
      throw new GitTimeoutError()
    }
    throw error
  }
}

/** One porcelain entry (v1: XY path; `??` = untracked). */
export interface GitStatusEntry {
  path: string
  /** Two-letter porcelain status (index, worktree). */
  xy: string
  /** The index-side status character, e.g. `M`, `R`, or a blank. */
  indexStatus: string
  /** The worktree-side status character, e.g. `M`, `D`, or a blank. */
  worktreeStatus: string
  /** Original path for a rename/copy, when Git reports one. */
  originalPath?: string
  /** Compatibility flag for older clients; use indexStatus for grouping. */
  staged: boolean
  untracked: boolean
}

/** Parse `git status --porcelain=v1 -z` output. */
export function parsePorcelain(out: string): GitStatusEntry[] {
  // With -z, rename/copy records are emitted as `XY new\0old\0` (the reverse
  // of the human-readable `old -> new` form). Keep the new path as `path` so
  // all subsequent git pathspecs address the current file.
  const entries: GitStatusEntry[] = []
  const records = out.split('\u0000')
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record === undefined || record.length < 3) continue
    const xy = record.slice(0, 2)
    const path = record.slice(3)
    if (path === '') continue
    const indexStatus = xy[0] ?? ' '
    const worktreeStatus = xy[1] ?? ' '
    const isRenameOrCopy = indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C'
    const originalPath = isRenameOrCopy ? records[index + 1] : undefined
    if (isRenameOrCopy && originalPath !== undefined) index += 1
    entries.push({
      path,
      xy,
      indexStatus,
      worktreeStatus,
      ...(originalPath === undefined || originalPath === '' ? {} : { originalPath }),
      staged: indexStatus !== ' ' && indexStatus !== '?',
      untracked: xy === '??',
    })
  }
  return entries
}

/** Parse the `## branch...origin/branch [ahead N, behind M]` header that
 * `git status -sb` prints as its first line. ahead/behind are null when no
 * upstream is configured (or it is gone); an upstream without a divergence
 * bracket means 0/0. */
export function parseBranchHeader(line: string): { ahead: number | null, behind: number | null } {
  if (!line.startsWith('## ')) return { ahead: null, behind: null }
  const body = line.slice(3)
  // No `...` separator means no upstream. (Ref names may never contain two
  // consecutive dots, so the first `...` is always the separator.)
  if (!body.includes('...')) return { ahead: null, behind: null }
  const info = /\[([^\]]*)\]/u.exec(body)?.[1] ?? ''
  if (info === 'gone') return { ahead: null, behind: null }
  const ahead = /ahead (\d+)/u.exec(info)
  const behind = /behind (\d+)/u.exec(info)
  return {
    ahead: ahead === null ? 0 : Number(ahead[1]),
    behind: behind === null ? 0 : Number(behind[1]),
  }
}

/** Parse `git branch --format=%(refname:short)%00%(HEAD)` into the local
 * branch list plus the current one. A detached HEAD emits a pseudo entry
 * like `(HEAD detached at <sha>)` which is skipped (current stays null). */
export function parseBranchList(out: string): { branches: string[], current: string | null } {
  const branches: string[] = []
  let current: string | null = null
  for (const line of out.split('\n')) {
    const separator = line.indexOf('\u0000')
    const name = (separator === -1 ? line : line.slice(0, separator)).trim()
    if (name === '' || name.startsWith('(')) continue
    if (!branches.includes(name)) branches.push(name)
    const headMark = separator === -1 ? '' : line.slice(separator + 1).trim()
    if (headMark === '*' && current === null) current = name
  }
  return { branches, current }
}

/** Branch names accepted for checkout/create: conservative charset (git ref
 * rules allow more, but this covers real-world names), no leading `..`. */
function isValidBranchName(value: string): boolean {
  return value.length <= MAX_BRANCH_NAME_CHARS && /^[A-Za-z0-9._/-]+$/u.test(value) && !value.startsWith('..')
}

/**
 * Remote to fall back on when the current branch has no upstream: 'origin'
 * when present, else the sole configured remote. Undefined when there is no
 * usable remote at all (none, or several without an 'origin' to disambiguate)
 * — callers turn that into a coded, actionable error instead of letting git
 * choke on a literal 'origin' repo-spec.
 */
async function defaultRemote(scoped: string): Promise<string | undefined> {
  const remotes = (await git(scoped, ['remote'])).split('\n').map(r => r.trim()).filter(r => r !== '')
  if (remotes.includes('origin')) return 'origin'
  return remotes.length === 1 ? remotes[0] : undefined
}

/** Whether the current branch tracks an upstream (plain pull/push works). */
async function hasUpstream(scoped: string): Promise<boolean> {
  try {
    await git(scoped, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    return true
  } catch {
    return false
  }
}

/** Compare a client-provided cwd with the host-owned session cwd safely. */
function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = pathModule.normalize(pathModule.resolve(value)).replace(/[\\/]+$/u, '')
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

/** Git pathspecs from the UI must stay relative to the session repository. */
function isSafeRelativePath(value: string): boolean {
  if (value === '' || value.includes('\u0000') || pathModule.isAbsolute(value) || pathModule.win32.isAbsolute(value)) return false
  const normalized = value.replace(/\\/gu, '/').split('/')
  return !normalized.some(segment => segment === '..')
}

/** Resolve the only cwd a Git request is allowed to use. */
function scopedCwd(scope: GitSessionScope, requestedCwd: string | null, sessionId: string | null): string {
  if (sessionId === null || sessionId === '' || sessionId.length > 256) {
    throw new GitRequestError(400, 'bad-request', 'missing or invalid sessionId')
  }
  if (requestedCwd === null || requestedCwd === '') {
    throw new GitRequestError(400, 'bad-request', 'missing cwd')
  }
  const sessionCwd = scope.cwdForSession(sessionId)
  if (sessionCwd === undefined || sessionCwd === '') {
    throw new GitRequestError(403, 'forbidden', 'session is not available')
  }
  if (!samePath(requestedCwd, sessionCwd)) {
    throw new GitRequestError(403, 'forbidden', 'cwd does not belong to the active session')
  }
  return sessionCwd
}

/** JSON envelope helpers (charset discipline preserved from the web-server era). */
function sendJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

/** One success body. */
function ok(value: unknown): Response {
  return sendJson(200, { ok: true, value })
}

/**
 * One failure body. `host` defaults to the plain category + diagnostic pair,
 * which is right for a message that carries no copy of its own; a message the
 * tab renders from its dictionary passes its own host text instead.
 */
function fail(status: number, code: string, message: string, host: HostText = { code, text: message }): Response {
  return sendJson(status, { ok: false, error: { code, message, host } })
}

/** Cap on one request body: a git action carries paths and messages, nothing bulkier. */
const MAX_BODY_BYTES = 1024 * 1024

/**
 * Bounded JSON body read. The carrier has already buffered the body (the route
 * declares `requestBody: 'buffered'`); this much smaller route limit is checked
 * before parsing so an oversized body can never become a git action.
 */
async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error('request body too large')
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new Error('request body too large')
  const parsed: unknown = JSON.parse(text)
  return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
}

/**
 * Dispatch one already method-gated git request.
 *
 * @param route - the exact route the carrier matched.
 * @param request - the Fetch-shaped request (query parameters carry every operand).
 * @param scope - session-cwd resolver backing the request fence.
 * @returns the route's JSON envelope.
 */
export async function handleGitRequest(route: GitRouteName, request: Request, scope: GitSessionScope): Promise<Response> {
  const url = new URL(request.url)
  try {
    // --- GET routes ------------------------------------------------------
    if (route === 'status') {
      const cwd = scopedCwd(scope, url.searchParams.get('cwd'), url.searchParams.get('sessionId'))
      const out = await git(cwd, ['status', '--porcelain=v1', '-z', '-uall'])
      let branch = ''
      let detached = false
      try {
        branch = (await git(cwd, ['branch', '--show-current'])).trim()
        detached = branch === ''
      } catch {
        detached = true
      }
      // ahead/behind come from the short-format branch header; null when no
      // upstream is configured. Divergence is informational, so a failure of
      // this extra probe must not fail the whole status read.
      let ahead: number | null = null
      let behind: number | null = null
      try {
        const header = (await git(cwd, ['status', '-sb'])).split('\n', 1)[0] ?? ''
        const divergence = parseBranchHeader(header)
        ahead = divergence.ahead
        behind = divergence.behind
      } catch {
        // keep null/null
      }
      return ok({ cwd, branch, detached, ahead, behind, entries: parsePorcelain(out) })
    }
    if (route === 'ls') {
      const cwd = scopedCwd(scope, url.searchParams.get('cwd'), url.searchParams.get('sessionId'))
      const out = await git(cwd, ['ls-files', '-z'])
      const allFiles = out.split('\u0000').filter(line => line !== '')
      const truncated = allFiles.length > MAX_REPO_FILES
      return ok({ files: truncated ? allFiles.slice(0, MAX_REPO_FILES) : allFiles, truncated })
    }
    if (route === 'show') {
      const cwd = scopedCwd(scope, url.searchParams.get('cwd'), url.searchParams.get('sessionId'))
      const sha = url.searchParams.get('sha') ?? ''
      // Parameterized (no shell), still validate: only plain hex SHAs.
      if (!/^[0-9a-f]{4,40}$/.test(sha)) {
        return fail(400, 'bad-request', 'invalid sha')
      }
      // Two structured halves: the full message (title + body) and the
      // files-touched stat. Splitting keeps the client rendering distinct
      // sections instead of one opaque blob.
      const message = await git(cwd, ['log', '-1', '--format=%B', sha])
      const stat = await git(cwd, ['show', '--format=', '--stat', sha])
      return ok({ message, stat })
    }
    if (route === 'diff') {
      const cwd = scopedCwd(scope, url.searchParams.get('cwd'), url.searchParams.get('sessionId'))
      const path = url.searchParams.get('path')
      const cached = url.searchParams.get('cached') === '1'
      const untracked = url.searchParams.get('untracked') === '1'
      if (path !== null && !isSafeRelativePath(path)) {
        throw new GitRequestError(400, 'bad-request', 'invalid relative path')
      }
      if (untracked && (cached || path === null || path === '')) {
        throw new GitRequestError(400, 'bad-request', 'untracked diff requires a worktree path')
      }
      const args = ['diff']
      if (untracked) args.push('--no-index')
      if (cached) args.push('--cached')
      args.push('--no-ext-diff', '--no-color')
      if (untracked && path !== null && path !== '') {
        args.push('--', process.platform === 'win32' ? 'NUL' : '/dev/null', path)
      } else if (path !== null && path !== '') {
        args.push('--', path)
      }
      let out: string
      try {
        out = await git(cwd, args)
      } catch (error) {
        // `git diff --no-index` uses exit code 1 to mean "differences found".
        const raw = error as { code?: number | string, stdout?: string }
        if (!untracked || (raw.code !== 1 && raw.code !== '1') || raw.stdout === undefined) throw error
        out = raw.stdout
      }
      const truncated = out.length > MAX_DIFF_CHARS
      return ok({ text: truncated ? out.slice(0, MAX_DIFF_CHARS) : out, truncated })
    }
    if (route === 'log') {
      const cwd = scopedCwd(scope, url.searchParams.get('cwd'), url.searchParams.get('sessionId'))
      const out = await git(cwd, ['log', '--graph', '--all', '--oneline', '--decorate', '-40'])
      return ok({ text: out })
    }
    // --- POST action route ----------------------------------------------
    if (route === 'action') {
      const body = await readJsonBody(request)
      const cwd = typeof body.cwd === 'string' ? body.cwd : ''
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null
      const op = typeof body.op === 'string' ? body.op : ''
      if (cwd === '' || op === '') {
        return fail(400, 'bad-request', 'cwd and op are required')
      }
      const scoped = scopedCwd(scope, cwd, sessionId)
      const path = typeof body.path === 'string' && body.path !== '' ? body.path : undefined
      const message = typeof body.message === 'string' ? body.message : undefined
      const name = typeof body.name === 'string' && body.name !== '' ? body.name : undefined
      if (path !== undefined && !isSafeRelativePath(path)) {
        throw new GitRequestError(400, 'bad-request', 'invalid relative path')
      }
      let value: unknown = {}
      if (op === 'stage' && path !== undefined) await git(scoped, ['add', '--', path])
      else if (op === 'stage') await git(scoped, ['add', '-A'])
      else if (op === 'unstage' && path !== undefined) await git(scoped, ['restore', '--staged', '--', path])
      else if (op === 'unstage') await git(scoped, ['restore', '--staged', '--', '.'])
      else if (op === 'restore' && path !== undefined) await git(scoped, ['restore', '--', path])
      else if (op === 'commit' && message !== undefined && message.trim() !== '') {
        if (message.length > MAX_COMMIT_MESSAGE_CHARS) {
          throw new GitRequestError(400, 'bad-request', 'commit message is too long')
        }
        await git(scoped, ['commit', '-m', message])
      }
      // --- sync group: network commands with a hard deadline --------------
      else if (op === 'fetch') {
        const remote = await defaultRemote(scoped)
        if (remote === undefined) {
          throw new GitRequestError(
            400, 'no-remote', 'no usable remote is configured, so fetching is impossible', 'git.noRemoteSync',
          )
        }
        await git(scoped, ['fetch', '--prune', remote], { timeoutMs: NETWORK_TIMEOUT_MS })
      } else if (op === 'pull') {
        let out: string
        if (await hasUpstream(scoped)) {
          out = await git(scoped, ['pull', '--ff-only'], { timeoutMs: NETWORK_TIMEOUT_MS, mergeStderr: true })
        } else {
          // No tracking yet: pull the same branch from the default remote
          // (this is what git's own hint suggests) instead of failing.
          const remote = await defaultRemote(scoped)
          if (remote === undefined) {
            throw new GitRequestError(
              400, 'no-remote', 'no usable remote is configured, so pulling is impossible', 'git.noRemotePull',
            )
          }
          const branch = (await git(scoped, ['branch', '--show-current'])).trim()
          if (branch === '') {
            throw new GitRequestError(
              400, 'detached-head', 'the repository is on a detached HEAD, so pulling is impossible', 'git.detachedPull',
            )
          }
          out = await git(scoped, ['pull', '--ff-only', remote, branch], { timeoutMs: NETWORK_TIMEOUT_MS, mergeStderr: true })
        }
        value = { out: out.slice(0, MAX_SYNC_OUT_CHARS) }
      } else if (op === 'push') {
        // Plain `git push` is a dead end without an upstream; set it in the
        // same step instead. (Local divergence errors are simply git stderr.)
        let out: string
        if (await hasUpstream(scoped)) {
          out = await git(scoped, ['push'], { timeoutMs: NETWORK_TIMEOUT_MS, mergeStderr: true })
        } else {
          const remote = await defaultRemote(scoped)
          if (remote === undefined) {
            throw new GitRequestError(
              400, 'no-remote', 'no usable remote is configured, so pushing is impossible', 'git.noRemotePush',
            )
          }
          out = await git(scoped, ['push', '-u', remote, 'HEAD'], { timeoutMs: NETWORK_TIMEOUT_MS, mergeStderr: true })
        }
        value = { out: out.slice(0, MAX_SYNC_OUT_CHARS) }
      }
      // --- branch group ----------------------------------------------------
      else if (op === 'branch.list') {
        value = parseBranchList(await git(scoped, ['branch', '--format=%(refname:short)%00%(HEAD)']))
      } else if (op === 'branch.checkout' || op === 'branch.create') {
        if (name === undefined) {
          throw new GitRequestError(400, 'bad-request', 'a branch name is required', 'git.branchNameMissing')
        }
        if (!isValidBranchName(name)) {
          throw new GitRequestError(
            400, 'bad-request',
            'invalid branch name (letters, digits, dot, underscore, hyphen and slash only; no leading "..")',
            'git.branchNameInvalid',
          )
        }
        // A dirty worktree that blocks the checkout surfaces as git stderr.
        await git(scoped, op === 'branch.create' ? ['checkout', '-b', name] : ['checkout', name])
      }
      // --- stash group -------------------------------------------------------
      else if (op === 'stash.push') {
        if (message !== undefined && message.length > MAX_COMMIT_MESSAGE_CHARS) {
          throw new GitRequestError(400, 'bad-request', 'stash message is too long')
        }
        await git(scoped, ['stash', 'push', '-u', '-m', message ?? DEFAULT_STASH_MESSAGE])
      } else if (op === 'stash.pop') await git(scoped, ['stash', 'pop'])
      else {
        return fail(400, 'bad-request', `unsupported git action: ${op}`)
      }
      return ok(value)
    }
    // Not reachable through the registry (every name it can compose has a
    // branch above): a route name added without one answers 404 instead of
    // leaving the request unanswered.
    return fail(404, 'not-found', `unknown git route: ${route}`)
  } catch (error) {
    if (error instanceof GitRequestError) {
      return fail(error.status, error.code, error.message, error.hostText())
    }
    if (error instanceof GitTimeoutError) {
      return fail(504, 'git-timeout', error.message, error.hostText())
    }
    const raw = error as { code?: string, stdout?: string, stderr?: string, message?: string }
    // execFile non-zero exit: git's own message is the diagnostic the tab
    // shows inside its sentence frame (it names the actual failure).
    // Some failures report through stdout instead of stderr — merge-class
    // conflicts from `git stash pop` print there — so fall back to a
    // bounded stdout excerpt before the bare "command failed" message.
    const detail = raw.stderr !== undefined && raw.stderr !== ''
      ? raw.stderr
      : raw.stdout !== undefined && raw.stdout !== ''
        ? raw.stdout.slice(0, MAX_ERROR_CHARS)
        : raw.message ?? 'git failed'
    const code = raw.code === 'ENOENT' ? 'git-missing' : 'git-error'
    return fail(code === 'git-missing' ? 500 : 400, code, detail)
  }
}
