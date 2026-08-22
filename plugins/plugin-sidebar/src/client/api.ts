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
  staged: boolean
  untracked: boolean
}

/** The host git routes. */
export const gitApi = {
  status(cwd: string): Promise<{ cwd: string, branch: string, entries: GitStatusEntry[] }> {
    return get(`${ROUTE_PREFIX}/git/status?cwd=${encodeURIComponent(cwd)}`)
  },
  show(cwd: string, sha: string): Promise<{ message: string, stat: string }> {
    return get(`${ROUTE_PREFIX}/git/show?cwd=${encodeURIComponent(cwd)}&sha=${encodeURIComponent(sha)}`)
  },
  diff(cwd: string, path?: string, cached = false): Promise<{ text: string }> {
    const suffix = path === undefined ? '' : `&path=${encodeURIComponent(path)}`
    return get(`${ROUTE_PREFIX}/git/diff?cwd=${encodeURIComponent(cwd)}${suffix}&cached=${cached ? '1' : '0'}`)
  },
  log(cwd: string): Promise<{ text: string }> {
    return get(`${ROUTE_PREFIX}/git/log?cwd=${encodeURIComponent(cwd)}`)
  },
  ls(cwd: string): Promise<{ files: string[] }> {
    return get(`${ROUTE_PREFIX}/git/ls?cwd=${encodeURIComponent(cwd)}`)
  },
  action(op: string, cwd: string, path?: string, message?: string): Promise<Record<string, never>> {
    return fetch(`${ROUTE_PREFIX}/git/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ op, cwd, ...path === undefined ? {} : { path }, ...message === undefined ? {} : { message } }),
    }).then(async (response) => {
      const body = await response.json() as FsEnvelope<Record<string, never>>
      if (!body.ok) throw new FsApiError(body.error?.code ?? 'unknown', body.error?.message ?? `HTTP ${String(response.status)}`)
      return body.value ?? {}
    })
  },
}
