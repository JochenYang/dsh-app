/**
 * The market bridge: the projection of one skill card / catalog entry onto the
 * hit the model reads, the argument clamps, the orchestration decisions, and
 * the fact that `registerMarketBridge` really puts a `market_search` tool on
 * the context.
 *
 * What these pin: the field mapping (an upstream rename must fail here, not
 * silently ship `undefined`), the installed flag, the `installable` downgrade
 * for a source-only row, the empty-query refusal, the scope switch, and that a
 * failing branch becomes a `failures` row instead of a failed call — "could not
 * look" must never read as "nothing matched".
 *
 * The suite NEVER leaves the machine: the two branches are injected as stubs
 * through {@link runMarketSearch}, and the ranker they both rely on is covered
 * by catalog-filter.test.ts.
 *
 * @module plugin-market/tests/bridge
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { limitOf, pluginHitOf, registerMarketBridge, runMarketSearch, skillHitOf } from '../src/bridge.ts'
import type { CatalogEntry } from '../src/catalog.ts'
import type { SkillCard } from '../src/skills.ts'

/** A complete skill card; overrides keep each case one field wide. */
function card(overrides: Partial<SkillCard> = {}): SkillCard {
  return {
    slug: 'pdf-tools',
    name: 'PDF Tools',
    description: 'Read and write PDFs',
    category: 'office-efficiency',
    version: '1.2.0',
    downloads: 1200,
    stars: 30,
    ...overrides,
  }
}

/** A complete catalog entry; overrides keep each case one field wide. */
function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'x',
    name: 'X',
    description: 'a plugin',
    package: 'dsh-plugin-x',
    ...overrides,
  }
}

describe('limitOf', () => {
  it('defaults when the caller says nothing sensible', () => {
    assert.equal(limitOf(undefined), 8)
    assert.equal(limitOf('5'), 8)
    assert.equal(limitOf(Number.NaN), 8)
    assert.equal(limitOf(Number.POSITIVE_INFINITY), 8)
  })

  it('clamps into 1..25 and floors a fraction', () => {
    assert.equal(limitOf(0), 1)
    assert.equal(limitOf(-4), 1)
    assert.equal(limitOf(999), 25)
    assert.equal(limitOf(3.9), 3)
    assert.equal(limitOf(25), 25)
  })
})

describe('skillHitOf', () => {
  it('maps a full card onto the hit the model reads', () => {
    const hit = skillHitOf(card({ owner: 'alice', homepage: 'https://github.com/alice/skills' }), new Set())
    assert.deepEqual(hit, {
      kind: 'skill',
      id: 'pdf-tools',
      name: 'PDF Tools',
      description: 'Read and write PDFs',
      category: 'office-efficiency',
      version: '1.2.0',
      owner: 'alice',
      homepage: 'https://github.com/alice/skills',
      stars: 30,
      downloads: 1200,
      installed: false,
    })
  })

  it('omits the optional fields the source did not declare', () => {
    const hit = skillHitOf(card({ category: '', version: '' }), new Set())
    assert.equal('category' in hit, false)
    assert.equal('version' in hit, false)
    assert.equal('owner' in hit, false)
    assert.equal('homepage' in hit, false)
  })

  it('flags a slug that is already installed', () => {
    assert.equal(skillHitOf(card(), new Set(['pdf-tools'])).installed, true)
    assert.equal(skillHitOf(card(), new Set(['other'])).installed, false)
  })

  it('truncates an over-long description with an ellipsis', () => {
    const hit = skillHitOf(card({ description: 'x'.repeat(400) }), new Set())
    assert.equal(hit.description.length, 301)
    assert.ok(hit.description.endsWith('…'))
  })
})

describe('pluginHitOf', () => {
  it('maps a full entry onto the hit, installable by default', () => {
    const hit = pluginHitOf(entry({
      category: 'dev',
      version: '0.4.0',
      owner: 'bob',
      homepage: 'https://github.com/bob/x',
      stars: 9,
      downloads: 500,
    }), new Set())
    assert.deepEqual(hit, {
      kind: 'plugin',
      id: 'dsh-plugin-x',
      name: 'X',
      description: 'a plugin',
      category: 'dev',
      version: '0.4.0',
      owner: 'bob',
      homepage: 'https://github.com/bob/x',
      stars: 9,
      downloads: 500,
      installed: false,
      installable: true,
    })
  })

  it('downgrades a source-only row so no install is promised', () => {
    assert.equal(pluginHitOf(entry({ installable: false }), new Set()).installable, false)
    assert.equal(pluginHitOf(entry({ installable: true }), new Set()).installable, true)
  })

  it('flags a package the profile already declares', () => {
    assert.equal(pluginHitOf(entry(), new Set(['dsh-plugin-x'])).installed, true)
    assert.equal(pluginHitOf(entry(), new Set(['dsh-plugin-y'])).installed, false)
  })
})

/** A minimal host context: captures the tool + the prompt section registered. */
function stubCtx(): {
  ctx: never
  tools: Map<string, { execute(args: unknown, exec: unknown): Promise<unknown> }>
  sections: string[]
} {
  const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<unknown> }>()
  const sections: string[] = []
  const ctx = {
    tools: {
      register(definition: { name: string } & { execute(args: unknown, exec: unknown): Promise<unknown> }) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    systemPrompt: {
      section(section: { name: string }): () => void {
        sections.push(section.name)
        return () => undefined
      },
    },
  }
  return { ctx: ctx as never, tools, sections }
}

/** The deps a registration needs; the empty-query path below never reads them. */
const DEPS = {
  sourcesPath: 'unused-sources.json',
  catalogCachePath: 'unused-cache.json',
  profile: 'dsh-app',
  log: () => undefined,
}

describe('registerMarketBridge', () => {
  it('registers the tool and its prompt entry rule, and disposes both', () => {
    const { ctx, tools, sections } = stubCtx()
    const dispose = registerMarketBridge(ctx, DEPS)
    assert.deepEqual([...tools.keys()], ['market_search'])
    assert.deepEqual(sections, ['tool:market-bridge'])
    dispose()
    assert.equal(tools.size, 0)
  })

  it('wires the tool body to the orchestrator (empty query short-circuits first)', async () => {
    const { ctx, tools } = stubCtx()
    registerMarketBridge(ctx, DEPS)
    const tool = tools.get('market_search')!
    const result = await tool.execute({ query: '   ' }, {}) as {
      ok: boolean
      failures: Array<{ source: string, reason: string }>
      notes: string[]
    }
    assert.equal(result.ok, false)
    assert.equal(result.failures.length, 1)
    assert.equal(result.failures[0]!.source, 'skills')
    assert.match(result.notes[0]!, /market_search/)
  })

  it('honours the scope switch: skills-only never calls the plugin branch', async () => {
    const calls: string[] = []
    const result = await runMarketSearch({
      query: 'pdf tools',
      scope: 'skills',
      limit: 5,
      searchSkills: async () => { calls.push('skills'); return [] },
      searchPlugins: async () => { calls.push('plugins'); return [] },
    })
    assert.deepEqual(calls, ['skills'])
    assert.equal(result.scope, 'skills')
    assert.deepEqual(result.plugins, [])
    // An empty skills answer with no failure gets the "nothing matched" note.
    assert.equal(result.failures.length, 0)
    assert.ok(result.notes.some(n => n.includes('No skill matched')))
  })

  it('isolates a branch failure instead of failing the call', async () => {
    const result = await runMarketSearch({
      query: 'pdf tools',
      scope: 'all',
      limit: 5,
      searchSkills: async () => { throw new Error('HTTP 400') },
      searchPlugins: async () => [pluginHitOf(entry(), new Set())],
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.failures, [{ source: 'skills', reason: 'HTTP 400' }])
    assert.equal(result.plugins.length, 1)
    // A failed source must NOT be reported as "nothing matched".
    assert.equal(result.notes.some(n => n.includes('No plugin matched')), false)
  })

  it('refuses an empty query without calling either branch', async () => {
    const calls: string[] = []
    const result = await runMarketSearch({
      query: '   ',
      scope: 'all',
      limit: 5,
      searchSkills: async () => { calls.push('skills'); return [] },
      searchPlugins: async () => { calls.push('plugins'); return [] },
    })
    assert.deepEqual(calls, [])
    assert.equal(result.ok, false)
    assert.deepEqual(result.failures, [{ source: 'skills', reason: 'the query is required and was empty' }])
    assert.match(result.notes[0]!, /market_search/)
  })

  it('an unknown scope falls back to all', async () => {
    const calls: string[] = []
    const result = await runMarketSearch({
      query: 'x',
      scope: 'nonsense',
      limit: 5,
      searchSkills: async () => { calls.push('skills'); return [] },
      searchPlugins: async () => { calls.push('plugins'); return [] },
    })
    assert.deepEqual(calls, ['skills', 'plugins'])
    assert.equal(result.scope, 'all')
  })

  it('clamps the limit it passes to each branch', async () => {
    const seen: number[] = []
    await runMarketSearch({
      query: 'x',
      scope: 'all',
      limit: 9999,
      searchSkills: async (_q, limit) => { seen.push(limit); return [] },
      searchPlugins: async (_q, limit) => { seen.push(limit); return [] },
    })
    assert.deepEqual(seen, [25, 25])
  })
})
