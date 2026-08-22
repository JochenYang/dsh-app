/**
 * Host-side git routes for the sidebar dock (Git tab).
 *
 * One `git` binary spawned per request, never a library and no retained
 * state — the client owns nothing; repo identity comes from the request's
 * `cwd` (the active session workspace; git resolves the real repository
 * upward from there). Every spawn uses execFile with an argument array (no
 * shell, no injection surface), `windowsHide: true` (a console flash per
 * spawn is a known regression class), and an env baseline carrying only
 * PATH + HOME — parent-proc pollution is another known regression class.
 *
 * Routes:
 *   GET  /api/git/status?cwd=          → porcelain entries, grouped client-side
 *   GET  /api/git/diff?cwd=&path=&cached=0|1 → unified diff (or the whole
 *                                          repo diff when path is absent)
 *   GET  /api/git/log?cwd=             → `git log --graph --all --oneline` tail
 *   POST /api/git/action {cwd, op, path?, message?}
 *        op: 'stage' | 'unstage' | 'restore' | 'commit'
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { IncomingMessage, ServerResponse } from 'node:http'

const execFileAsync = promisify(execFile)

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
  /** Two-letter index; staged flag drives the client groups. */
  xy: string
  staged: boolean
  untracked: boolean
}

/** Parse `git status --porcelain=v1 -z` output. */
function parsePorcelain(out: string): GitStatusEntry[] {
  // -z NUL-separates; each record is "XY path" or "XY -> new" for renames.
  const entries: GitStatusEntry[] = []
  for (const record of out.split('\u0000')) {
    if (record.length < 4) continue
    const xy = record.slice(0, 2)
    const path = record.slice(3)
    if (path === '') continue
    entries.push({
      path,
      xy,
      staged: xy[0] !== ' ' && xy[0] !== '?',
      untracked: xy === '??',
    })
  }
  return entries
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
export async function handleGitRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const route = url.pathname.split('/').pop()
  try {
    // --- GET routes ------------------------------------------------------
    if (req.method === 'GET' && route === 'status') {
      const cwd = url.searchParams.get('cwd')
      if (cwd === null || cwd === '') {
        writeError(res, 400, 'bad-request', 'missing cwd query parameter')
        return
      }
      const out = await git(cwd, ['status', '--porcelain=v1', '-z', '-uall'])
      let branch = ''
      try {
        branch = (await git(cwd, ['branch', '--show-current'])).trim()
      } catch { /* detached/headless repo: the branch row stays empty */ }
      writeJson(res, 200, { ok: true, value: { cwd, branch, entries: parsePorcelain(out) } })
      return
    }
    if (req.method === 'GET' && route === 'ls') {
      const cwd = url.searchParams.get('cwd')
      if (cwd === null || cwd === '') {
        writeError(res, 400, 'bad-request', 'missing cwd query parameter')
        return
      }
      const out = await git(cwd, ['ls-files'])
      const files = out.split('\n').filter(line => line !== '')
      writeJson(res, 200, { ok: true, value: { files } })
      return
    }
    if (req.method === 'GET' && route === 'show') {
      const cwd = url.searchParams.get('cwd')
      const sha = url.searchParams.get('sha') ?? ''
      if (cwd === null || cwd === '') {
        writeError(res, 400, 'bad-request', 'missing cwd query parameter')
        return
      }
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
      const cwd = url.searchParams.get('cwd')
      const path = url.searchParams.get('path')
      const cached = url.searchParams.get('cached') === '1'
      if (cwd === null || cwd === '') {
        writeError(res, 400, 'bad-request', 'missing cwd query parameter')
        return
      }
      const args = ['diff']
      if (cached) args.push('--cached')
      if (path !== null && path !== '') {
        args.push('--', path)
      }
      const out = await git(cwd, args)
      writeJson(res, 200, { ok: true, value: { text: out } })
      return
    }
    if (req.method === 'GET' && route === 'log') {
      const cwd = url.searchParams.get('cwd')
      if (cwd === null || cwd === '') {
        writeError(res, 400, 'bad-request', 'missing cwd query parameter')
        return
      }
      const out = await git(cwd, ['log', '--graph', '--all', '--oneline', '--decorate', '-40'])
      writeJson(res, 200, { ok: true, value: { text: out } })
      return
    }
    // --- POST action route ----------------------------------------------
    if (req.method === 'POST' && route === 'action') {
      const body = await readJsonBody(req)
      const cwd = typeof body.cwd === 'string' ? body.cwd : ''
      const op = typeof body.op === 'string' ? body.op : ''
      if (cwd === '' || op === '') {
        writeError(res, 400, 'bad-request', 'cwd and op are required')
        return
      }
      const path = typeof body.path === 'string' && body.path !== '' ? body.path : undefined
      const message = typeof body.message === 'string' ? body.message : undefined
      if (op === 'stage' && path !== undefined) await git(cwd, ['add', '--', path])
      else if (op === 'stage') await git(cwd, ['add', '-A'])
      else if (op === 'unstage' && path !== undefined) await git(cwd, ['restore', '--staged', '--', path])
      else if (op === 'restore' && path !== undefined) await git(cwd, ['restore', '--', path])
      else if (op === 'commit' && message !== undefined && message.trim() !== '') {
        await git(cwd, ['commit', '-m', message])
      } else {
        writeError(res, 400, 'bad-request', `unsupported git action: ${op}`)
        return
      }
      writeJson(res, 200, { ok: true, value: {} })
      return
    }
    writeError(res, 404, 'not-found', `unknown git route: ${url.pathname}`)
  } catch (error) {
    const raw = error as { code?: string, stdout?: string, stderr?: string, message?: string }
    // execFile non-zero exit: route the git message to the user verbatim
    // (it names the actual failure; the client shows it in zh wording).
    const message = raw.stderr !== undefined && raw.stderr !== '' ? raw.stderr : raw.message ?? 'git failed'
    const code = raw.code === 'ENOENT' ? 'git-missing' : 'git-error'
    writeError(res, code === 'git-missing' ? 500 : 400, code, message)
  }
}
