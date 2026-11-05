/**
 * The Creator door: what the row registers, what the prompt says, and every way
 * a press can end.
 *
 * The action is taken from the LIVE registration rather than imported and called
 * directly, because the wiring is half the contract: an action that never
 * reaches the row is a row that does nothing, and every token test below would
 * still pass. So the assertions read the face the registration actually injects.
 *
 * Every branch a press can reach is here, and none of them may throw: the caller
 * is a React event handler, where a rejection is an unhandled rejection and no
 * copy at all. The `pending` cases are asserted by resolving nothing — which is
 * exactly the state a press meets on a kernel whose workspace line is not up.
 *
 * The prompt assertions are the other half, and they run over BOTH dictionaries.
 * The string becomes the composer's draft — the user reads and edits it — so it
 * is copy, not configuration: each language must carry the skill name and the
 * session-scoped lifetime, and neither may repeat a seat name (the seat contract
 * lives in the skill). The action itself is driven with a sentinel and with each
 * language's resolved value, which is what proves it forwards the caller's string
 * instead of holding one of its own.
 *
 * The ROW's composition is asserted from source, not by rendering it: this suite
 * has no DOM and no React renderer, so a component cannot be mounted — and the
 * thing worth guarding is not the pixels but the decision. `MenuItemButton` from
 * the primitives package is the row (it brings `role="menuitem"`, the group
 * hairline and the menu's keyboard walk), `onSelect` is wired to the action,
 * `disabled` is derived from state rather than being a literal, and the prompt it
 * passes is a dictionary value. A hand-rolled `<button role="menuitem">` would
 * look the same and lose the walk, which is why that shape is asserted absent.
 *
 * @module plugin-workbench/tests/create-entry
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it } from 'node:test'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { apply } from '../src/client.ts'
import { CREATOR_AGENT_PRESET } from '../src/client/create.ts'
import { NS } from '../src/client/locales.ts'
import { WORKBENCH_SKILL_NAME } from '../src/contract.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const srcDir = join(here, '..', 'src')
const pluginRoot = join(here, '..')

/** One recorded `startSession` call. */
interface StartCall {
  readonly workspaceId: unknown
  readonly options: Record<string, unknown>
}

/** What a press runs: the action the row's face injects. */
type CreatorAction = (prompt: string) => Promise<string>

/**
 * A string the action must carry through untouched.
 *
 * Deliberately not a sentence from the dictionary: the action has no copy of its
 * own, and this is what proves it.
 */
const SENTINEL_PROMPT = 'draft-text-the-row-built'

/** One of the two dictionaries the client entry registers. */
type Language = 'zh' | 'en'

/** What one apply hands back: the action, and the `t` the row would call. */
interface LoadedCreator {
  /** The action, ready to press. */
  readonly createPlugin: CreatorAction
  /**
   * The `t` the framework hands the row, for one language: the entry's OWN
   * registered pair, `{name}` substitution included. Built from what the entry
   * registered rather than from the imported dictionaries, so a key the entry
   * failed to register shows up as `?<key>` right here.
   */
  readonly translate: (language: Language, key: string, params?: Record<string, unknown>) => string
}

/**
 * Install the smallest `document` that `adoptStyles` needs.
 *
 * The client entry injects its stylesheet before registering anything, so a node
 * process without a DOM makes `apply` throw for a reason that has nothing to do
 * with what these tests assert.
 */
function installDocumentStub(): void {
  const head = { append: () => {} }
  ;(globalThis as { document?: unknown }).document = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head,
  }
}

afterEach(() => {
  delete (globalThis as { document?: unknown }).document
})

/**
 * Apply the client half against a context whose services are `services`, and
 * return the Creator action the row was handed plus a translate over the
 * dictionaries the entry registered.
 *
 * `register` captures the inject face of the `sidebar.panellist.actions`
 * registration and nothing else — a registration that targeted another seat
 * would leave the action undefined and fail loudly here.
 *
 * @param services - what `ctx.get(name)` answers.
 * @returns the action, and the row's `t` for either language.
 */
function loadCreator(services: Record<string, unknown>): LoadedCreator {
  installDocumentStub()
  const dictionaries = new Map<string, Record<Language, Record<string, string>>>()
  const translate = (language: Language, key: string, params: Record<string, unknown> = {}): string => {
    const template = dictionaries.get(NS)?.[language][key] ?? `?${key}`
    return template.replace(/\{(\w+)\}/gu, (whole, name: string) =>
      name in params ? String(params[name]) : whole)
  }
  let action: CreatorAction | undefined
  const ctx = {
    effect: (factory: () => unknown) => { factory() },
    get: (name: string) => services[name],
    locale: {
      register: (namespace: string, pair: Record<Language, Record<string, string>>) => {
        dictionaries.set(namespace, pair)
        return () => {}
      },
      bind: (_namespace: string) => (key: string, params?: Record<string, unknown>) => {
        // The entry binds this namespace at apply time; `translate` is the same
        // lookup with the language made explicit, which is what these tests need.
        return translate('zh', key, params)
      },
    },
    slots: {
      inject: (_name: string, factory: () => unknown) => { factory() },
      register: (options: Record<string, unknown>) => {
        if (options.name === 'sidebar.panellist.actions') {
          const face = options.inject as () => { createPlugin: CreatorAction }
          action = face().createPlugin
        }
        return () => {}
      },
      entriesOfSlot: () => [],
    },
  }
  apply(ctx as unknown as ClientContext)
  assert.ok(action !== undefined, 'the Creator row must register an action into sidebar.panellist.actions')
  return { createPlugin: action, translate }
}

/** A workspace controller whose `startSession` records its arguments. */
function recordingService(
  behaviour: (call: StartCall) => Promise<unknown> = async () => {},
): {
  uiWorkspace: { startSession: (workspaceId: unknown, options: Record<string, unknown>) => Promise<unknown> }
  calls: StartCall[]
} {
  const calls: StartCall[] = []
  return {
    calls,
    uiWorkspace: {
      startSession: (workspaceId: unknown, options: Record<string, unknown>) => {
        const call = { workspaceId, options }
        calls.push(call)
        return behaviour(call)
      },
    },
  }
}

describe('workbench Creator action', () => {
  it('answers pending while the workspace service is absent, instead of throwing', async () => {
    assert.equal(await loadCreator({}).createPlugin(SENTINEL_PROMPT), 'pending')
  })

  it('answers pending when the service is there but startSession is not callable', async () => {
    // A seam that changed shape answers pending rather than calling undefined.
    assert.equal(await loadCreator({ uiWorkspace: { startSession: 'nope' } }).createPlugin(SENTINEL_PROMPT), 'pending')
    assert.equal(await loadCreator({ uiWorkspace: {} }).createPlugin(SENTINEL_PROMPT), 'pending')
  })

  it('starts the creator preset with the prompt it is handed, appending to an existing draft', async () => {
    const service = recordingService()
    const { createPlugin } = loadCreator({ uiWorkspace: service.uiWorkspace })
    assert.equal(await createPlugin(SENTINEL_PROMPT), 'ok')
    assert.equal(service.calls.length, 1)
    const [call] = service.calls
    // `undefined` rather than a workspace id: the session is created in the
    // current workspace, the shape the kernel's own rows pass.
    assert.equal(call?.workspaceId, undefined)
    assert.deepEqual(call?.options, {
      agentPreset: 'cordis',
      prompt: SENTINEL_PROMPT,
      whenDraftExists: 'append',
    })
  })

  it('sends the dictionary value of the language in force, never a copy of its own', async () => {
    // The prompt is DRAFT text the user reads and edits, so the language matters:
    // this drives the action with what the row's own `t` produces in each
    // language and checks it arrives unchanged. A constant inside this module
    // would pass every other test here and fail this one.
    const service = recordingService()
    const { createPlugin, translate } = loadCreator({ uiWorkspace: service.uiWorkspace })
    const promises = (['zh', 'en'] as const).map(language =>
      translate(language, 'workbench.createPrompt', { skill: WORKBENCH_SKILL_NAME }))
    for (const prompt of promises) {
      assert.equal(await createPlugin(prompt), 'ok')
      assert.equal(service.calls.at(-1)?.options.prompt, prompt)
    }
    // The two languages really differ, so the comparison above is not vacuous.
    assert.notEqual(promises[0], promises[1])
  })

  it('carries the host code through, in both shapes a Remote call rejects with', async () => {
    const direct = recordingService(async () => {
      throw Object.assign(new Error('refused'), { code: 'session/create-failed' })
    })
    assert.equal(
      await loadCreator({ uiWorkspace: direct.uiWorkspace }).createPlugin(SENTINEL_PROMPT),
      'error:session/create-failed',
    )

    const wrapped = recordingService(async () => { throw { rpcError: { code: 'agent-preset/not-found' } } })
    assert.equal(
      await loadCreator({ uiWorkspace: wrapped.uiWorkspace }).createPlugin(SENTINEL_PROMPT),
      'error:agent-preset/not-found',
    )
  })

  it('answers unexpected for a rejection carrying no code', async () => {
    const service = recordingService(async () => { throw new Error('boom') })
    assert.equal(await loadCreator({ uiWorkspace: service.uiWorkspace }).createPlugin(SENTINEL_PROMPT), 'error:unexpected')
  })

  it('reports a synchronous throw from startSession as a token too', async () => {
    // `startSession` is reached through a structural cast, so nothing promises it
    // returns a promise. A synchronous throw inside `try` still lands in the
    // catch, and the click handler sees a token.
    const uiWorkspace = { startSession: () => { throw { code: 'session/busy' } } }
    assert.equal(await loadCreator({ uiWorkspace }).createPlugin(SENTINEL_PROMPT), 'error:session/busy')
  })
})

describe('workbench Creator prompt', () => {
  /** What the row would hand the action, in one language. */
  const promptIn = (translate: LoadedCreator['translate'], language: Language): string =>
    translate(language, 'workbench.createPrompt', { skill: WORKBENCH_SKILL_NAME })

  it('is a registered dictionary key with copy on both sides', () => {
    const { translate } = loadCreator({})
    const prompts = (['zh', 'en'] as const).map(language => promptIn(translate, language))
    for (const prompt of prompts) {
      // A key the entry did not register comes back as `?<key>`, and an empty
      // value would leave the composer blank: this is the assertion that fails if
      // the prompt is ever written outside the dictionary.
      assert.ok(!prompt.startsWith('?'), 'workbench.createPrompt is not in the dictionary')
      assert.notEqual(prompt.trim(), '')
    }
  })

  it('carries the skill name, and the instruction to load it, in both languages', () => {
    const { translate } = loadCreator({})
    for (const language of ['zh', 'en'] as const) {
      const prompt = promptIn(translate, language)
      assert.ok(prompt.includes(WORKBENCH_SKILL_NAME), `${language}: ${prompt}`)
    }
    assert.match(promptIn(translate, 'zh'), /加载/u)
    assert.match(promptIn(translate, 'en'), /Load the/u)
  })

  it('tells the user the card is session-scoped, in their own language', () => {
    const { translate } = loadCreator({})
    // The two facts the product must state: the card lives in this session, and a
    // restart drops it. Both languages, in their own words.
    assert.match(promptIn(translate, 'zh'), /本次会话/u)
    assert.match(promptIn(translate, 'zh'), /重启/u)
    assert.match(promptIn(translate, 'en'), /this session only/u)
    assert.match(promptIn(translate, 'en'), /restart/u)
  })

  it('names no seat, in either language', () => {
    // The seat names live in the skill (`src/skill.ts`); the prompt's job is to
    // send the agent there. A prompt that repeated them would be a second copy of
    // a contract that moves with the container.
    const { translate } = loadCreator({})
    for (const language of ['zh', 'en'] as const) {
      assert.doesNotMatch(promptIn(translate, language), /workbench\.item|workbench\.view/u)
    }
  })

  it('names the preset the kernel owns', () => {
    assert.equal(CREATOR_AGENT_PRESET, 'cordis')
  })
})

describe('workbench copy discipline', () => {
  /**
   * The files this round added, relative to `src/`.
   *
   * A raw scan is fair here and only here: these files are new, so no older
   * comment can be blamed, and the repo-wide rule (comments excluded, every
   * other plugin file covered) is `scripts/check-plugin-graph.mjs`
   * `checkHanCharacters` — this is the cheap local reminder that a new file must
   * not carry copy of its own.
   */
  const ADDED = [
    'contract.ts',
    'skill.ts',
    'index.ts',
    'client/create.ts',
    'client/create-row.tsx',
  ]

  it('keeps user-visible copy out of every file this round added', () => {
    for (const relative of ADDED) {
      const text = readFileSync(join(srcDir, relative), 'utf8').replace(/\r\n/gu, '\n')
      assert.doesNotMatch(text, /[\p{Script=Han}]/u, `${relative} holds Han characters; copy belongs in locales.ts`)
    }
  })
})

describe('workbench Creator row composition', () => {
  /** One source file of this plugin, with CRLF folded to LF. */
  const source = (relative: string): string =>
    readFileSync(join(srcDir, relative), 'utf8').replace(/\r\n/gu, '\n')

  const row = (): string => source('client/create-row.tsx')

  /**
   * The JSX of the row, without the module header.
   *
   * The negative assertions below ("no hand-drawn button") must read the
   * RENDERED shape, and the header necessarily TALKS about the shapes it
   * rejects — a raw scan would fail on the prose that explains the rule.
   */
  const rowBody = (): string => {
    const text = row()
    return text.slice(text.lastIndexOf('return ('))
  }

  it('composes the menu row primitive instead of drawing one', () => {
    // Choosing the row shape is the primitive's job: `MenuItemButton` brings the
    // `role="menuitem"` button, the hairline and the menu's own keyboard walk.
    // Replacing it with markup that imitates the result is the regression this
    // assertion exists for — it looks identical and loses the walk.
    assert.match(row(), /import \{[^}]*\bMenuItemButton\b[^}]*\} from '@deepseek-ai\/dsh-client-ui-primitives'/s)
    assert.match(rowBody(), /<MenuItemButton\n/u)
    assert.doesNotMatch(rowBody(), /<button[\s>]/u)
    assert.doesNotMatch(rowBody(), /role="menuitem"/u)
    assert.doesNotMatch(rowBody(), /role="separator"/u)
  })

  it('groups itself and carries the set own plus glyph', () => {
    // `separatorBefore` draws the hairline that comes and goes with this row; the
    // icon is the package's plus, because "create" is that glyph already and a
    // second one for the same verb would read as a different action.
    assert.match(rowBody(), /separatorBefore\n/u)
    assert.match(rowBody(), /icon=\{<IconPlusOutlineRegular size=\{16\} \/>\}/u)
    assert.doesNotMatch(rowBody(), /<svg/u)
  })

  it('wires onSelect to the action, and disables the row only from state', () => {
    assert.match(row(), /onSelect=\{select\}/u)
    // The handler is the function that calls the action: `onSelect={select}` and
    // `createPlugin()` inside `select`, in that same file.
    assert.match(row(), /const select = \(\): void => \{/u)
    assert.match(row(), /void createPlugin\(/u)
    assert.match(row(), /if \(status === 'ok'\) \{\n\s+onDismiss\(\)/u)
    // Disabled comes from state, never from a literal: a hardcoded `disabled`
    // would either kill the row or let a second press start a second session.
    assert.match(row(), /disabled=\{starting\}/u)
    assert.match(row(), /const \[starting, setStarting\] = useState\(false\)/u)
    assert.doesNotMatch(row(), /disabled=\{?(true|false)\}?/u)
  })

  it('resolves the opening prompt through the dictionary, not from a string of its own', () => {
    // The prompt becomes the composer's DRAFT, so the user reads it: a literal
    // sentence here (or in `create.ts`, which now takes the string as a
    // parameter) would show English in a Chinese UI. This is the assertion that
    // catches that coming back — the action's own tests only prove it forwards
    // what it is given.
    assert.match(row(), /createPlugin\(t\('workbench\.createPrompt', \{ skill: WORKBENCH_SKILL_NAME \}\)\)/u)
    assert.match(row(), /import \{ WORKBENCH_SKILL_NAME \} from '\.\.\/contract\.ts'/u)
    // No sentence is passed to the action: the only argument is that call.
    assert.doesNotMatch(row(), /createPlugin\('[^']*[A-Za-z]{4,}/u)
  })

  it('renders the problem token through the same copy the page uses', () => {
    // The token, not a sentence: one set of words for one status, and the
    // failure of a press stays visible instead of being swallowed by the menu.
    assert.match(row(), /entryMessage\(problem\)/u)
    assert.match(row(), /useState<WorkbenchEntryProblem>/u)
  })

  it('takes its copy from the dictionary', () => {
    assert.match(row(), /t\('workbench\.create'\)/u)
    assert.doesNotMatch(row(), /[\p{Script=Han}]/u)
  })

  it('draws no dialog, no mask and no native prompt', () => {
    assert.doesNotMatch(row(), /window\.(alert|confirm|prompt)\s*\(/u)
  })

  it('declares the primitives package the way the suite does, and the test stub covers it', () => {
    // Both halves matter and neither is visible from the component: the build
    // marks `@deepseek-ai/*` external, so an undeclared import ships and then
    // fails to resolve in the profile; and `tsc` resolves the import through
    // `devDependencies`, so a peer without its dev twin makes the type gate skip
    // this plugin instead of checking it.
    //
    // The expected spec is read from the FOLLOWED LINE, not written out here: a
    // literal on the old kernel line turned every line move into a test failure with
    // no product defect behind it (measured on 0.2.2-rc.1), while "equals the line"
    // is the property this case actually asserts.
    const manifest = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')) as {
      peerDependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const rootManifest = JSON.parse(readFileSync(join(pluginRoot, '..', '..', 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>
    }
    const followedLine = rootManifest.devDependencies?.['@deepseek-ai/dsh-session']
    assert.ok(typeof followedLine === 'string' && followedLine !== '', 'the root manifest declares the followed line')
    assert.equal(manifest.peerDependencies?.['@deepseek-ai/dsh-client-ui-primitives'], followedLine)
    assert.equal(manifest.devDependencies?.['@deepseek-ai/dsh-client-ui-primitives'], followedLine)

    // The test bundle aliases the package to a stub (it is a browser bundle: clsx,
    // CSS modules, dynamic shikijs). Every name this plugin imports from it has to
    // exist there, or the bundle fails with an esbuild "No matching export" that
    // says nothing about why. This turns that into a named failure.
    const stub = readFileSync(join(pluginRoot, 'scripts', 'stub-dsh-client-ui-primitives.mjs'), 'utf8')
    const imported = new Set<string>()
    for (const file of ['client/create-row.tsx', 'client/page.tsx', 'client.ts', 'client/icon.tsx']) {
      for (const match of source(file).matchAll(/import \{([^}]*)\} from '@deepseek-ai\/dsh-client-ui-primitives'/gu)) {
        for (const name of (match[1] ?? '').split(',')) {
          const trimmed = name.trim()
          if (trimmed !== '') imported.add(trimmed)
        }
      }
    }
    assert.deepEqual([...imported].sort(), ['IconPlusOutlineRegular', 'MenuItemButton'])
    for (const name of imported) {
      assert.match(stub, new RegExp(`export function ${name}\\(`, 'u'), `${name} is not exported by the test stub`)
    }
  })
})
