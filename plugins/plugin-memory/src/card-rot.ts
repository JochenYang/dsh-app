/**
 * How fast a card will ROT: the count of concrete external state its body names.
 *
 * A memory card is a snapshot of the moment it was written, and four kinds of
 * statement decay without anyone editing them — a version number, an absolute
 * or repo-relative path, a commit sha, a line number. They are not wrong when
 * written; they become wrong silently, and nothing re-checks them.
 *
 * This module only COUNTS them. It is a pure function over a string: no I/O, no
 * clock, no store — so `/status`, the curator's input and the health audit can
 * all ask the same question and get the same number.
 *
 * Not a gate this round (the plan's Q2/`ROT_DAYS` decision): the counts are
 * measured and served, and the injection text is untouched.
 *
 * @module @dsh-app/plugin-memory/card-rot
 */

/** The four kinds of decay-prone statement. */
export type RotKind = 'version' | 'path' | 'sha' | 'line'

/** One match: what kind, and the text that matched (for a readable report). */
export interface RotMarker {
  kind: RotKind
  text: string
}

/**
 * Three-part version, optionally `v`-prefixed (`v0.18.7`, `3.19.0`).
 *
 * Three components, not two: `1.5` is a ratio or a duration far more often
 * than a release, and a plain number (`1048576`) never has a dot at all — both
 * are excluded by the shape, which is what keeps the count meaningful.
 *
 * The two guards keep an IPv4 address (`127.0.0.1`) out, and BOTH are needed:
 * `(?!\.\d)` refuses the first three groups of an address, while the
 * lookbehind refuses to start a match in the middle of one — `\b` alone happily
 * begins at `0.0.1` (`.` is a non-word character, so there IS a boundary after
 * it) and reports a loopback address as a release number.
 */
const VERSION = /(?<![\d.])v?\d+\.\d+\.\d+(?!\.\d)/gu

/**
 * A path that will move. Two shapes qualify:
 *   - a Windows drive path (`C:\Users\…`), and
 *   - a `/`-separated run whose DIRECTORY segments carry no dot, ending in a
 *     file with an extension (`src/main/updater.ts`, `.github/workflows/ci.yml`).
 *
 * A bare `a/b` or a `/api/x` route is not a path with a file at the end and
 * stays out: routes and directory pairs are stable names, not filesystem
 * positions. The dot-free directory requirement is what keeps a LIST of two
 * file names (`config.toml/config.yaml`, a real card's phrasing) out of the
 * count — it reads like a path to a regex and like a pair to a person.
 */
const PATHS: readonly RegExp[] = [
  /\b[A-Za-z]:\\(?:[\w.@$()-]+\\?)+/gu,
  /(?:^|[\s(（"'`])(?:\.{0,2}\/)?(?:\.?[\w@-]+\/)+[\w.@-]+\.[A-Za-z0-9]{1,6}\b/gu,
]

/**
 * A commit id: 7–40 hex characters that mix letters AND digits.
 *
 * `stripCommitIds` in the store refuses the same shape on WRITE (a cited id is
 * a work-log fragment); this counts the ones already on disk. Both requirements
 * matter: pure digits (`1048576`) are counts and pure letters (`deadbeef`) are
 * words, so a hash has to have one of each to be recognisable as a hash.
 */
const SHA = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/giu

/**
 * A line reference, spelled as one: the Chinese `<index> <n> <unit>` form, or
 * `line 42` / `lines 42`.
 *
 * Two shapes are deliberately NOT counted:
 *   - a bare number (`1048576`, `3000`) — a count, a size or a port;
 *   - `file.ext:42`. It reads like the ideal marker, but by shape alone it is
 *     indistinguishable from `host:port` (`api.github.com:443`,
 *     `registry.npmjs.org:8080`, a URL in a card about proxies), and a marker
 *     that fires on network addresses makes the number say "these cards rot"
 *     about cards that do not. The FILE in `src/main/x.ts:42` is already
 *     counted by the path pattern, so the loss is smaller than the noise.
 *
 * `i` so `LINE 42` counts too; `[Ll]` alone would have missed it.
 *
 * The Chinese alternative is written with `\u` escapes: user-visible Chinese
 * lives in a plugin's own locale dictionary and `npm run check:graph` refuses
 * Han characters in host source.
 */
const LINES: readonly RegExp[] = [
  /\u7b2c\s*\d{1,5}\s*\u884c/gu,
  /\blines?\s*[:#]?\s*\d{1,5}\b/giu,
]

/** Every marker in one body, in the order the kinds are listed above. */
export function rotMarkers(body: string): RotMarker[] {
  const out: RotMarker[] = []
  for (const match of body.matchAll(VERSION)) out.push({ kind: 'version', text: match[0] })
  for (const pattern of PATHS) {
    for (const match of body.matchAll(pattern)) out.push({ kind: 'path', text: match[0].trim() })
  }
  for (const match of body.matchAll(SHA)) out.push({ kind: 'sha', text: match[0] })
  for (const pattern of LINES) {
    for (const match of body.matchAll(pattern)) out.push({ kind: 'line', text: match[0] })
  }
  return out
}

/** How many markers a body carries (the number the curator's `refs` reports). */
export function rotMarkerCount(body: string): number {
  return rotMarkers(body).length
}

/** Whether a body names any rot-prone state at all (the per-card flag). */
export function hasRot(body: string): boolean {
  return rotMarkerCount(body) > 0
}

/**
 * Per-kind totals over many bodies — the shape a health row serves, so the
 * number can say WHICH kind dominates instead of only how many.
 */
export function rotTotals(bodies: readonly string[]): {
  cards: number
  markers: number
  byKind: Record<RotKind, number>
} {
  const byKind: Record<RotKind, number> = { version: 0, path: 0, sha: 0, line: 0 }
  let cards = 0
  let markers = 0
  for (const body of bodies) {
    const found = rotMarkers(body)
    if (found.length === 0) continue
    cards += 1
    markers += found.length
    for (const marker of found) byKind[marker.kind] += 1
  }
  return { cards, markers, byKind }
}
