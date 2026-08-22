/**
 * Host-side filesystem routes for the sidebar dock (M1 scope: read-only).
 *
 * Two routes under /plugins/@dsh-app/plugin-sidebar/fs:
 *   GET .../fs/list?dir=<abs>   → one directory's entries (lazy tree level)
 *   GET .../fs/file?path=<abs>  → one file's previewable content
 *
 * Contract notes:
 * - Every response carries `application/json; charset=utf-8` — a missing
 *   charset is exactly how UTF-8 Chinese content renders as mojibake.
 * - Reads are bounded (MAX_READ_BYTES) and binary files answer by kind:
 *   images come back base64, other binaries answer `unsupported`.
 * - Read scope is the local user's own disk behind the loopback fence (the
 *   same trust posture as the official directory picker); WRITE scoping to
 *   the session workspace arrives with M3 and is fenced separately.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** One directory entry as the tree consumes it. */
export interface FsListEntry {
  name: string
  kind: 'dir' | 'file' | 'broken-link'
  /** File size in bytes when known without following links. */
  size?: number
}

/** Bounded read: larger files answer truncated/unsupported, never hang. */
const MAX_READ_BYTES = 2 * 1024 * 1024

/** JSON error codes of the fs routes. */
export type FsErrorCode = 'bad-request' | 'not-found' | 'not-a-dir' | 'fs-error' | 'too-large' | 'internal'

/** Write one JSON answer with the charset every text response must carry. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(payload)
}

/** Write one {ok:false,error} answer. */
function writeError(res: ServerResponse, status: number, code: FsErrorCode, message: string): void {
  writeJson(res, status, { ok: false, error: { code, message } })
}

/** Query param extraction (`searchParams.get` with a non-empty check). */
function param(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key)
  return value === null || value === '' ? undefined : value
}

/** Whether a buffer is textual enough to inline as UTF-8 content. */
function looksTextual(head: Buffer): boolean {
  for (const byte of head) {
    // NUL never occurs in text; other C0 controls outside \t\n\r are suspect.
    if (byte === 0 || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d)) return false
  }
  return true
}

/** The image types the preview pane renders inline, by magic prefix. */
function sniffImage(head: Buffer): string | undefined {
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (head.length >= 6 && head.subarray(0, 6).toString('latin1').startsWith('GIF8')) return 'image/gif'
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (head.length >= 5 && head.subarray(0, 5).toString('utf8').startsWith('<svg ')) return 'image/svg+xml'
  return undefined
}

/**
 * GET .../fs/list?dir=<abs> — one directory level, dirs first then files,
 * both case-insensitive. Symlinked entries appear by target kind; a link
 * whose target cannot be stat'd marks `broken-link` instead of failing the
 * whole listing.
 */
async function handleList(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const dir = param(url, 'dir')
  if (dir === undefined) {
    writeError(res, 400, 'bad-request', 'missing dir query parameter')
    return
  }
  let names: Dirent[]
  try {
    names = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      writeError(res, 404, 'not-found', `no such directory: ${dir}`)
      return
    }
    if (code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') {
      writeError(res, 403, 'not-a-dir', `cannot list: ${dir}`)
      return
    }
    writeError(res, 500, 'fs-error', `list failed (${code ?? 'unknown'})`)
    return
  }
  const entries: FsListEntry[] = []
  await Promise.all(names.map(async (dirent) => {
    // Classify links by their target when reachable, so a linked directory
    // still expands in the tree; an unreachable target marks broken-link
    // instead of failing the whole listing.
    try {
      if (dirent.isSymbolicLink()) {
        const target = await stat(`${dir}/${dirent.name}`)
        entries.push(target.isDirectory()
          ? { name: dirent.name, kind: 'dir' }
          : { name: dirent.name, kind: 'file', size: target.size })
        return
      }
      entries.push(dirent.isDirectory()
        ? { name: dirent.name, kind: 'dir' }
        : { name: dirent.name, kind: 'file', size: await stat(`${dir}/${dirent.name}`).then(i => i.size).catch(() => undefined) })
    } catch {
      entries.push({ name: dirent.name, kind: dirent.isSymbolicLink() ? 'broken-link' : 'file' })
    }
  }))
  const byKind = (kind: FsListEntry['kind']): number => (kind === 'dir' ? 0 : kind === 'file' ? 1 : 2)
  entries.sort((a, b) => byKind(a.kind) - byKind(b.kind) || a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true }))
  writeJson(res, 200, { ok: true, value: { dir, entries } })
}

/**
 * GET .../fs/file?path=<abs> — one file's preview content, bounded.
 */
async function handleFile(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = param(url, 'path')
  if (path === undefined) {
    writeError(res, 400, 'bad-request', 'missing path query parameter')
    return
  }
  let info
  try {
    info = await stat(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      writeError(res, 404, 'not-found', `no such file: ${path}`)
      return
    }
    writeError(res, 500, 'fs-error', `stat failed (${code ?? 'unknown'})`)
    return
  }
  if (info.isDirectory()) {
    writeError(res, 400, 'not-a-dir', 'path is a directory')
    return
  }
  if (info.size > MAX_READ_BYTES) {
    writeJson(res, 200, { ok: true, value: { path, kind: 'unsupported', reason: `文件超过预览上限（${String(Math.round(info.size / 1024 / 1024))}MB）` } })
    return
  }
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    writeError(res, 500, 'fs-error', `read failed (${code ?? 'unknown'})`)
    return
  }
  const imageMime = sniffImage(bytes.subarray(0, 16))
  if (imageMime !== undefined) {
    writeJson(res, 200, { ok: true, value: { path, kind: 'image', mime: imageMime, dataBase64: bytes.toString('base64') } })
    return
  }
  if (!looksTextual(bytes.subarray(0, 4096))) {
    writeJson(res, 200, { ok: true, value: { path, kind: 'unsupported', reason: '二进制文件不支持预览' } })
    return
  }
  writeJson(res, 200, { ok: true, value: { path, kind: 'text', content: bytes.toString('utf8'), size: bytes.length } })
}

/**
 * Dispatch one fenced fs request. Unknown paths under the prefix 404.
 * @returns nothing; the response is fully written here.
 */
export async function handleFsRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const route = url.pathname.split('/').pop()
  try {
    if (route === 'list') return await handleList(req, res, url)
    if (route === 'file') return await handleFile(req, res, url)
    writeError(res, 404, 'not-found', `unknown fs route: ${url.pathname}`)
  } catch (error) {
    writeError(res, 500, 'internal', `unhandled: ${error instanceof Error ? error.message : String(error)}`)
  }
}
