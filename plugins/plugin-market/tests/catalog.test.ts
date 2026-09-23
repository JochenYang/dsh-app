/**
 * Catalog tests: source URL validation, document parsing/validation, and the
 * merge/dedupe contract (first source wins per package, order stable, caps
 * hold).
 *
 * @module plugin-market/tests/catalog
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { MarketExecutionError } from '../src/errors.ts'
import {
  CATALOG_TIMEOUT_MS,
  DEFAULT_SECONDARY_SOURCE_URL,
  DEFAULT_SOURCE_URL,
  MAX_BYTES_PER_SOURCE,
  MAX_ENTRIES_PER_SOURCE,
  MAX_ENTRIES_TOTAL,
  MAX_SOURCES,
  fetchCatalog,
  mergeCatalogs,
  parseCatalog,
  validateSourceUrl,
  type CatalogEntry,
} from '../src/catalog.ts'

const entry = (pkg: string, name = pkg): CatalogEntry => ({ id: pkg, name, description: `${name} 描述`, package: pkg })

describe('validateSourceUrl', () => {
  it('accepts https URLs and normalizes them', () => {
    assert.equal(validateSourceUrl('https://example.com/plugins.json').ok, true)
    const normalized = validateSourceUrl('  https://example.com/list ')
    assert.equal(normalized.ok && normalized.url, 'https://example.com/list')
  })

  it('rejects non-https schemes, garbage, and credential URLs', () => {
    for (const raw of ['http://example.com/list', 'ftp://example.com', 'file:///etc/passwd', 'not a url', '', 42, 'https://user:pass@example.com/l', 'javascript:alert(1)']) {
      assert.equal(validateSourceUrl(raw).ok, false, `expected rejection: ${String(raw)}`)
    }
  })

  it('rejects oversized URLs', () => {
    assert.equal(validateSourceUrl(`https://example.com/${'a'.repeat(600)}`).ok, false)
  })

  it('answers a coded reason (the panel owns the sentence, not the host)', () => {
    const codeOf = (raw: unknown): string | undefined => {
      const check = validateSourceUrl(raw)
      return check.ok ? undefined : check.reason.code
    }
    assert.equal(codeOf(42), 'source.notString')
    assert.equal(codeOf(''), 'source.empty')
    assert.equal(codeOf(`https://example.com/${'a'.repeat(600)}`), 'source.tooLong')
    assert.equal(codeOf('not a url'), 'source.unparsable')
    assert.equal(codeOf('http://example.com/list'), 'source.notHttps')
    assert.equal(codeOf('https://user:pass@example.com/l'), 'source.hasCredentials')
    // The echoed value rides params, so no prose crosses the wire.
    const check = validateSourceUrl('not a url')
    assert.deepEqual(check.ok ? undefined : check.params, undefined)
    assert.equal(check.ok ? '' : check.reason.params?.url, 'not a url')
  })
})

describe('parseCatalog', () => {
  it('parses a valid document and keeps optional fields', () => {
    const entries = parseCatalog(JSON.stringify({
      name: '官方目录',
      plugins: [
        { id: 'a', name: '插件 A', description: '第一个', package: '@dsh-app/plugin-a', version: '1.0.0', homepage: 'https://a.example.com' },
        { id: 'b', name: '插件 B', description: '第二个', package: 'plugin-b' },
      ],
    }))
    assert.equal(entries.length, 2)
    assert.deepEqual(entries[0], {
      id: 'a',
      name: '插件 A',
      description: '第一个',
      package: '@dsh-app/plugin-a',
      version: '1.0.0',
      homepage: 'https://a.example.com',
    })
    assert.equal(entries[1]?.version, undefined)
    assert.equal(entries[1]?.homepage, undefined)
  })

  it('drops entries with unusable fields instead of failing the source', () => {
    const entries = parseCatalog(JSON.stringify({
      name: 'x',
      plugins: [
        { id: 'good', name: '好的', description: 'x', package: 'pkg-good' },
        { id: 'bad-pkg', name: '坏包名', description: 'x', package: 'not a package name' },
        { id: 'bad-home', name: '坏主页', description: 'x', package: 'pkg-ok', homepage: 'javascript:alert(1)' },
        { id: 'no-desc', name: '缺描述', package: 'pkg-ok-2' },
        { name: '缺包名', description: 'x' },
        null,
      ],
    }))
    // Only the fully valid entry survives; the source itself still succeeds.
    assert.deepEqual(entries.map(item => item.package), ['pkg-good'])
  })

  it('rejects non-JSON bodies and non-object documents', () => {
    assert.throws(() => parseCatalog('not json'), MarketExecutionError)
    assert.throws(() => parseCatalog('[1,2]'), MarketExecutionError)
    assert.throws(() => parseCatalog('null'), MarketExecutionError)
  })

  it('answers empty for an object without a plugins array', () => {
    assert.deepEqual(parseCatalog('{"name":"空目录"}'), [])
  })

  it('caps the per-source entry count', () => {
    const plugins = Array.from({ length: MAX_ENTRIES_PER_SOURCE + 50 }, (_, index) => ({
      id: `p${index}`, name: `p${index}`, description: 'x', package: `pkg-${index}`,
    }))
    const entries = parseCatalog(JSON.stringify({ name: 'big', plugins }))
    assert.equal(entries.length, MAX_ENTRIES_PER_SOURCE)
  })
})

describe('parseCatalog (aggregated directory format)', () => {
  /** One aggregated entry shaped like the real community directories. */
  const aggregatedEntry = (name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    name,
    owner: 'someone',
    url: `https://github.com/someone/${name}`,
    page: `https://dir.example.com/p/someone/${name}/`,
    category: 'tools',
    // Real rows carry 100–300 character two-language descriptions; the filler
    // keeps the synthetic document at real-directory scale (~800 bytes/row).
    description: {
      en: `${name} en: ${'a realistic feature sentence for volume. '.repeat(6)}`,
      zh: `${name} 的中文描述：${'一句贴近真实体量的功能介绍文本。'.repeat(10)}`,
    },
    npm: `pkg-${name.toLowerCase()}`,
    version: '1.0.0',
    stars: null,
    ...overrides,
  })

  it('maps the aggregated schema onto the internal entries', () => {
    const entries = parseCatalog(JSON.stringify({
      name: '目录', url: 'https://dir.example.com', count: 1,
      categories: { tools: { en: 'Tools & Capabilities', zh: '工具与能力' } },
      plugins: [aggregatedEntry('Alpha', { description: { en: 'Alpha en', zh: 'Alpha 的中文描述' } })],
    }))
    assert.equal(entries.length, 1)
    assert.deepEqual(entries[0], {
      id: 'https://dir.example.com/p/someone/Alpha/',
      name: 'Alpha',
      description: 'Alpha 的中文描述',
      package: 'pkg-alpha',
      installable: true,
      version: '1.0.0',
      owner: 'someone',
      homepage: 'https://github.com/someone/Alpha',
      category: '工具与能力',
      categoryId: 'tools',
    })
  })

  it('prefers zh labels and falls back through en to the raw category id', () => {
    const entries = parseCatalog(JSON.stringify({
      name: 'x',
      categories: {
        zhOnly: { en: 'ignored-en', zh: '中文标签' },
        enOnly: { en: 'Only EN' },
      },
      plugins: [
        aggregatedEntry('A', { category: 'zhOnly' }),
        aggregatedEntry('B', { category: 'enOnly' }),
        aggregatedEntry('C', { category: 'mystery' }),
      ],
    }))
    assert.deepEqual(entries.map(item => item.category), ['中文标签', 'Only EN', 'mystery'])
    // The id stays stable regardless of which fallback branch produced the
    // label — the panel filters on it, never on the label.
    assert.deepEqual(entries.map(item => item.categoryId), ['zhOnly', 'enOnly', 'mystery'])
  })

  it('resolves zh labels for aggregated rows that also carry an install command', () => {
    // The primary directory now ships a `dsh plugin … add` command on every
    // row; keying the store sniff on that command alone misrouted the whole
    // document into the store path, where the object category map matched
    // nothing and the panel rendered raw ids (`agi`, `ui`).
    const entries = parseCatalog(JSON.stringify({
      name: '目录',
      categories: { agi: { en: 'AGI Architecture Exploration', zh: 'AGI 架构探索' } },
      plugins: [aggregatedEntry('Alpha', {
        category: 'agi',
        install: 'dsh plugin --profile web add pkg-alpha',
      })],
    }))
    assert.equal(entries.length, 1)
    assert.equal(entries[0]?.category, 'AGI 架构探索')
    assert.equal(entries[0]?.categoryId, 'agi')
    assert.equal(entries[0]?.package, 'pkg-alpha')
  })

  it('keeps an explicit categoryId and its zh label through a snapshot-style replay', () => {
    // The bundled snapshot emits both fields plus the id→label map; replaying
    // it must not fold the display label back into the filter key.
    const entries = parseCatalog(JSON.stringify({
      name: 'snapshot',
      categories: { agi: { zh: 'AGI 架构探索' } },
      plugins: [{
        name: 'Alpha',
        description: { zh: '合成描述' },
        page: 'https://dir.example.com/p/Alpha/',
        category: 'AGI 架构探索',
        categoryId: 'agi',
        npm: 'pkg-alpha',
        installable: true,
      }],
    }))
    assert.equal(entries[0]?.category, 'AGI 架构探索')
    assert.equal(entries[0]?.categoryId, 'agi')
  })

  it('degrades npm-less and npm-invalid entries to source-only rows', () => {
    const entries = parseCatalog(JSON.stringify({
      name: 'x',
      categories: {},
      plugins: [
        aggregatedEntry('NoNpm', { npm: null }),
        aggregatedEntry('BadNpm', { npm: 'not a package name' }),
        aggregatedEntry('EmptyNpm', { npm: '' }),
      ],
    }))
    assert.equal(entries.length, 3)
    for (const entry of entries) {
      assert.equal(entry.installable, false)
      assert.equal(entry.package, `https://dir.example.com/p/someone/${entry.name}/`)
    }
  })

  it('falls the description back from zh to en, truncates long copy, and drops unusable entries', () => {
    const entries = parseCatalog(JSON.stringify({
      name: 'x',
      categories: {},
      plugins: [
        aggregatedEntry('EnOnly', { description: { en: 'only english' } }),
        aggregatedEntry('LongDesc', { description: { en: 'x'.repeat(600) } }),
        aggregatedEntry('NoDesc', { description: { en: '', zh: '' } }),
        aggregatedEntry('NoName', { name: '' }),
        null,
      ],
    }))
    assert.equal(entries.length, 2)
    assert.equal(entries[0]?.name, 'EnOnly')
    assert.equal(entries[0]?.description, 'only english')
    // Over-length copy truncates instead of dropping a browsable row.
    assert.equal(entries[1]?.name, 'LongDesc')
    assert.equal(entries[1]?.description?.length, 400)
    assert.equal(entries[1]?.description?.endsWith('…'), true)
  })

  it('keeps custom-schema documents on the legacy path', () => {
    const entries = parseCatalog(JSON.stringify({
      name: 'x',
      plugins: [{ id: 'a', name: '插件 A', description: 'x', package: 'pkg-a' }],
    }))
    assert.equal(entries.length, 1)
    assert.equal(entries[0]?.installable, undefined)
    assert.equal(entries[0]?.category, undefined)
    assert.equal(entries[0]?.package, 'pkg-a')
  })

  it(`absorbs a ~3.3 MB aggregated document within the ${MAX_BYTES_PER_SOURCE} byte cap`, () => {
    assert.equal(MAX_BYTES_PER_SOURCE >= 3_300_000, true)
    assert.equal(DEFAULT_SOURCE_URL.startsWith('https://'), true)
    // Real-directory scale: 3561 rows, each with a two-language description.
    const plugins = Array.from({ length: 3561 }, (_, index) => aggregatedEntry(`P${index}`, {
      npm: index % 2 === 0 ? `@scope/pkg-${index}` : null,
      category: `cat-${index % 23}`,
    }))
    const body = JSON.stringify({
      name: 'big', count: plugins.length,
      categories: Object.fromEntries(Array.from({ length: 23 }, (_, index) => [
        `cat-${index}`, { en: `Cat ${index}`, zh: `分类 ${index}` },
      ])),
      plugins,
    })
    // Wire size in UTF-8 bytes, the unit the per-source fetch cap speaks.
    assert.equal(Buffer.byteLength(body, 'utf8') >= 3_000_000, true)
    const entries = parseCatalog(body)
    assert.equal(entries.length, 3561)
    assert.equal(entries[0]?.category, '分类 0')
    assert.equal(entries[0]?.installable, true)
    assert.equal(entries[1]?.installable, false)
  })
})

describe('parseCatalog (store directory format)', () => {
  /** One store entry shaped like the real second-preset source (v2 API). */
  const storeEntry = (name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: `someone/${name}`,
    name,
    owner: 'someone',
    url: `https://github.com/someone/${name}`,
    repository: name,
    category: 'tools',
    description: {
      en: `${name} en: a realistic feature sentence for volume.`,
      zh: `${name} 的中文描述：一句贴近真实体量的功能介绍文本。`,
    },
    install: `dsh plugin --profile web add pkg-${name.toLowerCase()}`,
    installCount: 120,
    installs30d: 73,
    stars: 42,
    ...overrides,
  })

  const storeDocument = (plugins: readonly unknown[]): string => JSON.stringify({
    plugins,
    page: 1,
    limit: 100,
    total: plugins.length,
    totalPages: 1,
    catalogTotal: plugins.length,
    categories: [
      { id: 'tools', en: 'Tools & Capabilities', zh: '工具与能力', count: plugins.length },
      { id: 'ui', en: 'UI Enhancements', zh: 'UI 增强', count: 0 },
    ],
    generatedAt: '2026-09-12T00:00:00.000Z',
    source: 'ok',
  })

  it('maps the store schema: npm identity from the install command, homepage, category, installs30d, stars', () => {
    const entries = parseCatalog(storeDocument([storeEntry('Alpha')]))
    assert.equal(entries.length, 1)
    assert.deepEqual(entries[0], {
      id: 'someone/Alpha',
      name: 'Alpha',
      description: 'Alpha 的中文描述：一句贴近真实体量的功能介绍文本。',
      package: 'pkg-alpha',
      installable: true,
      installs30d: 73,
      owner: 'someone',
      stars: 42,
      homepage: 'https://github.com/someone/Alpha',
      category: '工具与能力',
      categoryId: 'tools',
    })
  })

  it('degrades git-specifier and malformed install commands to source-only rows keyed by the store id', () => {
    const entries = parseCatalog(storeDocument([
      storeEntry('GitOnly', { install: 'dsh plugin --profile web add github:someone/GitOnly#path:packages/x' }),
      storeEntry('NotDsh', { install: 'npm install pkg-not-dsh' }),
      storeEntry('BadTarget', { install: 'dsh plugin --profile web add "not a name"' }),
    ]))
    assert.equal(entries.length, 3)
    for (const entry of entries) assert.equal(entry.installable, false)
    assert.deepEqual(entries.map(item => item.package), ['someone/GitOnly', 'someone/NotDsh', 'someone/BadTarget'])
  })

  it('strips a version suffix from the target, scope-aware', () => {
    const entries = parseCatalog(storeDocument([
      storeEntry('Plain', { install: 'dsh plugin --profile web add pkg-plain@1.2.3' }),
      storeEntry('Scoped', { install: 'dsh plugin --profile web add @scope/pkg-scoped@1.2.3' }),
    ]))
    assert.deepEqual(entries.map(item => item.package), ['pkg-plain', '@scope/pkg-scoped'])
    for (const entry of entries) assert.equal(entry.installable, true)
  })

  it('keeps a description-less row with an empty description and drops nameless rows', () => {
    const entries = parseCatalog(storeDocument([
      storeEntry('NoDesc', { description: '' }),
      storeEntry('', {}),
      null,
    ]))
    assert.equal(entries.length, 1)
    assert.equal(entries[0]?.name, 'NoDesc')
    // The description stays empty so the panel can render its own
    // "（暂无描述）" placeholder — faking one from the name would duplicate
    // the title line in the description slot.
    assert.equal(entries[0]?.description, '')
  })

  it('prefers zh category labels and ignores malformed category rows', () => {
    const entries = parseCatalog(storeDocument([
      storeEntry('A', { category: 'tools' }),
      storeEntry('B', { category: 'unknown-cat' }),
      storeEntry('C', { category: 42 }),
    ]))
    assert.deepEqual(entries.map(item => item.category), ['工具与能力', 'unknown-cat', undefined])
    assert.deepEqual(entries.map(item => item.categoryId), ['tools', 'unknown-cat', undefined])
  })

  it('rejects non-integer or negative install counters instead of trusting them', () => {
    const entries = parseCatalog(storeDocument([
      storeEntry('Good', { installs30d: 5 }),
      storeEntry('Float', { installs30d: 1.5 }),
      storeEntry('Negative', { installs30d: -3 }),
      storeEntry('String', { installs30d: '12' }),
    ]))
    assert.deepEqual(entries.map(item => item.installs30d), [5, undefined, undefined, undefined])
  })

  it('does not misroute store documents into the aggregated path (category-only first entry)', () => {
    // A store entry carries `category` but no `npm`; the store sniff must win.
    const entries = parseCatalog(storeDocument([storeEntry('Alpha', { installCount: 1 })]))
    assert.equal(entries[0]?.installable, true)
    assert.equal(entries[0]?.package, 'pkg-alpha')
  })

  it('documents the timeout headroom and the pinned first page of the secondary preset', () => {
    // A 3.3 MB source took ~2.5 s on a healthy link; the 10 s cap aborted slow
    // fetches mid-transfer, so the doubled budget is a contract, not a taste.
    assert.equal(CATALOG_TIMEOUT_MS, 30_000)
    assert.equal(DEFAULT_SOURCE_URL.startsWith('https://'), true)
    const secondary = new URL(DEFAULT_SECONDARY_SOURCE_URL)
    assert.equal(secondary.hostname, 'deepseek1024.com')
    assert.equal(secondary.searchParams.get('page'), '1')
    assert.equal(secondary.searchParams.get('limit'), '100')
  })
})

describe('mergeCatalogs', () => {
  it('dedupes by package with first source winning, order preserved', () => {
    const merged = mergeCatalogs([
      [entry('pkg-a', 'A 来自源1'), entry('pkg-b', 'B 来自源1')],
      [entry('pkg-b', 'B 来自源2'), entry('pkg-c', 'C 来自源2')],
      [entry('pkg-a', 'A 来自源3')],
    ])
    assert.deepEqual(merged.map(item => item.name), ['A 来自源1', 'B 来自源1', 'C 来自源2'])
  })

  it('handles empty lists and returns empty for no sources', () => {
    assert.deepEqual(mergeCatalogs([]), [])
    assert.deepEqual(mergeCatalogs([[], []]), [])
  })

  it('caps the merged total', () => {
    const big: CatalogEntry[] = Array.from({ length: MAX_ENTRIES_TOTAL + 10 }, (_, index) => entry(`pkg-${index}`))
    const merged = mergeCatalogs([big])
    assert.equal(merged.length, MAX_ENTRIES_TOTAL)
  })
})

describe('fetchCatalog (offline behavior)', () => {
  it('rejects non-https URLs without any network activity', async () => {
    const result = await fetchCatalog('http://example.com/list')
    assert.equal('reason' in result, true)
    assert.equal(result.url, 'http://example.com/list')
  })

  it('degrades an unreachable host to a per-source failure', async () => {
    // .invalid is reserved and never resolves; the failure must come back as
    // a reason string, never a rejection.
    const result = await fetchCatalog('https://reserved-tld.invalid/catalog.json')
    assert.equal('reason' in result, true)
  })

  it('asks the source for an UNCOMPRESSED body', async () => {
    // The header is the whole defence against a proxy that answers with the
    // origin's compressed bytes but drops the `content-encoding` that says so:
    // measured here, such a response arrives as 1,036,056 bytes of gzip and
    // `JSON.parse` rejects it, and the user is told their catalog source is
    // broken. Nothing else in this suite can see the request's headers.
    const original = globalThis.fetch
    let seen: RequestInit | undefined
    globalThis.fetch = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
      seen = init
      return new Response('{"plugins":[]}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const result = await fetchCatalog('https://example.test/catalog.json')
      assert.equal('entries' in result, true)
      assert.deepEqual(seen?.headers, { 'accept-encoding': 'identity' })
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('source list limits', () => {
  it('documents the source cap shared with the routes', () => {
    assert.equal(MAX_SOURCES >= 1, true)
    assert.equal(MAX_ENTRIES_TOTAL >= MAX_ENTRIES_PER_SOURCE, true)
  })
})
