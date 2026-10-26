/**
 * Media preview of the Git tab's right pane.
 *
 * `git diff` cannot describe an image: it answers one line —
 * `Binary files a/logo.svg and b/logo.svg differ` — so a pane that renders the
 * diff TEXT has nothing to show for exactly the files a reader most wants to
 * see. The tab therefore addresses the file itself through the host's
 * authenticated `/api/file` route (the same route upstream's Markdown image
 * links use) and lets the browser's own static image mode paint it.
 *
 * SVG is deliberately in that set: its bytes reach an `<img>`, never the
 * document, so a committed SVG cannot run script in the app origin. The route
 * also answers `Content-Security-Policy: sandbox; default-src 'none'`, which
 * covers a reader who navigates to the URL directly.
 *
 * Everything here is pure — a base URI is passed in rather than read from
 * `document` — so the route shape is testable without a renderer.
 *
 * @module @dsh-app/plugin-sidebar/client/media
 */

/**
 * Media types the host route can serve and the browser can paint inline, keyed
 * by lower-case extension.
 *
 * Deliberately NOT upstream's `classifyLinkPath`: that answers "which glyph
 * does this link get", and it folds `tiff`/`heic`-style extensions into
 * `image` as well. A preview needs the narrower question — "will an `<img>`
 * element render this" — because a wrong yes is a broken pane.
 */
const PREVIEWABLE = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif',
])

/** The extension of a path, lower-case and without its dot (`''` when none). */
function extensionOf(path: string): string {
  const name = path.replaceAll('\\', '/').split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * Whether one repository path is an image this pane can paint.
 * @param path - the repository-relative path Git reported.
 * @returns true for a previewable image suffix.
 */
export function isPreviewableImage(path: string): boolean {
  return PREVIEWABLE.has(extensionOf(path))
}

/** Whether a path already names an absolute location (drive letter or root). */
function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith('/') || path.startsWith('\\')
}

/**
 * Resolve a repository-relative path against the session workspace root.
 *
 * Git always reports pathspec paths relative to the repository root, which is
 * the session cwd only when the session sits at the top of the tree. The
 * separator follows the ROOT's own style while a relative portion's own
 * separators are normalised to that style too — a root of `D:\repo` with a
 * Git path of `sub/logo.png` would otherwise produce `D:\repo\sub/logo.png`,
 * which a Windows host refuses to treat as absolute.
 *
 * @param cwd - absolute session workspace root.
 * @param path - repository-relative path from `git status` / `git ls-files`.
 * @returns the absolute path, or the input unchanged when it is already one.
 */
export function workspaceAbsolutePath(cwd: string, path: string): string {
  if (isAbsolutePath(path)) return path
  const root = cwd.replace(/[/\\]+$/u, '')
  const separator = root.includes('\\') ? '\\' : '/'
  const relative = path.replace(/^[/\\]+/u, '').replace(/[\\/]+/gu, separator)
  return `${root}${separator}${relative}`
}

/**
 * Build the authenticated file URL for one absolute path.
 *
 * @param base - the document base URI (`document.baseURI`), which carries the
 *   deployment prefix: the app origin serves everything under it.
 * @param path - absolute path to read.
 * @returns the route URL, or undefined for an unsupported base or a path the
 *   route would refuse anyway (relative, UNC, or containing control bytes).
 */
export function mediaRouteUrl(base: string, path: string): string | undefined {
  if (!/^https?:/iu.test(base) && !base.startsWith('dsh-app://app/')) return undefined
  if (!isAbsolutePath(path) || /^[/\\]{2}/u.test(path) || /[\u0000-\u001f\u007f]/u.test(path)) return undefined
  return new URL(`api/file?path=${encodeURIComponent(path)}`, base).href
}

/**
 * Whether one diff consists ONLY of Git's binary marker.
 *
 * A text diff always carries at least one `@@` hunk header; the binary form
 * carries the marker and no hunk at all. The pane uses this to say "binary
 * file, no text diff" instead of printing the marker as if it were a diff line.
 *
 * @param text - one `git diff` output.
 * @returns true when the text is a binary marker with no hunks.
 */
export function isBinaryDiffOnly(text: string): boolean {
  if (!/^Binary files .+ and .+ differ$/mu.test(text)) return false
  return !/^@@ /mu.test(text)
}
