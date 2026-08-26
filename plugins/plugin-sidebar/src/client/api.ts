/**
 * Typed client for the sidebar dock's host fs routes (M1: read-only).
 * Same-origin fetch against the dsh web server; the host fence admits
 * loopback-Host requests, which every same-origin browser request is.
 */

import type { FsListEntry } from '../fs-routes.ts'

/**
 * The plugin's route prefix on the dsh web server (mirrors the host half;
 * the /api segment keeps clear of the loader-owned client.js bundle route).
 */
export const ROUTE_PREFIX = '/plugins/@dsh-app/plugin-sidebar/api'

/** One fs API failure. */
export class FsApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

/** Envelope of every fs answer. */
interface FsEnvelope<T> {
  ok: boolean
  value?: T
  error?: { code: string, message: string }
}

/** One fenced GET. */
async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin' })
  const body = await response.json() as FsEnvelope<T>
  if (!body.ok || body.value === undefined) {
    throw new FsApiError(body.error?.code ?? 'unknown', body.error?.message ?? `HTTP ${String(response.status)}`)
  }
  return body.value
}

/** One fenced POST with a JSON body. */
async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })
  const parsed = await response.json() as FsEnvelope<T>
  if (!parsed.ok || parsed.value === undefined) {
    throw new FsApiError(parsed.error?.code ?? 'unknown', parsed.error?.message ?? `HTTP ${String(response.status)}`)
  }
  return parsed.value
}

/** List one directory level (lazy tree node). */
export function listDir(dir: string): Promise<{ dir: string, entries: FsListEntry[] }> {
  return get(`${ROUTE_PREFIX}/fs/list?dir=${encodeURIComponent(dir)}`)
}

/** One file's previewable content. */
export type FileContent =
  | { kind: 'text', content: string, size: number }
  | { kind: 'image', mime: string, dataBase64: string }
  | { kind: 'unsupported', reason: string }

export function readFile(path: string): Promise<FileContent> {
  return get<FileContent>(`${ROUTE_PREFIX}/fs/file?path=${encodeURIComponent(path)}`)
}

// --- git face ---------------------------------------------------------------

/** One porcelain entry as the host parsed it. */
export interface GitStatusEntry {
  path: string
  xy: string
  indexStatus: string
  worktreeStatus: string
  originalPath?: string
  staged: boolean
  untracked: boolean
}

function sessionQuery(sessionId: string | undefined): string {
  return sessionId === undefined ? '' : `&sessionId=${encodeURIComponent(sessionId)}`
}

/** Local branch list from the `branch.list` action. */
export interface GitBranchList {
  branches: string[]
  current: string | null
}

/** Action response: pull/push carry a bounded git stdout excerpt so the UI
 * can word the success notice from git's own verdict. */
export interface GitActionValue {
  out?: string
}

/** The host git routes. */
export const gitApi = {
  status(cwd: string, sessionId?: string): Promise<{ cwd: string, branch: string, detached: boolean, ahead: number | null, behind: number | null, entries: GitStatusEntry[] }> {
    return get(`${ROUTE_PREFIX}/git/status?cwd=${encodeURIComponent(cwd)}${sessionQuery(sessionId)}`)
  },
  show(cwd: string, sha: string, sessionId?: string): Promise<{ message: string, stat: string }> {
    return get(`${ROUTE_PREFIX}/git/show?cwd=${encodeURIComponent(cwd)}&sha=${encodeURIComponent(sha)}${sessionQuery(sessionId)}`)
  },
  diff(cwd: string, path?: string, cached = false, sessionId?: string, untracked = false): Promise<{ text: string, truncated?: boolean }> {
    const suffix = path === undefined ? '' : `&path=${encodeURIComponent(path)}`
    return get(`${ROUTE_PREFIX}/git/diff?cwd=${encodeURIComponent(cwd)}${suffix}&cached=${cached ? '1' : '0'}&untracked=${untracked ? '1' : '0'}${sessionQuery(sessionId)}`)
  },
  log(cwd: string, sessionId?: string): Promise<{ text: string }> {
    return get(`${ROUTE_PREFIX}/git/log?cwd=${encodeURIComponent(cwd)}${sessionQuery(sessionId)}`)
  },
  ls(cwd: string, sessionId?: string): Promise<{ files: string[], truncated?: boolean }> {
    return get(`${ROUTE_PREFIX}/git/ls?cwd=${encodeURIComponent(cwd)}${sessionQuery(sessionId)}`)
  },
  branchList(cwd: string, sessionId?: string): Promise<GitBranchList> {
    return post(`${ROUTE_PREFIX}/git/action`, { op: 'branch.list', cwd, sessionId })
  },
  action(op: string, cwd: string, path?: string, message?: string, sessionId?: string, name?: string): Promise<GitActionValue> {
    return post(`${ROUTE_PREFIX}/git/action`, {
      op,
      cwd,
      sessionId,
      ...path === undefined ? {} : { path },
      ...message === undefined ? {} : { message },
      ...name === undefined ? {} : { name },
    })
  },
}
