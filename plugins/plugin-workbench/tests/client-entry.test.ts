/**
 * The two registrations this plugin contributes, the stylesheet it injects, and
 * the dictionary their copy resolves through.
 *
 * The structural half exists because of how the entry is found rather than how
 * it is drawn. Two facts make these registrations unguarded everywhere else:
 * `sidebar.panellist` types its `id` as an open `string`, so nothing catches a
 * row whose id stops matching the panel id it is supposed to open; and the
 * sidebar renders no `data-slot` attribute on the row (measured), so a probe
 * locates it by `aria-label` — the registration's resolved label. A row ordered
 * `0` would tie with the kernel's own instead of sitting above it, and a drifted
 * id would surface only as a thrown `selectPanel: main panel "…" is not
 * registered` in the running app.
 *
 * Three more things are asserted that a reviewer would otherwise have to take
 * on trust:
 *
 * - the stylesheet is injected exactly ONCE, even when the entry is applied
 *   twice. `adoptStyles` is id-guarded, and a guard nobody exercises is a guard
 *   that can be deleted without a red test;
 * - `viewIds()` is exercised against the stub registry, including the entry no
 *   card can address. That branch decides whether `openView` refuses an unknown
 *   id, so a wrong answer makes every card silently inert;
 * - the card grid's own presence is NOT the page's business. It belongs to the
 *   seat's `fallback`, which the outlet subscribes to — asserting the absence of
 *   a `cardIds` in the face is what keeps a future edit from moving that
 *   decision back into a component that subscribes to nothing.
 *
 * @module plugin-workbench/tests/client-entry
 */

import { strict as assert } from 'node:assert'
import { afterEach, describe, it } from 'node:test'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { apply, PANEL_ID, PANEL_ORDER } from '../src/client.ts'
import { en, NS, zh } from '../src/client/locales.ts'
import type { WorkbenchKey } from '../src/client/locales.ts'

/** One captured `slots.register` call. */
interface Registration {
  readonly name: string
  readonly options: Record<string, unknown>
  readonly component: unknown
}

/**
 * Style ids the entry asked the document for, in order.
 *
 * Module-level because the assertions that need it run after `apply`, and the
 * stub is installed inside `loadClientEntry` so every existing call site keeps
 * its shape.
 */
const injectedStyles: string[] = []

/**
 * Install the smallest `document` that `adoptStyles` needs.
 *
 * The client entry injects its stylesheet through an id-guarded
 * `document.getElementById` + `document.head.append`, so a node process without
 * a DOM makes the entry throw before it registers anything — which would fail
 * every assertion below for a reason that has nothing to do with what they
 * assert. `append` records what the entry asked for, so the id-guard can be
 * asserted rather than assumed.
 */
function installDocumentStub(): void {
  const head = {
    append: (node: { id?: string }) => { injectedStyles.push(String(node.id)) },
  }
  const document = {
    getElementById: (id: string) => (injectedStyles.includes(id) ? head : null),
    createElement: () => ({ id: '', textContent: '' }),
    head,
  }
  ;(globalThis as { document?: unknown }).document = document
}

afterEach(() => {
  delete (globalThis as { document?: unknown }).document
})

/**
 * Run the client entry against a context that records instead of rendering.
 *
 * `bind` resolves through the dictionaries the entry registered, so the label
 * assertion reads the same text a user would: a stub that echoed the key would
 * pass while the dictionary was empty. `entriesOfSlot` answers a keyed seat the
 * way the real registry does, and deliberately includes an entry carrying no
 * key — the case `viewIds` has to skip.
 *
 * @returns every registration the entry made, in order.
 */
function loadClientEntry(): Registration[] {
  injectedStyles.length = 0
  installDocumentStub()
  const registrations: Registration[] = []
  const dictionaries = new Map<string, { zh: Record<string, string>; en: Record<string, string> }>()
  const ctx = {
    effect: (factory: () => unknown) => { factory() },
    locale: {
      register: (namespace: string, pair: { zh: Record<string, string>; en: Record<string, string> }) => {
        dictionaries.set(namespace, pair)
        return () => {}
      },
      bind: (namespace: string) => (key: string, params?: Record<string, unknown>) => {
        const template = dictionaries.get(namespace)?.zh[key] ?? `?${key}`
        if (params === undefined) return template
        // The real `t` interpolates `{name}` params; a stub that ignored them
        // would let a page render a placeholder and still pass.
        return template.replace(/\{(\w+)\}/gu, (whole, name: string) =>
          name in params ? String(params[name]) : whole)
      },
    },
    slots: {
      inject: (_name: string, factory: () => unknown) => { factory() },
      register: (options: Record<string, unknown>, component: unknown) => {
        registrations.push({ name: String(options.name), options, component })
        return () => {}
      },
      entriesOfSlot: () => [{ options: { key: 'novel' } }, { options: {} }],
    },
  }
  apply(ctx as unknown as ClientContext)
  return registrations
}

describe('workbench sidebar entry', () => {
  it('contributes the row and the page, and nothing else', () => {
    const registrations = loadClientEntry()
    assert.equal(registrations.length, 2, 'the row and the page it opens, and nothing else')
    assert.deepEqual(registrations.map((entry) => entry.name), ['sidebar.panellist', 'main'])
  })

  it('names itself with the exported panel id, so the row and the page cannot drift', () => {
    const options = loadClientEntry()[0]?.options ?? {}
    assert.equal(PANEL_ID, 'workbench')
    assert.equal(options.id, PANEL_ID)
  })

  it('sorts above the kernel rows instead of tying with them', () => {
    const options = loadClientEntry()[0]?.options ?? {}
    assert.equal(options.order, PANEL_ORDER)
    assert.ok(PANEL_ORDER < 0, `order must be negative, got ${String(PANEL_ORDER)}`)
  })

  it('resolves its label through this plugin own namespace', () => {
    const options = loadClientEntry()[0]?.options ?? {}
    assert.equal(options.locale, NS)
    const label = options.label as (() => string) | undefined
    assert.equal(typeof label, 'function')
    assert.equal(label?.(), zh['workbench.nav'])
  })

  it('registers a component, not data', () => {
    assert.equal(typeof loadClientEntry()[0]?.component, 'function')
  })

  it('injects its stylesheet once, even when the entry is applied twice', () => {
    loadClientEntry()
    loadClientEntry()
    // Mirrors `STYLE_ID` in src/client/styles.ts; the two spellings drifting
    // would leave a second stylesheet injected per apply.
    assert.deepEqual(injectedStyles, ['dsh-app-plugin-workbench-style'])
  })
})

describe('workbench container page seat', () => {
  it('registers the page under the exported panel id, so the row opens it', () => {
    const page = loadClientEntry()[1]
    assert.equal(page?.name, 'main')
    assert.equal(page?.options.key, PANEL_ID)
  })

  it('declares both domain seats as its children, which is what authorizes it to render them', () => {
    const children = (loadClientEntry()[1]?.options.children ?? {}) as Record<string, unknown>
    assert.deepEqual(Object.keys(children).sort(), ['workbench.item', 'workbench.view'])
    assert.equal((children['workbench.item'] as { kind?: string } | undefined)?.kind, 'list')
    assert.equal((children['workbench.view'] as { kind?: string })?.kind, 'keyed')
  })

  it('reads the view seat live and skips an entry no card can address', () => {
    const face = loadClientEntry()[1]?.options.inject
    assert.equal(typeof face, 'function')
    const injected = (face as () => {
      viewIds: () => readonly string[]
      enterWorkspace: unknown
      entryMessage: unknown
      cardIds?: unknown
    })()
    assert.deepEqual(injected.viewIds(), ['novel'])
    assert.equal(injected.cardIds, undefined, 'the grid presence belongs to the seat fallback, not to this face')
    // Both session-mode doors arrive through the same face: a registration that
    // forgot one would leave every session-bound card dead, with no error.
    assert.equal(typeof injected.enterWorkspace, 'function')
    assert.equal(typeof injected.entryMessage, 'function')
  })

  it('answers the three problem tokens with sentences a user can act on', () => {
    const face = loadClientEntry()[1]?.options.inject
    const injected = (face as () => { entryMessage: (status: string) => string })()
    const message = (status: string): string => injected.entryMessage(status as Parameters<typeof injected.entryMessage>[0])
    assert.equal(message('pending'), zh['workbench.entry.pending'])
    assert.equal(message('error:invalid-argument'), zh['workbench.entry.noPath'])
    assert.equal(message('error:workspace/invalid-path'), zh['workbench.entry.missingPath'])
    // A code this build does not own keeps the code in the sentence rather than
    // being dropped or claimed as something it is not.
    assert.equal(
      message('error:workspace/name-conflict'),
      zh['workbench.entry.error'].replace('{code}', 'workspace/name-conflict'),
    )
  })
})

describe('workbench dictionary', () => {
  it('owns a namespace under the suite scope', () => {
    assert.equal(NS, 'dsh-app.workbench')
  })

  it('has no empty value on either side', () => {
    for (const [key, value] of Object.entries(zh)) {
      assert.notEqual(value.trim(), '', `zh ${key}`)
    }
    for (const [key, value] of Object.entries(en)) {
      assert.notEqual(value.trim(), '', `en ${key}`)
    }
  })

  it('keeps every key inside this page prefix, so no two namespaces collide', () => {
    const keys = Object.keys(zh) as WorkbenchKey[]
    assert.ok(keys.length > 0)
    for (const key of keys) assert.ok(key.startsWith('workbench.'), key)
  })
})
