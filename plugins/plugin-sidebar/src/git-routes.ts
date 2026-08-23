/**
 * Host-side git routes for the sidebar dock (Git tab).
 *
 * One `git` binary spawned per request, never a library and no retained
 * state — the client owns nothing; repo identity comes from the host-resolved
 * session cwd, while the request cwd is only a consistency check. Git resolves
 * the real repository upward from there. Every spawn uses execFile with an argument array (no
 * shell, no injection surface), `windowsHide: true` (a console flash per
 * spawn is a known regression class), and an env baseline carrying only
 * PATH + HOME — parent-proc pollution is another known regression class.
 *
 * Routes:
 *   GET  /api/git/status?cwd=&sessionId= → porcelain entries, grouped client-side
 *   GET  /api/git/diff?cwd=&sessionId=&path=&cached=0|1 → unified diff (or the
 *                                          whole repo diff when path is absent)
 *   GET  /api/git/log?cwd=&sessionId=   → `git log --graph --all --oneline` tail
 *   POST /api/git/action {cwd, sessionId, op, path?, message?}
 *        op: 'stage' | 'unstage' | 'restore' | 'commit'
 */

import { execFile } from 'node:child_process'
import pathModule from 'node:path'
import { promisify } from 'node:util'
import type { IncomingMessage, ServerResponse } from 'node:http'

const execFileAsync = promisify(execFile)

const MAX_DIFF_CHARS = 500_000
const MAX_COMMIT_MESSAGE_CHARS = 20_000
const MAX_REPO_FILES = 20_000

/** The host resolves the session id against the real session store. */
export interface GitSessionScope {
  cwdForSession(sessionId: string): string | undefined
}

/** A request validation failure that should not be reported as a git failure. */
class GitRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

/** Environment baseline: PATH + HOME only (no parent-proc leakage). */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH }
  const home = process.env.HOME ?? process.env.USERPROFILE
  if (home !== undefined) env.HOME = home
  return env
}

/** Run one git command; throws GitError on a non-zero exit. */
async function git(cwd: string, args: string[]): Promise<string> {
  const baseline = process.platform === 'win32' ? 'git.exe' : 'git'
  const { stdout, stderr } = await execFileAsync(baseline, args, {
    cwd,
    env: gitEnv(),
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout
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

/** JSON envelope helpers (charset discipline mirrors the fs routes). */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}
function writeError(res: ServerResponse, status: number, code: string, message: string): void {
  writeJson(res, status, { ok: false, error: { code, message } })
}

/** Read a bounded JSON POST body. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > 1024 * 1024) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
}

/** Dispatch one git request under the plugin's fenced prefix. */
export async function handleGitRequest(req: IncomingMessage, res: ServerResponse, url: URL, scope: GitSessionScope): Promise<void> {
  const route = url.pathname.split('/').pop()
  try {
    // --- GET routes ------------------------------------------------------
    if (req.method === 'GET' && route === 'status') {
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
      writeJson(res, 200, { ok: true, value: { cwd, branch, detached, entries: parsePorcelain(out) } })
      return
    }
    if (req.method === 'GET' && route === 'ls') {
      const cwd = scopedCwd(scope, url.searchParams.get('cwd'), url.searchParams.get('sessionId'))
      const out = await git(cwd, ['ls-files', '-z'])
      const allFiles = out.split('\u0000').filter(line => line !== '')
      const truncated = allFiles.length > MAX_REPO_FILES
      writeJson(res, 200, { ok: true, value: { files: truncated ? allFiles.slice(0, MAX_REPO_FILES) : allFiles, truncated } })
      return
    }
    if (req.method === 'GET' && route === 'show') {
      const cwd = scopedCwd(scope, url.searchParams.get('cwd'), url.searchParams.get('sessionId'))
      const sha = url.searchParams.get('sha') ?? ''
      // Parameterized (no shell), still validate: only plain hex SHAs.
      if (!/^[0-9a-f]{4,40}$/.test(sha)) {
        writeError(res, 400, 'bad-request', 'invalid sha')
        return
      }
      // Two structured halves: the full message (title + body) and the
      // files-touched stat. Splitting keeps the client rendering distinct
      // sections instead of one opaque blob.
      const message = await git(cwd, ['log', '-1', '--format=%B', sha])
      const stat = await git(cwd, ['show', '--format=', '--stat', sha])
      writeJson(res, 200, { ok: true, value: { message, stat } })
      return
    }
    if (req.method === 'GET' && route === 'diff') {
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
      writeJson(res, 200, { ok: true, value: { text: truncated ? out.slice(0, MAX_DIFF_CHARS) : out, truncated } })
      return
    }
    if (req.method === 'GET' && route === 'log') {
      const cwd = scopedCwd(scope, url.searchParams.get('cwd'), url.searchParams.get('sessionId'))
      const out = await git(cwd, ['log', '--graph', '--all', '--oneline', '--decorate', '-40'])
      writeJson(res, 200, { ok: true, value: { text: out } })
      return
    }
    // --- POST action route ----------------------------------------------
    if (req.method === 'POST' && route === 'action') {
      const body = await readJsonBody(req)
      const cwd = typeof body.cwd === 'string' ? body.cwd : ''
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null
      const op = typeof body.op === 'string' ? body.op : ''
      if (cwd === '' || op === '') {
        writeError(res, 400, 'bad-request', 'cwd and op are required')
        return
      }
      const scoped = scopedCwd(scope, cwd, sessionId)
      const path = typeof body.path === 'string' && body.path !== '' ? body.path : undefined
      const message = typeof body.message === 'string' ? body.message : undefined
      if (path !== undefined && !isSafeRelativePath(path)) {
        throw new GitRequestError(400, 'bad-request', 'invalid relative path')
      }
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
      } else {
        writeError(res, 400, 'bad-request', `unsupported git action: ${op}`)
        return
      }
      writeJson(res, 200, { ok: true, value: {} })
      return
    }
    writeError(res, 404, 'not-found', `unknown git route: ${url.pathname}`)
  } catch (error) {
    if (error instanceof GitRequestError) {
      writeError(res, error.status, error.code, error.message)
      return
    }
    const raw = error as { code?: string, stdout?: string, stderr?: string, message?: string }
    // execFile non-zero exit: route the git message to the user verbatim
    // (it names the actual failure; the client shows it in zh wording).
    const message = raw.stderr !== undefined && raw.stderr !== '' ? raw.stderr : raw.message ?? 'git failed'
    const code = raw.code === 'ENOENT' ? 'git-missing' : 'git-error'
    writeError(res, code === 'git-missing' ? 500 : 400, code, message)
  }
}
