/**
 * Catalog tests: source URL validation, document parsing/validation, and the
 * merge/dedupe contract (first source wins per package, order stable, caps
 * hold).
 *
 * @module plugin-market/tests/catalog
 */

import { strict as assert } from 'node:assert'
import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import { gzipSync } from 'node:zlib'
import { MarketExecutionError } from '../src/errors.ts'
import {
  CATALOG_TIMEOUT_MS,
  DEFAULT_INDEX_SOURCE_URL,
  DEFAULT_SECONDARY_SOURCE_URL,
  DEFAULT_SOURCE_URL,
  MAX_BYTES_PER_SOURCE,
  MAX_ENTRIES_PER_SOURCE,
  MAX_ENTRIES_TOTAL,
  MAX_SOURCES,
  fetchCatalog,
  fetchCatalogFromNpmPackage,
  gitTargetOf,
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

  it('accepts the npm-package catalog scheme and refuses malformed forms', () => {
    assert.equal(validateSourceUrl('npm:dsh-plugin-catalog@https://mirrors.cloud.tencent.com/npm').ok, true)
    assert.equal(validateSourceUrl('npm:dsh-plugin-catalog').ok, true)
    // The registry must be https, and the shape must carry a package name.
    assert.equal(validateSourceUrl('npm:dsh-plugin-catalog@http://mirrors.example.com/npm').ok, false)
    assert.equal(validateSourceUrl('npm:').ok, false)
  })

  it('accepts the jsDelivr index that now leads the preset list', () => {
    // The preset list's first entry has to pass BOTH halves of the policy: the
    // literal-address rule here, and the DNS judgement at request time. This
    // asserts the shape; `fetchCatalog` covers the rest with a fake resolver.
    const check = validateSourceUrl(DEFAULT_INDEX_SOURCE_URL)
    assert.equal(check.ok, true)
    assert.equal(check.ok && check.url, 'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json')
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
    // The echoed value rides params, so no prose crosses the wire: the refusal
    // is exactly `{ ok: false, reason }`, with nothing hoisted to its top level.
    const check = validateSourceUrl('not a url')
    assert.equal(check.ok ? undefined : 'params' in check, false)
    assert.equal(check.ok ? '' : check.reason.params?.url, 'not a url')
  })

  it('refuses a source that names a private, loopback or metadata host', () => {
    const codeOf = (raw: unknown): string | undefined => {
      const check = validateSourceUrl(raw)
      return check.ok ? undefined : check.reason.code
    }
    for (const raw of [
      'https://127.0.0.1/x',
      'https://10.0.0.1/x',
      'https://172.16.0.1/x',
      'https://192.168.1.1/x',
      'https://169.254.169.254/x',
      'https://0.0.0.0/x',
      'https://[::1]/x',
      'https://[fc00::1]/x',
      'https://[fe80::1]/x',
    ]) {
      assert.equal(codeOf(raw), 'source.privateAddress', raw)
    }
    // The npm-package form names a registry host too, and the same policy
    // applies there: the default mirror is public and untouched.
    assert.equal(codeOf('npm:dsh-plugin-catalog@https://10.0.0.5/npm'), 'source.privateAddress')
    // A bracketed IPv6 registry never reaches the address check: the npm
    // grammar admits only hostname characters, so it stops as a shape error
    // (the older, narrower refusal — unaffected by this policy).
    assert.equal(codeOf('npm:dsh-plugin-catalog@https://[::1]/npm'), 'source.npmShape')
    assert.equal(validateSourceUrl('npm:dsh-plugin-catalog@https://mirrors.cloud.tencent.com/npm').ok, true)
    // The reason names the host, and carries no sentence of its own.
    const check = validateSourceUrl('https://192.168.1.1/x')
    assert.equal(check.ok ? '' : check.reason.params?.host, '192.168.1.1')
    assert.match(check.ok ? '' : check.reason.text ?? '', /private, loopback or link-local/)
  })

  it('keeps the fake-IP block, public literals and the scheme rule', () => {
    // 198.18.0.0/15 is this machine's own network shape: refusing it would
    // refuse every source, the presets included (src/source-address.ts).
    assert.equal(validateSourceUrl('https://198.18.0.57/x').ok, true)
    assert.equal(validateSourceUrl('npm:dsh-plugin-catalog@https://198.18.0.57/npm').ok, true)
    // A public literal is a legal source.
    assert.equal(validateSourceUrl('https://93.184.216.34/x').ok, true)
    assert.equal(validateSourceUrl('https://[2606:4700:4700::1111]/x').ok, true)
    // The scheme rule is decided first: an http private host is reported as
    // "not https" (the tightening must not change the older diagnosis).
    const http = validateSourceUrl('http://127.0.0.1/x')
    assert.equal(http.ok ? '' : http.reason.code, 'source.notHttps')
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
        // npm: null WITH a git install command is the real directory's shape
        // for a git-only plugin — installable, not source-only.
        aggregatedEntry('NoNpm', { npm: null, install: 'dsh plugin --profile web add github:someone/NoNpm' }),
        aggregatedEntry('BadNpm', { npm: 'not a package name' }),
        aggregatedEntry('EmptyNpm', { npm: '' }),
      ],
    }))
    assert.equal(entries.length, 3)
    const [gitRow] = entries
    assert.deepEqual(gitRow, {
      ...gitRow,
      installable: true,
      package: 'https://dir.example.com/p/someone/NoNpm/',
      gitTarget: 'github:someone/NoNpm',
    })
    for (const entry of entries.slice(1)) {
      assert.equal(entry.installable, false)
      assert.equal(entry.package, `https://dir.example.com/p/someone/${entry.name}/`)
      assert.equal(entry.gitTarget, undefined)
    }
  })

  it('an npm-less row whose install command is NOT a git target stays source-only', () => {
    const entries = parseCatalog(JSON.stringify({
      name: 'x',
      categories: {},
      plugins: [aggregatedEntry('NoNpm', { npm: null })],
    }))
    assert.equal(entries.length, 1)
    assert.equal(entries[0]?.installable, false)
    assert.equal(entries[0]?.gitTarget, undefined)
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

describe('parseCatalog (format-1 index)', () => {
  /**
   * One row shaped like the real jsDelivr index (`dsh-plugin-catalog`): npm
   * `name`, `owner/repo` `title`, two-language description, a repository block,
   * a `metadata.category` and a `versions` array.
   */
  const indexEntry = (pkg: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: pkg,
    title: `someone/${pkg}`,
    description: { en: `${pkg} en`, zh: `${pkg} 的中文描述` },
    homepage: `https://dir.example.com/p/someone/${pkg}/`,
    repository: { url: `https://github.com/someone/${pkg}` },
    metadata: { category: 'tools', keywords: [], labels: [], sortKeys: {} },
    versions: [{ version: '1.0.0', publishTimestamp: 1_700_000_000, source: { type: 'npm' }, engines: {} }],
    ...overrides,
  })

  const indexDocument = (plugins: readonly unknown[]): string => JSON.stringify({
    format: 1,
    title: { en: 'Directory', zh: '目录' },
    description: { en: 'en', zh: 'zh' },
    metadata: { categories: { tools: { title: { en: 'Tools & Capabilities', zh: '工具与能力' } } }, labels: {}, sortKeys: {} },
    plugins,
  })

  it('maps the format-1 schema onto the internal entries', () => {
    const entries = parseCatalog(indexDocument([indexEntry('dsh-alpha')]))
    assert.equal(entries.length, 1)
    assert.deepEqual(entries[0], {
      // id is the directory page; homepage is the REPOSITORY, which is what
      // originOf derives a same-name identity from.
      id: 'https://dir.example.com/p/someone/dsh-alpha/',
      name: 'someone/dsh-alpha',
      description: 'dsh-alpha 的中文描述',
      package: 'dsh-alpha',
      version: '1.0.0',
      homepage: 'https://github.com/someone/dsh-alpha',
      category: '工具与能力',
      categoryId: 'tools',
    })
  })

  it('takes the newest version by publish timestamp, not array order', () => {
    const entries = parseCatalog(indexDocument([indexEntry('dsh-alpha', {
      versions: [
        { version: '2.0.0', publishTimestamp: 200 },
        { version: '0.9.0', publishTimestamp: 900 },
      ],
    })]))
    assert.equal(entries[0]?.version, '0.9.0')
  })

  it('drops a row that names no valid npm package (nothing else to install from)', () => {
    // Unlike the aggregated path, this shape carries no git target and no
    // install command: a kept row the panel cannot install and cannot explain
    // is worse than a missing row.
    const entries = parseCatalog(indexDocument([
      indexEntry('dsh-alpha'),
      indexEntry('not a package'),
      indexEntry('../sneaky'),
      indexEntry('dsh-beta', { name: 42 }),
    ]))
    assert.deepEqual(entries.map(entry => entry.package), ['dsh-alpha'])
  })

  it('falls back to the npm name for display and to en for description', () => {
    const entries = parseCatalog(indexDocument([indexEntry('dsh-alpha', {
      title: undefined,
      description: { en: 'english only' },
    })]))
    assert.equal(entries[0]?.name, 'dsh-alpha')
    assert.equal(entries[0]?.description, 'english only')
  })

  it('degrades a claimed format 1 whose entries do not match it, instead of misreading them', () => {
    // A future format under the same number: the declaration alone must not be
    // enough to route it here.
    const entries = parseCatalog(JSON.stringify({
      format: 1,
      plugins: [{ name: 'dsh-alpha', description: 'no versions array' }],
    }))
    assert.deepEqual(entries, [])
  })

  it(`absorbs the real document's scale (3730 rows, 2.83 MB) within the ${MAX_BYTES_PER_SOURCE} byte cap`, () => {
    // Measured 2026-10-28 from the published file: 2.83 MB of JSON / 610 KB on
    // the wire with gzip. The cap is a byte cap on the BODY, so this asserts
    // the source that now leads the preset list actually fits it.
    const REAL_BYTES = 2_965_041
    assert.ok(REAL_BYTES < MAX_BYTES_PER_SOURCE)
    const row = JSON.stringify(indexEntry('dsh-alpha'))
    assert.ok(REAL_BYTES / 3730 > row.length * 0.5, 'the synthetic row is within 2x of real rows')
    const entries = parseCatalog(indexDocument(Array.from({ length: 3730 }, (_, i) => indexEntry(`dsh-pkg-${i}`))))
    assert.equal(entries.length, 3730)
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
      // `#path:` stays source-only: monorepo subpaths are outside the accepted
      // git-target shape, and rewriting one would promise a target the
      // install chain cannot verify.
      storeEntry('GitOnly', { install: 'dsh plugin --profile web add github:someone/GitOnly#path:packages/x' }),
      storeEntry('NotDsh', { install: 'npm install pkg-not-dsh' }),
      storeEntry('BadTarget', { install: 'dsh plugin --profile web add "not a name"' }),
    ]))
    assert.equal(entries.length, 3)
    for (const entry of entries) assert.equal(entry.installable, false)
    assert.deepEqual(entries.map(item => item.package), ['someone/GitOnly', 'someone/NotDsh', 'someone/BadTarget'])
  })

  it('a plain github target makes a store row installable with gitTarget set', () => {
    const SHA = 'c3319d9d3e78a18191e1381461b69e84bc547575'
    const entries = parseCatalog(storeDocument([
      storeEntry('GitPlug', { install: `dsh plugin --profile web add github:someone/GitPlug#${SHA}` }),
    ]))
    assert.equal(entries.length, 1)
    assert.deepEqual(entries[0], {
      ...entries[0],
      id: 'someone/GitPlug',
      name: 'GitPlug',
      package: 'someone/GitPlug',
      installable: true,
      gitTarget: `github:someone/GitPlug#${SHA}`,
    })
    // The surrogate key stays the store id — the merge/dedupe key is NOT the
    // git target, so an npm row and a git row of the same plugin keep their
    // own rows instead of colliding on the slug.
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

describe('gitTargetOf (git install targets from install commands)', () => {
  const SHA = 'c3319d9d3e78a18191e1381461b69e84bc547575'
  const cmd = (target: string): string => `dsh plugin --profile web add ${target}`

  it('extracts the repo from the real directory command shape', () => {
    assert.deepEqual(gitTargetOf(cmd('github:lemonorangeapple/dsh-effort-switcher')), {
      repo: 'lemonorangeapple/dsh-effort-switcher',
    })
  })

  it('keeps an existing commit pin and folds it to lowercase', () => {
    assert.deepEqual(gitTargetOf(cmd(`github:O/R#${SHA.toUpperCase()}`)), { repo: 'O/R', commit: SHA })
  })

  it('refuses everything the install chain cannot honor verbatim', () => {
    // Mutable selectors would need re-pinning here to be honest — refused instead.
    for (const target of [`github:o/r#main`, `github:o/r#path:/pkg`, `github:o/r#not-a-sha`]) {
      assert.equal(gitTargetOf(cmd(target)), undefined, target)
    }
    // Hosts and spellings outside the accepted shape.
    for (const target of ['git+https://github.com/o/r', 'git@github.com:o/r', 'https://github.com/o/r', 'github:o', 'github:o/r/tree/main']) {
      assert.equal(gitTargetOf(cmd(target)), undefined, target)
    }
  })

  it('refuses malformed commands and non-strings', () => {
    for (const raw of ['github:o/r', 'npm install github:o/r', 'dsh plugin add', 'dsh plugin --profile web remove github:o/r', 42, null, undefined]) {
      assert.equal(gitTargetOf(raw), undefined, String(raw))
    }
    // A target token with trailing garbage never parses: the token is the
    // whole word, so shell metacharacters cannot smuggle a second command.
    assert.equal(gitTargetOf(cmd('github:o/r;rm -rf /')), undefined)
    assert.equal(gitTargetOf(cmd('github:o/r & echo pwned')), undefined)
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
  /**
   * A resolver seam that answers one fixed set. Every case below injects it:
   * the address check otherwise resolves the real host, which is neither
   * deterministic nor offline.
   */
  const answering = (...addresses: readonly string[]): { resolve: () => Promise<readonly string[]> } =>
    ({ resolve: async () => addresses })

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

  it('advertises gzip but survives a proxy that strips the encoding header', async () => {
    // The old defence was unconditional `identity` (5 MB on the primary
    // source). The defence is now the BODY, not the header: gzip is
    // advertised, and a proxy that answers with the origin's compressed
    // bytes but drops the `content-encoding` that says so is handled by the
    // magic-byte gunzip inside fetchCatalog — measured 2026-10-03, such a
    // response arrives as ~1 MB of gzip and `JSON.parse` rejects it, so the
    // decode must happen before the parse.
    const original = globalThis.fetch
    let seen: RequestInit | undefined
    globalThis.fetch = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
      seen = init
      return new Response('{"plugins":[]}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const result = await fetchCatalog('https://example.test/catalog.json', {}, answering('93.184.216.34'))
      assert.equal('entries' in result, true)
      const headers = seen?.headers as Record<string, string>
      assert.match(headers['accept-encoding'], /gzip/)
    } finally {
      globalThis.fetch = original
    }
  })

  it('returns notModified on a 304 and carries validators on the request', async () => {
    const original = globalThis.fetch
    const seen: { init?: RequestInit } = {}
    globalThis.fetch = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
      seen.init = init
      return new Response(null, { status: 304 })
    }) as typeof fetch
    try {
      const result = await fetchCatalog('https://example.test/catalog.json', { etag: 'W/"abc123"' }, answering('93.184.216.34'))
      assert.equal('notModified' in result && result.notModified, true)
      const headers = seen.init?.headers as Record<string, string>
      assert.equal(headers['if-none-match'], 'W/"abc123"')
    } finally {
      globalThis.fetch = original
    }
  })

  it('gunzips a body whose encoding the proxy stripped, instead of failing the parse', async () => {
    // The broken-proxy shape: the origin compresses, the proxy drops the
    // header, undici hands back raw gzip bytes. The magic-byte check must
    // decompress before the JSON parse.
    const original = globalThis.fetch
    const gz = gzipSync(Buffer.from('{"plugins":[{"id":"a","name":"A","description":"d","package":"@x/a"}]}', 'utf8'))
    globalThis.fetch = (async (): Promise<Response> => {
      // A body of raw bytes with NO content-encoding header at all.
      return new Response(gz, { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const result = await fetchCatalog('https://example.test/catalog.json', {}, answering('93.184.216.34'))
      assert.equal('entries' in result, true)
      if ('entries' in result) assert.equal(result.entries.length, 1)
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('fetchCatalog (source address policy)', () => {
  const answering = (...addresses: readonly string[]): { resolve: () => Promise<readonly string[]> } =>
    ({ resolve: async () => addresses })

  /** One stubbed transport that records whether it was reached. */
  function stubFetch(body = '{"plugins":[]}'): { reached: () => boolean, restore: () => void } {
    const original = globalThis.fetch
    let reached = false
    globalThis.fetch = (async (): Promise<Response> => {
      reached = true
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    return { reached: () => reached, restore: () => { globalThis.fetch = original } }
  }

  it('sends the source request without following redirects', async () => {
    // Pinned because nothing pinned it: deleting the option left the whole
    // suite green, while the behaviour it buys is real — `redirect: 'error'`
    // rejects on a 3xx, and the default follows the Location to wherever it
    // points, including an address this policy just refused.
    const original = globalThis.fetch
    let seen: RequestInit | undefined
    globalThis.fetch = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
      seen = init
      return new Response('{"plugins":[]}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const result = await fetchCatalog('https://example.test/catalog.json', {}, answering('93.184.216.34'))
      assert.equal('entries' in result, true)
      assert.equal(seen?.redirect, 'error')
    } finally {
      globalThis.fetch = original
    }
  })

  it('refuses a name whose answers are private, before the request is sent', async () => {
    const transport = stubFetch()
    try {
      const result = await fetchCatalog('https://internal.example.com/catalog.json', {}, answering('10.0.0.1'))
      assert.equal('reason' in result, true)
      assert.equal('reason' in result ? result.reason.code : '', 'source.privateResolution')
      assert.equal('reason' in result ? result.reason.params?.host : '', 'internal.example.com')
      assert.equal(transport.reached(), false)
    } finally {
      transport.restore()
    }
  })

  it('refuses an answer set with one private address, and one metadata answer', async () => {
    for (const answer of [['93.184.216.34', '10.0.0.1'], ['169.254.169.254'], ['::ffff:127.0.0.1'], ['fe80::1']]) {
      const transport = stubFetch()
      try {
        const result = await fetchCatalog('https://mixed.example.com/catalog.json', {}, answering(...answer))
        assert.equal('reason' in result, true, answer.join(','))
        assert.equal('reason' in result ? result.reason.code : '', 'source.privateResolution')
        assert.equal(transport.reached(), false, answer.join(','))
      } finally {
        transport.restore()
      }
    }
  })

  it('lets the fake-IP block through and carries the request on', async () => {
    // The machine's own network shape: a TUN resolver answers 198.18.0.0/15
    // for every name. A strict policy here refuses every source there.
    const transport = stubFetch()
    try {
      const result = await fetchCatalog('https://example.com/catalog.json', {}, answering('198.18.0.57'))
      assert.equal('entries' in result, true)
      assert.equal(transport.reached(), true)
    } finally {
      transport.restore()
    }
  })

  it('does not consult the resolver for a literal host, refused or public', async () => {
    let asked = 0
    const resolve = async (): Promise<readonly string[]> => { asked += 1; return [] }
    const refused = await fetchCatalog('https://127.0.0.1/catalog.json', {}, { resolve })
    assert.equal('reason' in refused && refused.reason.code, 'source.privateAddress')
    assert.equal(asked, 0)
    const transport = stubFetch()
    try {
      const allowed = await fetchCatalog('https://198.18.0.57/catalog.json', {}, { resolve })
      assert.equal('entries' in allowed, true)
    } finally {
      transport.restore()
    }
    assert.equal(asked, 0)
  })

  it('runs the request when the resolver fails — NXDOMAIN is not a private answer', async () => {
    const transport = stubFetch()
    try {
      const result = await fetchCatalog('https://example.com/catalog.json', {}, {
        resolve: async () => { throw new Error('getaddrinfo ENOTFOUND example.com') },
      })
      // The fetch itself reports the failure in its own words; the address
      // check must not claim a private answer it never saw.
      assert.equal('entries' in result, true)
      assert.equal(transport.reached(), true)
    } finally {
      transport.restore()
    }
  })

  it('holds an npm catalog source to the same policy on its registry host', async () => {
    // A literal registry host is caught at validation.
    const literal = await fetchCatalog('npm:dsh-plugin-catalog@https://10.0.0.5/npm')
    assert.equal('reason' in literal && literal.reason.code, 'source.privateAddress')
    // A named one is caught once its answers are known.
    const named = await fetchCatalogFromNpmPackage('dsh-plugin-catalog', 'https://internal.example.com/npm', undefined, answering('10.0.0.1'))
    assert.equal('reason' in named && named.reason.code, 'source.privateResolution')
  })
})


describe('source list limits', () => {
  it('documents the source cap shared with the routes', () => {
    assert.equal(MAX_SOURCES >= 1, true)
    assert.equal(MAX_ENTRIES_TOTAL >= MAX_ENTRIES_PER_SOURCE, true)
  })
})

describe('fetchCatalogFromNpmPackage', () => {
  /**
   * The resolver seam every case here injects: without it the registry and the
   * tarball host are resolved for real, which is neither offline nor
   * deterministic.
   */
  const answering = (...addresses: readonly string[]): { resolve: () => Promise<readonly string[]> } =>
    ({ resolve: async () => addresses })

  /** One registry answer, shaped like the mirror's own packument. */
  const packument = (version: string, tarball: string): Response =>
    new Response(JSON.stringify({ version, dist: { tarball } }), { status: 200, headers: { 'content-type': 'application/json' } })

  /**
   * A stubbed transport that records each request's URL AND redirect mode: for
   * this path the destination is the thing under test, so a helper that only
   * counts calls cannot express the assertions.
   */
  function recordingFetch(handler: (url: string) => Response): {
    readonly calls: Array<{ readonly url: string, readonly redirect: unknown }>
    readonly restore: () => void
  } {
    const original = globalThis.fetch
    const calls: Array<{ url: string, redirect: unknown }> = []
    globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      calls.push({ url, redirect: init?.redirect })
      return handler(url)
    }) as typeof fetch
    return { calls, restore: () => { globalThis.fetch = original } }
  }

  it('skips the tarball when the held version matches latest', async () => {
    const original = globalThis.fetch
    let tarballFetched = false
    globalThis.fetch = (async (input: unknown): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/latest')) {
        return new Response(JSON.stringify({ version: '1.2.3', dist: { tarball: 'https://mirror.example.com/pkg-1.2.3.tgz' } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      tarballFetched = true
      return new Response(Buffer.alloc(0), { status: 200 })
    }) as typeof fetch
    try {
      const result = await fetchCatalogFromNpmPackage('dsh-plugin-catalog', 'https://mirror.example.com/npm', '1.2.3', answering('93.184.216.34'))
      assert.equal('notModified' in result && result.notModified, true)
      assert.equal('notModified' in result && result.servedVersion, '1.2.3')
      assert.equal(tarballFetched, false)
    } finally {
      globalThis.fetch = original
    }
  })

  it('extracts plugins.json from the tarball and returns entries with the version', async () => {
    const catalog = JSON.stringify({ plugins: [{ name: 'p', owner: 'o', url: 'https://r', page: 'https://r/p', category: 'c', description: { en: 'd', zh: '说' }, npm: '@s/p', stars: 3, downloads: 9, version: '1.0.0' }] })
    const tarball = catalogTarball(catalog)
    const transport = recordingFetch(url => url.endsWith('/latest')
      ? packument('9.9.9', 'https://mirror.example.com/pkg-9.9.9.tgz')
      : new Response(new Uint8Array(tarball), { status: 200 }))
    try {
      const result = await fetchCatalogFromNpmPackage('dsh-plugin-catalog', 'https://mirror.example.com/npm', undefined, answering('93.184.216.34'))
      assert.equal('entries' in result, true)
      if ('entries' in result) {
        assert.equal(result.entries.length, 1)
        assert.equal(result.modified, '9.9.9')
      }
    } finally {
      transport.restore()
    }
  })

  it('judges each hop\'s destination, and sends neither of them following redirects', async () => {
    // The tarball hop is the registry's own data: before this policy existed it
    // was requested verbatim, whatever address it named, and a 302 from it was
    // followed (measured against two loopback servers: the request reached the
    // address in `Location`, `127.0.0.1` included).
    const transport = recordingFetch(url => url.endsWith('/latest')
      ? packument('1.0.0', 'https://cdn.example.com/pkg-1.0.0.tgz')
      : new Response(new Uint8Array(catalogTarball('{"plugins":[]}')), { status: 200 }))
    try {
      await fetchCatalogFromNpmPackage('dsh-plugin-catalog', 'https://mirror.example.com/npm', undefined, answering('93.184.216.34'))
      assert.deepEqual(transport.calls, [
        { url: 'https://mirror.example.com/npm/dsh-plugin-catalog/latest', redirect: 'manual' },
        { url: 'https://cdn.example.com/pkg-1.0.0.tgz', redirect: 'manual' },
      ])
    } finally {
      transport.restore()
    }
  })

  it('refuses a tarball URL naming a refused address, without requesting it', async () => {
    // Each of these is an address class the source policy refuses for an https
    // source — the metadata endpoint included, which is what an SSRF attempt
    // against a registry actually names.
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['http://127.0.0.1:9/pkg.tgz', '127.0.0.1'],
      ['http://[::1]/pkg.tgz', '[::1]'],
      ['https://169.254.169.254/latest/meta-data/', '169.254.169.254'],
      ['https://10.0.0.9/pkg.tgz', '10.0.0.9'],
    ]
    for (const [tarball, host] of cases) {
      const transport = recordingFetch(() => packument('1.0.0', tarball))
      try {
        const result = await fetchCatalogFromNpmPackage('dsh-plugin-catalog', 'https://mirror.example.com/npm', undefined, answering('93.184.216.34'))
        assert.equal('reason' in result && result.reason.code, 'source.privateAddress', tarball)
        assert.equal('reason' in result && result.reason.params?.host, host, tarball)
        // Only the metadata hop was sent: the tarball URL never reached fetch.
        assert.equal(transport.calls.length, 1, tarball)
      } finally {
        transport.restore()
      }
    }
  })

  it('refuses a tarball host that resolves to a refused address, without requesting it', async () => {
    const transport = recordingFetch(() => packument('1.0.0', 'https://cdn.internal.example.com/pkg.tgz'))
    const resolve = async (hostname: string): Promise<readonly string[]> =>
      hostname === 'cdn.internal.example.com' ? ['10.0.0.1'] : ['93.184.216.34']
    try {
      const result = await fetchCatalogFromNpmPackage('dsh-plugin-catalog', 'https://mirror.example.com/npm', undefined, { resolve })
      assert.equal('reason' in result && result.reason.code, 'source.privateResolution')
      assert.equal('reason' in result && result.reason.params?.host, 'cdn.internal.example.com')
      assert.equal(transport.calls.length, 1)
    } finally {
      transport.restore()
    }
  })

  it('fails closed on a hop it cannot judge, rather than sending it unjudged', async () => {
    // A URL this host cannot parse, a scheme that is not http(s) (undici would
    // fetch a `data:` URL happily), and an answer set the resolver could not
    // produce. All three are refusals: the tarball URL is the source's data,
    // so nothing here may fall through to an unjudged request.
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['not a url', 'source.unparsable'],
      ['data:application/gzip;base64,H4sIAAAAAAAA', 'source.notHttps'],
      ['file:///etc/hosts', 'source.notHttps'],
    ]
    for (const [tarball, code] of cases) {
      const transport = recordingFetch(() => packument('1.0.0', tarball))
      try {
        const result = await fetchCatalogFromNpmPackage('dsh-plugin-catalog', 'https://mirror.example.com/npm', undefined, answering('93.184.216.34'))
        assert.equal('reason' in result && result.reason.code, code, tarball)
        assert.equal(transport.calls.length, 1, tarball)
      } finally {
        transport.restore()
      }
    }
    // The resolver cannot answer for the tarball host: refused, and never as a
    // private address (that would be a claim the user cannot check).
    const unresolved = recordingFetch(() => packument('1.0.0', 'https://cdn.example.com/pkg.tgz'))
    try {
      const resolve = async (hostname: string): Promise<readonly string[]> => {
        if (hostname === 'cdn.example.com') throw new Error('getaddrinfo ENOTFOUND cdn.example.com')
        return ['93.184.216.34']
      }
      const result = await fetchCatalogFromNpmPackage('dsh-plugin-catalog', 'https://mirror.example.com/npm', undefined, { resolve })
      assert.equal('reason' in result && result.reason.code, 'source.unresolved')
      assert.equal('reason' in result && result.reason.params?.host, 'cdn.example.com')
      assert.equal(unresolved.calls.length, 1)
    } finally {
      unresolved.restore()
    }
    // The registry hop fails closed the same way, before any request is sent.
    const unreachable = recordingFetch(() => packument('1.0.0', 'https://cdn.example.com/pkg.tgz'))
    try {
      const result = await fetchCatalogFromNpmPackage('dsh-plugin-catalog', 'https://mirror.example.com/npm', undefined, {
        resolve: async () => { throw new Error('getaddrinfo ENOTFOUND') },
      })
      assert.equal('reason' in result && result.reason.code, 'source.unresolved')
      assert.equal(unreachable.calls.length, 0)
    } finally {
      unreachable.restore()
    }
  })

  it('refuses a registry base it cannot parse instead of skipping the check', async () => {
    // The older shape skipped the address check whenever the base would not
    // parse — a fail-open branch. A base this host cannot turn into a URL
    // cannot be requested either, so it is a refusal.
    const transport = recordingFetch(() => packument('1.0.0', 'https://cdn.example.com/pkg.tgz'))
    try {
      const result = await fetchCatalogFromNpmPackage('dsh-plugin-catalog', 'not a url', undefined, answering('93.184.216.34'))
      assert.equal('reason' in result && result.reason.code, 'source.unparsable')
      assert.equal(transport.calls.length, 0)
    } finally {
      transport.restore()
    }
  })

  it('takes a literal hop address as its own answer, without asking the resolver', async () => {
    // The policy's own rule for a literal ("a public literal is its own answer
    // set"), and the reason it matters here: a resolver that cannot answer must
    // not turn an address nobody needs looked up into a refusal.
    const transport = recordingFetch(url => url.endsWith('/latest')
      ? packument('1.0.0', 'https://93.184.216.34/pkg.tgz')
      : new Response(new Uint8Array(catalogTarball('{"plugins":[]}')), { status: 200 }))
    try {
      const result = await fetchCatalogFromNpmPackage('dsh-plugin-catalog', 'https://93.184.216.34/npm', undefined, {
        resolve: async () => { throw new Error('the resolver must not be asked about a literal') },
      })
      assert.equal('entries' in result, true)
      assert.equal(transport.calls.length, 2)
    } finally {
      transport.restore()
    }
  })

  /**
   * A 200 whose body arrives in 256 KB chunks, counting the chunks the reader
   * actually pulled. A body far larger than the cap plus this counter is what
   * makes "the read stopped at the cap" a number instead of an inference from
   * the refusal — a read that buffered first would pull every chunk.
   */
  function chunkedResponse(totalBytes: number, counter: { pulls: number }): Response {
    const chunk = new Uint8Array(256_000).fill(120)
    let sent = 0
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= totalBytes) {
          controller.close()
          return
        }
        sent += chunk.byteLength
        counter.pulls += 1
        controller.enqueue(chunk)
      },
    }), { status: 200 })
  }

  it('caps the registry metadata read, stopping where the cap is crossed', async () => {
    // A registry that passes the address policy can still answer an endless
    // body: 4 MB here against the 1 MB manifest cap, in 16 chunks.
    const counter = { pulls: 0 }
    const transport = recordingFetch(url => url.endsWith('/latest')
      ? chunkedResponse(4_000_000, counter)
      : new Response(new Uint8Array(catalogTarball('{"plugins":[]}')), { status: 200 }))
    try {
      const result = await fetchCatalogFromNpmPackage('dsh-plugin-catalog', 'https://mirror.example.com/npm', undefined, answering('93.184.216.34'))
      assert.equal('reason' in result && result.reason.code, 'catalog.npmMetaTooLarge')
      assert.equal('reason' in result && result.reason.params?.mb, 1)
      assert.equal(counter.pulls < 16, true, `pulled ${String(counter.pulls)} of 16 chunks`)
      assert.equal(transport.calls.length, 1, 'the tarball is never asked for')
    } finally {
      transport.restore()
    }
  })

  it('caps the tarball read, stopping where the cap is crossed', async () => {
    // The tarball cap is the document cap (8 MB) — 16 MB of body is 64 chunks.
    const counter = { pulls: 0 }
    const transport = recordingFetch(url => url.endsWith('/latest')
      ? packument('1.0.0', 'https://mirror.example.com/pkg-1.0.0.tgz')
      : chunkedResponse(16_000_000, counter))
    try {
      const result = await fetchCatalogFromNpmPackage('dsh-plugin-catalog', 'https://mirror.example.com/npm', undefined, answering('93.184.216.34'))
      assert.equal('reason' in result && result.reason.code, 'catalog.npmTarballTooLarge')
      assert.equal('reason' in result && result.reason.params?.mb, 8)
      assert.equal(counter.pulls < 64, true, `pulled ${String(counter.pulls)} of 64 chunks`)
    } finally {
      transport.restore()
    }
  })
})

describe('fetchCatalogFromNpmPackage (redirects, real HTTP)', () => {
  /**
   * These cases use REAL loopback servers, because the behaviour under test is
   * undici's own: a stubbed `fetch` never follows a `Location`, so only a real
   * 302 can show that one is refused. The URLs name `localhost` (a NAME, so the
   * injected resolver judges it) while the socket goes to `127.0.0.1` — the
   * same seam the reviewer's probe used.
   */
  const answering = (...addresses: readonly string[]): { resolve: () => Promise<readonly string[]> } =>
    ({ resolve: async () => addresses })

  /** A loopback server, listening on an ephemeral port. */
  function listen(handler: RequestListener): Promise<Server> {
    const server = createServer(handler)
    return new Promise(resolve => { server.listen(0, '127.0.0.1', () => resolve(server)) })
  }

  /** A `localhost` URL for one server (a name, so the resolver seam applies). */
  function urlOf(server: Server, path: string): string {
    return `http://localhost:${String((server.address() as AddressInfo).port)}${path}`
  }

  const close = (servers: readonly Server[]): void => { for (const server of servers) server.close() }

  it('follows ONE redirect to a destination the policy allows — the mirror CDN shape', async () => {
    // Measured 2026-10-13: registry.npmmirror.com answers a tarball request with
    // `302 … cdn.npmmirror.com`. Refusing every redirect would refuse a mirror
    // users actually add, so the Location is judged and the hop is followed.
    const cdnHits: string[] = []
    const cdn = await listen((req, res) => {
      cdnHits.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ version: '1.2.3', dist: { tarball: 'https://mirror.example.com/x.tgz' } }))
    })
    const front = await listen((_req, res) => {
      res.writeHead(302, { location: urlOf(cdn, '/moved/latest') })
      res.end()
    })
    try {
      const result = await fetchCatalogFromNpmPackage('dsh-plugin-catalog', urlOf(front, '/npm'), '1.2.3', answering('93.184.216.34'))
      assert.equal('notModified' in result && result.servedVersion, '1.2.3')
      assert.deepEqual(cdnHits, ['/moved/latest'])
    } finally {
      close([front, cdn])
    }
  })

  it('refuses a metadata redirect whose Location names a refused address', async () => {
    const targetHits: string[] = []
    const target = await listen((req, res) => { targetHits.push(req.url ?? ''); res.writeHead(200); res.end('{}') })
    const front = await listen((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${String((target.address() as AddressInfo).port)}/latest/meta-data/` })
      res.end()
    })
    try {
      const result = await fetchCatalogFromNpmPackage('dsh-plugin-catalog', urlOf(front, '/npm'), undefined, answering('93.184.216.34'))
      assert.equal('reason' in result && result.reason.code, 'source.privateAddress')
      assert.equal('reason' in result && result.reason.params?.host, '127.0.0.1')
      assert.deepEqual(targetHits, [])
    } finally {
      close([front, target])
    }
  })

  it('refuses a tarball redirect whose Location names a refused address', async () => {
    const targetHits: string[] = []
    const target = await listen((req, res) => { targetHits.push(req.url ?? ''); res.writeHead(200); res.end() })
    const redirector = await listen((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${String((target.address() as AddressInfo).port)}/sneaky.tgz` })
      res.end()
    })
    const registry = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ version: '9.9.9', dist: { tarball: urlOf(redirector, '/pkg.tgz') } }))
    })
    try {
      const result = await fetchCatalogFromNpmPackage('dsh-plugin-catalog', urlOf(registry, '/npm'), undefined, answering('93.184.216.34'))
      assert.equal('reason' in result && result.reason.code, 'source.privateAddress')
      assert.equal('reason' in result && result.reason.params?.host, '127.0.0.1')
      assert.deepEqual(targetHits, [])
    } finally {
      close([registry, redirector, target])
    }
  })
})

/** A minimal gzipped tar carrying one regular file, npm-style `package/plugins.json`. */
function catalogTarball(catalog: string): Buffer {
  const body = Buffer.from(catalog, 'utf8')
  const header = Buffer.alloc(512)
  header.write('package/plugins.json', 0, 'utf8')
  header.write(octalPadded(body.length), 124, 12, 'ascii')
  const pad = (512 - (body.length % 512)) % 512
  // Two empty headers end the tar.
  return gzipSync(Buffer.concat([header, body, Buffer.alloc(pad), Buffer.alloc(1024)]))
}

/** An octal size in tar's 11-char field form. */
function octalPadded(size: number): string {
  return size.toString(8).padStart(11, '0') + '\0'
}
