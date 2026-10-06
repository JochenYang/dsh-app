/**
 * The SkillHub skills catalog: search, detail-free card mapping, zip
 * download, and the on-disk install/uninstall against the kernel's own
 * skill roots (`$DSH_HOME/skills`, which the kernel's skill-filesystem
 * provider scans by default).
 *
 * Security stance mirrors the plugin catalog: the remote API is DATA ONLY.
 * Every response field is validated before use; zip entries are
 * path-checked individually (`safeRelPath`) and extracted through a staging
 * directory with an atomic rename, so a hostile archive can never write
 * outside the target skill directory. The download endpoint is pinned to
 * the https api host — the slug rides as a query parameter, never as a path.
 *
 * @module @dsh-app/plugin-market/skills
 */

import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { parse } from 'yaml'
import { MarketExecutionError, type HostText } from './errors.ts'

/** The SkillHub public API base (https, China-reachable; measured ~0.3 s/list page). */
export const SKILLHUB_API_BASE = 'https://api.skillhub.cn'

/** Per-request timeout. List pages are small (~25 KB); installs are zips. */
export const SKILLHUB_TIMEOUT_MS = 20_000

/** One page of the list API, after envelope unwrapping. */
export interface SkillPage {
  readonly items: readonly SkillCard[]
  readonly total: number
  readonly page: number
  readonly pageSize: number
}

/** One skill card, validated field by field from the API's raw shape. */
export interface SkillCard {
  /** Stable slug (`[a-z0-9][a-z0-9_-]*`), the install/uninstall key. */
  readonly slug: string
  /** Display title. */
  readonly name: string
  /** One-line description (zh preferred, en fallback). */
  readonly description: string
  /** Category display label (the raw key when unknown). */
  readonly category: string
  readonly version: string
  readonly downloads: number
  readonly stars: number
  /** The author handle the API reports (display only). */
  readonly owner?: string
  /**
   * The author-qualified identity (`@handle/slug`). A slug alone is NOT unique
   * per page: two authors publish the same one (measured — `dev-expert` twice,
   * `anti-fraud` three times on the browse page), and a page-keyed list that
   * keys on the slug then renders stale rows. Absent only when the source
   * declares no namespace.
   */
  readonly canonical?: string
  /** The upstream github repo, when the source declares one. */
  readonly homepage?: string
  /** The source's icon (a https CDN URL; display only, loaded lazily). */
  readonly iconUrl?: string
}

/** One installed skill, as the on-disk listing reports it. */
export interface InstalledSkill {
  readonly slug: string
  readonly name: string
  readonly description: string
  readonly files: number
  readonly bytes: number
}

/** One skill's detail, as the source's own detail endpoint reports it. */
export interface SkillDetail {
  readonly slug: string
  readonly name: string
  readonly description: string
  readonly category: string
  readonly version: string
  readonly downloads: number
  readonly stars: number
  readonly versions: number
  /** Install count as the source's own stats report it (0 when untracked). */
  readonly installs: number
  readonly owner?: string
  readonly iconUrl?: string
  /** Sub-category labels, in source order. */
  readonly subCategories: readonly string[]
  /** The author's own page for this skill. */
  readonly sourceUrl?: string
  /** Unix ms of the last update, when the source declares it. */
  readonly updatedAt?: number
}

/**
 * Narrow an untrusted slug: lowercase, npm-word characters only, no path
 * parts. The slug becomes a DIRECTORY NAME and a query parameter — the two
 * places a hostile value could escape.
 */
export function parseSkillSlug(raw: unknown): string {
  const s = String(raw ?? '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(s)) {
    throw new MarketExecutionError(
      { code: 'skill.badSlug', params: { slug: String(raw ?? '').slice(0, 40) }, text: `invalid skill slug: "${String(raw ?? '').slice(0, 40)}"` },
      'skill',
    )
  }
  return s
}

/** A safe string field: trimmed, capped, undefined when not a string. */
function field(value: unknown, cap = 400): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed.slice(0, cap)
}

/** A safe non-negative integer counter. */
function countOf(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return Math.floor(value)
}

/** Map one raw API skill object onto a validated card; null when unusable. */
export function skillCardOf(raw: unknown): SkillCard | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const slug = field(record.slug, 128)
  if (slug === undefined) return null
  try {
    parseSkillSlug(slug)
  } catch {
    return null
  }
  const name = field(record.name, 120) ?? slug
  // zh description preferred; the raw shape carries both.
  const description = field(record.description_zh, 1200) ?? field(record.description, 1200) ?? ''
  const rawCategory = field(record.category, 60) ?? ''
  const category = rawCategory
  const namespace = typeof record.namespace === 'object' && record.namespace !== null
    ? record.namespace as Record<string, unknown>
    : undefined
  const canonical = field(namespace?.canonicalName, 200)
  return {
    slug,
    name,
    description,
    category,
    version: field(record.version, 40) ?? '',
    downloads: countOf(record.downloads) ?? 0,
    stars: countOf(record.stars) ?? 0,
    ...(field(record.ownerName, 80) !== undefined ? { owner: field(record.ownerName, 80) } : {}),
    ...(canonical !== undefined ? { canonical } : {}),
    ...(field(record.iconUrl, 500) !== undefined && /^https:\/\//.test(field(record.iconUrl, 500)!) ? { iconUrl: field(record.iconUrl, 500) } : {}),
    ...(field(record.homepage, 300) !== undefined && /^https:\/\//.test(field(record.homepage, 300)!) ? { homepage: field(record.homepage, 300) } : {}),
  }
}

/** Unwrap the API envelope (`{ code, data }`); a non-zero code is an error. */
function envelopeData(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) {
    throw new MarketExecutionError({ code: 'skill.envelope', text: 'the skills API answered a non-object body' }, 'skill')
  }
  const record = body as { code?: unknown, data?: unknown, message?: unknown }
  if (record.code !== 0) {
    const message = typeof record.message === 'string' ? record.message : 'unknown error'
    throw new MarketExecutionError({ code: 'skill.apiError', params: { message }, text: `the skills API answered code ${String(record.code)}: ${message}` }, 'skill')
  }
  return record.data
}

/** One bounded JSON fetch against the skills API. */
async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(SKILLHUB_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    throw new MarketExecutionError(
      { code: 'skill.httpStatus', params: { status: response.status }, text: `HTTP ${String(response.status)}` },
      'skill',
    )
  }
  return response.json()
}

/**
 * One page of the skills catalog. Server-side search and sort (the API owns
 * keyword matching, category filtering, and ordering), paged at 24 — the
 * request is ~25 KB and answers in ~0.3 s.
 * @param query - free keyword; empty = browse by popularity.
 * @param category - a raw category key ('' = all).
 * @param page - 1-based page number.
 */
export async function searchSkills(query: string, category: string, page: number): Promise<SkillPage> {
  const params = new URLSearchParams()
  const keyword = query.trim()
  if (keyword !== '') params.set('keyword', keyword)
  if (category !== '') params.set('category', category)
  // `score` is the relevance value the source accepts today. It used to be
  // `relevance`, which the endpoint now REJECTS with HTTP 400 (`参数错误：sortBy
  // 不支持 (updated_at/downloads/stars/installs/score)`), and the failure is
  // total: a keyword search answered an error envelope, so the panel's skills
  // tab showed nothing for every query. Measured 2026-10-06 against the live
  // endpoint: `score` + keyword answers 200 with the relevance ranking
  // ("ppt" → PPT, ppt-generator-skill, pptx), while `downloads` stays the
  // browse (no keyword) sort.
  params.set('sortBy', keyword === '' ? 'downloads' : 'score')
  params.set('order', 'desc')
  params.set('page', String(Math.max(1, Math.floor(page))))
  params.set('pageSize', '24')
  const body = envelopeData(await fetchJson(`${SKILLHUB_API_BASE}/api/skills?${params.toString()}`))
  const record = (typeof body === 'object' && body !== null ? body : {}) as { skills?: unknown, total?: unknown }
  const rawItems = Array.isArray(record.skills) ? record.skills : []
  // The source's own category filter is exact (measured: a `category=dev-programming`
  // page answers 24 rows, all of them `dev-programming`), so the page is taken
  // as it arrives rather than filtered again here.
  const items = rawItems.map(skillCardOf).filter((card): card is SkillCard => card !== null)
  return {
    items,
    total: typeof record.total === 'number' && Number.isFinite(record.total) ? Math.floor(record.total) : items.length,
    page: Math.max(1, Math.floor(page)),
    pageSize: 24,
  }
}

/**
 * One skill's detail, from the source's own detail endpoint. Every field is
 * re-validated here (the remote body is DATA ONLY, like the list endpoint):
 * counters are non-negative integers, the icon and the two link fields must
 * be https, and the sub-category labels are capped strings.
 *
 * The endpoint is addressed by the BARE slug (`/api/v1/skills/<slug>`); an
 * author-qualified form is refused with 405 (measured), and the source
 * resolves a repeated slug to its own first-published row — so the card's
 * owner handle may differ from the detail's for a duplicated slug. The list
 * card remains the authority on which row the user clicked.
 *
 * @param slug - a validated slug.
 * @returns the validated detail.
 */
export async function skillDetail(slug: string): Promise<SkillDetail> {
  const id = parseSkillSlug(slug)
  // NOTE the envelope differs from the list endpoint: `/api/skills` answers
  // `{ code, data }` (see {@link envelopeData}), while `/api/v1/skills/<slug>`
  // answers the detail object DIRECTLY with no code wrapper (both measured).
  // Running the detail body through the list unwrapper reads `code` as
  // undefined and fails every call with "answered code undefined".
  const body = await fetchJson(`${SKILLHUB_API_BASE}/api/v1/skills/${encodeURIComponent(id)}`)
  const top = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const skill = (typeof top.skill === 'object' && top.skill !== null ? top.skill : {}) as Record<string, unknown>
  const stats = (typeof skill.stats === 'object' && skill.stats !== null ? skill.stats : {}) as Record<string, unknown>
  const namespace = (typeof top.namespace === 'object' && top.namespace !== null ? top.namespace : {}) as Record<string, unknown>
  const subCategories = Array.isArray(skill.subCategories)
    ? skill.subCategories
      .map(entry => (typeof entry === 'object' && entry !== null ? field((entry as Record<string, unknown>).name, 60) : undefined))
      .filter((label): label is string => label !== undefined)
    : []
  const updatedAt = typeof skill.updatedAt === 'number' && Number.isFinite(skill.updatedAt) ? Math.floor(skill.updatedAt) : undefined
  return {
    slug: field(top.slug, 128) ?? id,
    name: field(skill.displayName, 120) ?? field(slug, 120) ?? id,
    description: field(skill.summary_zh, 2000) ?? field(skill.summary, 2000) ?? '',
    category: field(skill.category, 60) ?? '',
    version: field((typeof top.latestVersion === 'object' && top.latestVersion !== null ? (top.latestVersion as Record<string, unknown>).version : undefined), 40) ?? '',
    downloads: countOf(stats.downloads) ?? 0,
    stars: countOf(stats.stars) ?? 0,
    versions: countOf(stats.versions) ?? 0,
    installs: countOf(stats.installs) ?? 0,
    ...(field(namespace.displayName, 80) !== undefined ? { owner: field(namespace.displayName, 80) } : {}),
    ...(field(skill.iconUrl, 500) !== undefined && /^https:\/\//.test(field(skill.iconUrl, 500)!) ? { iconUrl: field(skill.iconUrl, 500) } : {}),
    ...(field(skill.sourceUrl, 300) !== undefined && /^https:\/\//.test(field(skill.sourceUrl, 300)!) ? { sourceUrl: field(skill.sourceUrl, 300) } : {}),
    subCategories,
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  }
}

/**
 * Download a skill's zip and return the extracted FILES map (relative path →
 * bytes), every path re-checked by {@link safeRelPath} after extraction.
 * @param slug - a validated slug.
 */
export async function downloadSkillFiles(slug: string): Promise<Map<string, Buffer>> {
  const url = `${SKILLHUB_API_BASE}/api/v1/download?slug=${encodeURIComponent(slug)}&source=dsh`
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) {
    throw new MarketExecutionError(
      { code: 'skill.httpStatus', params: { status: response.status }, text: `HTTP ${String(response.status)}` },
      'skill',
    )
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new MarketExecutionError({ code: 'skill.notZip', text: 'the download is not a zip archive' }, 'skill')
  }
  const { unzipToFiles } = await import('./unzip.ts')
  const files = new Map<string, Buffer>()
  const extracted = unzipToFiles(bytes)
  for (const path of Object.keys(extracted)) {
    files.set(safeRelPath(path), extracted[path])
  }
  return files
}

/**
 * A zip-internal path safe to extract: no absolute forms, no `..`, no empty
 * parts, backslashes normalized. Throws (never sanitizes silently) — a
 * hostile archive entry is a refusal, not a rename.
 * @param raw - the path as the archive names it.
 * @returns the normalized relative path.
 */
export function safeRelPath(raw: string): string {
  const path = String(raw ?? '').replace(/\\/g, '/')
  if (path === '' || path.startsWith('/') || /(?:^|\/)\.\.(?:\/|$)/.test(path) || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new MarketExecutionError(
      { code: 'skill.unsafePath', params: { path: path.slice(0, 80) }, text: `unsafe archive path: "${path.slice(0, 80)}"` },
      'skill',
    )
  }
  return path
}

/** The on-disk directory of one installed skill, refused outside the root. */
export function skillDir(skillsDir: string, slug: string): string {
  const root = resolve(skillsDir)
  const target = resolve(root, parseSkillSlug(slug))
  const rel = relative(root, target)
  if (rel === '' || rel.startsWith('..') || rel.split(sep).includes('..')) {
    throw new MarketExecutionError({ code: 'skill.pathEscape', text: 'the skill target escapes the skills root' }, 'skill')
  }
  return target
}

/**
 * Parse a SKILL.md front matter's name/description for display. The `yaml`
 * package does the parsing — the kernel's own skill provider reads front
 * matter the same way, and a hand-rolled `key: value` regex reads a YAML block
 * scalar (`description: >-`, which real skills use) as the literal ">-".
 * Best-effort: a body without front matter falls back to the slug.
 */
export function skillMetaOf(skillMd: string | undefined, fallbackSlug: string): { name: string, description: string } {
  if (skillMd === undefined) return { name: fallbackSlug, description: '' }
  const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd)
  if (frontMatter === null) return { name: fallbackSlug, description: '' }
  let parsed: unknown
  try {
    parsed = parse(frontMatter[1])
  } catch {
    return { name: fallbackSlug, description: '' }
  }
  if (typeof parsed !== 'object' || parsed === null) return { name: fallbackSlug, description: '' }
  const record = parsed as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name.trim().slice(0, 200) : ''
  // A folded/literal description arrives with its newlines collapsed already.
  const description = typeof record.description === 'string' ? record.description.replace(/\s+/g, ' ').trim().slice(0, 400) : ''
  return { name: name === '' ? fallbackSlug : name, description }
}

/**
 * Install one skill into `<skillsDir>/<slug>/`: download → extract to a
 * staging directory (same volume, so the rename is atomic) → require
 * SKILL.md → replace any previous install. The kernel's skill provider
 * discovers the directory on its next scan; the panel surfaces a restart
 * hint after a successful install.
 * @param skillsDir - absolute path of the skills root (resolved from DSH_HOME).
 * @param slug - a validated slug.
 */
export async function installSkill(skillsDir: string, slug: string): Promise<void> {
  parseSkillSlug(slug)
  const files = await downloadSkillFiles(slug)
  if (!files.has('SKILL.md')) {
    throw new MarketExecutionError(
      { code: 'skill.noManifest', params: { slug }, text: `the archive carries no SKILL.md, so it is not a skill` },
      'skill',
    )
  }
  const target = skillDir(skillsDir, slug)
  await mkdir(skillsDir, { recursive: true })
  const staging = await mkdtemp(join(skillsDir, `.tmp-${slug}-`))
  try {
    for (const [rel, body] of files) {
      const dest = join(staging, rel)
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, body)
    }
    await rm(target, { recursive: true, force: true })
    await rename(staging, target)
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

/** Remove one installed skill's directory (best-effort scan skip is the kernel's job). */
export async function uninstallSkill(skillsDir: string, slug: string): Promise<void> {
  const target = skillDir(skillsDir, slug)
  await rm(target, { recursive: true, force: true })
}

/**
 * List the installed skills: one row per directory under the skills root
 * that carries a SKILL.md, with a bounded stat sweep (file count + bytes).
 * @param skillsDir - absolute path of the skills root.
 */
export async function listInstalledSkills(skillsDir: string): Promise<InstalledSkill[]> {
  const out: InstalledSkill[] = []
  let entries: string[]
  try {
    entries = await readdir(skillsDir)
  } catch {
    return out // no skills dir yet: an empty list, not an error
  }
  for (const slug of entries) {
    if (!/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(slug)) continue // not a skill dir (tmp, dotfiles)
    const dir = join(skillsDir, slug)
    let skillMd: string | undefined
    let files = 0
    let bytes = 0
    try {
      const dirStat = await stat(dir)
      if (!dirStat.isDirectory()) continue
      // Bounded walk (2 levels is what real skills use; deeper files count
      // toward the totals but are not descended for listing).
      const walk = async (dir: string, depth: number): Promise<void> => {
        const children = await readdir(dir)
        for (const child of children) {
          const childPath = join(dir, child)
          const childStat = await stat(childPath)
          if (childStat.isDirectory()) {
            if (depth < 2) await walk(childPath, depth + 1)
            continue
          }
          files += 1
          bytes += childStat.size
          if (child === 'SKILL.md' && depth === 0) {
            const { readFile } = await import('node:fs/promises')
            skillMd = (await readFile(childPath, 'utf8')).slice(0, 8000)
          }
        }
      }
      await walk(dir, 0)
    } catch {
      continue // unreadable dir: skip it, never fail the listing
    }
    const meta = skillMetaOf(skillMd, slug)
    out.push({ slug, name: meta.name, description: meta.description, files, bytes })
  }
  return out
}
