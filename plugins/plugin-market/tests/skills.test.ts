/**
 * Skills-catalog tests: the card mapping's field validation, and the identity
 * a page-keyed list depends on.
 *
 * The identity case is the one that failed in the field: the source returns
 * the SAME slug for different authors within a single page (`dev-expert` once
 * per author, `anti-fraud` three times on one browse page). A list keyed on
 * the slug duplicates its keys, React reconciles against the wrong children,
 * and rows of the previous query stay in the DOM — which the reader sees as
 * "the category filter does nothing". The card therefore carries the source's
 * author-qualified name.
 *
 * @module plugin-market/tests/skills
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { parseSkillSlug, skillCardOf, skillMetaOf } from '../src/skills.ts'

/** One raw API row, with the namespace shape the source really sends. */
function rawRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'dev-expert',
    name: '编程专家.Skill',
    description_zh: '中文描述',
    category: 'dev-programming',
    version: '2.0.3',
    downloads: 2406625,
    stars: 303,
    ownerName: 'user_741dc82b',
    namespace: { canonicalName: '@indiv-ebandao/dev-expert', handle: 'indiv-ebandao' },
    homepage: 'https://github.com/ebandao/dev-expert',
    iconUrl: 'https://cdn.example.com/icon.png',
    ...overrides,
  }
}

describe('skillCardOf', () => {
  it('maps a full row onto a validated card', () => {
    const card = skillCardOf(rawRow())
    assert.ok(card !== null)
    assert.equal(card.slug, 'dev-expert')
    assert.equal(card.name, '编程专家.Skill')
    assert.equal(card.category, 'dev-programming')
    assert.equal(card.canonical, '@indiv-ebandao/dev-expert')
    assert.equal(card.owner, 'user_741dc82b')
    assert.equal(card.iconUrl, 'https://cdn.example.com/icon.png')
  })

  it('keeps two same-slug authors distinct by canonical name', () => {
    const a = skillCardOf(rawRow({ ownerName: 'user_741dc82b', namespace: { canonicalName: '@indiv-ebandao/dev-expert' } }))
    const b = skillCardOf(rawRow({ name: 'dev-expert', ownerName: 'user_814dbe54', namespace: { canonicalName: '@user_814dbe54/dev-expert' } }))
    assert.ok(a !== null && b !== null)
    assert.equal(a.slug, b.slug)
    assert.notEqual(a.canonical, b.canonical)
  })

  it('omits canonical when the source declares no namespace, never inventing one', () => {
    const card = skillCardOf(rawRow({ namespace: undefined }))
    assert.ok(card !== null)
    assert.equal(card.canonical, undefined)
  })

  it('accepts the plain description when the zh one is absent', () => {
    const card = skillCardOf(rawRow({ description_zh: undefined, description: 'English text' }))
    assert.ok(card !== null)
    assert.equal(card.description, 'English text')
  })

  it('refuses a row without a usable slug, and never a non-https icon', () => {
    assert.equal(skillCardOf(rawRow({ slug: '../escape' })), null)
    assert.equal(skillCardOf(rawRow({ slug: '' })), null)
    assert.equal(skillCardOf('not an object'), null)
    const card = skillCardOf(rawRow({ iconUrl: 'http://cdn.example.com/icon.png' }))
    assert.ok(card !== null)
    assert.equal(card.iconUrl, undefined)
  })

  it('clamps a counter to a non-negative integer instead of trusting it', () => {
    const card = skillCardOf(rawRow({ downloads: -5, stars: 'many' }))
    assert.ok(card !== null)
    assert.equal(card.downloads, 0)
    assert.equal(card.stars, 0)
  })
})

describe('parseSkillSlug', () => {
  it('accepts a slug and refuses path parts', () => {
    assert.equal(parseSkillSlug(' Dev-Expert '), 'dev-expert')
    assert.throws(() => parseSkillSlug('../../etc/passwd'))
    assert.throws(() => parseSkillSlug('-leading-dash'))
  })
})

describe('skillMetaOf (installed-skill display)', () => {
  it('reads a plain single-line front matter', () => {
    const meta = skillMetaOf('---\nname: dsh-pdf\ndescription: 读取 PDF\n---\n\n# Body\n', 'dsh-pdf')
    assert.equal(meta.name, 'dsh-pdf')
    assert.equal(meta.description, '读取 PDF')
  })

  it('reads a folded block scalar as its text, never as the ">-" marker', () => {
    // The real shape (agent-hub's SKILL.md). A hand-rolled `key: value` regex
    // answers the literal ">-" here, which is what shipped and read as a
    // broken description on the installed card.
    const meta = skillMetaOf(
      '---\nname: agent-comm-hub\ndescription: >-\n  Real-time two-way communication with other AI agents.\n  Use when the user mentions another agent.\n---\n\n# Body\n',
      'agent-hub',
    )
    assert.equal(meta.name, 'agent-comm-hub')
    assert.notEqual(meta.description, '>-')
    assert.match(meta.description, /^Real-time two-way communication/)
    assert.match(meta.description, /another agent\.$/)
  })

  it('reads a literal block scalar and collapses its newlines for a one-line slot', () => {
    const meta = skillMetaOf('---\nname: x\ndescription: |\n  line one\n  line two\n---\n', 'x')
    assert.equal(meta.description, 'line one line two')
  })

  it('ignores a quoted description\'s quotes and trailing whitespace', () => {
    const meta = skillMetaOf('---\nname: x\ndescription: "  spaced  "\n---\n', 'x')
    assert.equal(meta.description, 'spaced')
  })

  it('falls back to the slug for no front matter, no name, or malformed YAML', () => {
    assert.equal(skillMetaOf(undefined, 'slug').name, 'slug')
    assert.equal(skillMetaOf('# no front matter\n', 'slug').name, 'slug')
    assert.equal(skillMetaOf('---\ndescription: only\n---\n', 'slug').name, 'slug')
    // Malformed YAML must not throw out of a listing.
    assert.equal(skillMetaOf('---\nname: [unclosed\n---\n', 'slug').name, 'slug')
  })

  it('caps a very long description instead of letting it into the card', () => {
    const meta = skillMetaOf(`---\nname: x\ndescription: ${'a'.repeat(900)}\n---\n`, 'x')
    assert.equal(meta.description.length, 400)
  })
})
