/**
 * Plugin identity rules: the same npm package name is not the same plugin.
 * Two installs of one name are the same plugin only when their normalized
 * repository keys match — a fork, a mirror, or an unrelated project can
 * publish under an existing name, so the name alone never proves origin.
 *
 * The key (`host/owner/repo`, lowercase) is derived from any repo/page URL a
 * manifest `repository`, a dependency spec, or a catalog `homepage` carries.
 * The module is pure (no node imports) so the browser panel and the node-side
 * routes share one normalization: two ends of a comparison must never be
 * computed by different rules.
 *
 * Conservative stance: input that yields no provable repo answers null, and
 * null never matches anything (see sameOrigin) — an unprovable side reads as
 * a different origin and lands on the explicit-confirmation paths instead of
 * silently passing as the same plugin.
 *
 * @module @dsh-app/plugin-market/identity
 */

/** Hosts a repo key may come from — the identity rule's scope. */
const REPO_HOSTS = new Set(['github.com', 'gitlab.com', 'gitee.com'])

/** scp-style git spec: `user@host:owner/repo.git`. */
const SCP_SPEC_PATTERN = /^([^/@]+)@([^/:?#]+):(.+)$/

/** npm host shorthand: `github:owner/repo` (seen in specs and repository.url). */
const HOST_SHORTHAND_PATTERN = /^(github|gitlab|gitee):\/?(.+)$/i

/**
 * `#path:` fragment of a git spec (a monorepo subdirectory target), plus the
 * bare `#path` marker a derived key carries — the round-trip keeps the gate
 * and the card reading one stored key identically.
 */
const PATH_FRAGMENT_PATTERN = /^#path(?::|$)/i

/** URL-shaped input without a scheme (bare `host/owner/repo`, a stored key). */
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i

/**
 * npm identity of a package name: trimmed + lowercased. Name comparisons
 * (the panel's installed map, catalog lookups) go through this so a source's
 * casing can never hide a same-name collision.
 */
export function normalizeNpmName(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * Normalize any repo/page URL to the lowercase `host/owner/repo` key.
 * Accepted shapes: github/gitlab/gitee over https/ssh (including the
 * `git+` transport marker, scp-style specs, and the `github:` shorthand),
 * an optional `.git` suffix, a `#path:<subdir>` monorepo fragment (kept in
 * full: two packages from one repo but different subdirectories are
 * different plugins), and GitHub `/tree/<branch>/…` page URLs (page chrome after
 * `owner/repo` normalizes away). An npm name has no repo identity and
 * answers null, as does any input without a parseable repo URL on one of
 * the known hosts.
 */
export function repoKeyOf(url: string | undefined | null): string | null {
  if (typeof url !== 'string') return null
  let value = url.trim()
  if (value === '') return null
  if (/^git\+/i.test(value)) value = value.slice(4)
  const scp = SCP_SPEC_PATTERN.exec(value)
  if (scp !== null) value = `ssh://${scp[1]}@${scp[2]}/${scp[3]}`
  const shorthand = HOST_SHORTHAND_PATTERN.exec(value)
  if (shorthand !== null) value = `https://${shorthand[1]!.toLowerCase()}.com/${shorthand[2]}`
  // A bare `host/owner/repo` (a stored key, a hand-written manifest value)
  // parses only with a scheme; npm names fail the host check below either way.
  if (!SCHEME_PATTERN.test(value)) value = `https://${value}`
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  if (!REPO_HOSTS.has(host)) return null
  // Full subdirectory is part of the identity (case-normalized — the key is
  // only ever compared to keys built by the same function).
  const subPath = /^#path:(.+)$/i.exec(parsed.hash)?.[1]?.toLowerCase().replace(/\/+$/, '') ?? null
  // `owner` and `repo` are the first two segments; everything after them
  // (a /tree/ page path, an issues path) is page chrome.
  const segments = parsed.pathname.split('/').filter((segment) => segment !== '')
  if (segments.length < 2) return null
  const repo = segments[1]!.replace(/\.git$/i, '')
  if (repo === '') return null
  const key = `${host}/${segments[0]!.toLowerCase()}/${repo.toLowerCase()}`
  return subPath ? `${key}#path:${subPath}` : key
}

/**
 * Same-origin verdict of two repo keys: equal only when both sides are KNOWN
 * and identical. null (an unprovable side) never matches — including
 * null vs null — so every consumer errs toward "different plugin, ask
 * before replacing" instead of assuming a shared identity.
 */
export function sameOrigin(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a === b
}
