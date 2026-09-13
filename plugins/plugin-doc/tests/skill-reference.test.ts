/**
 * Skill-reference contract: the capsule no longer seeds plain text. It
 * registers a trigger source whose codec keeps chip submission alive and
 * inserts one real kernel chip at the head of the draft through the scoped
 * insert-reference event. The retired CSS skin (`dshOfficeChip`) must leave no
 * residue in the sources or in the built client artifact.
 *
 * The insertion policy is DOM- and React-free, so the branch table (empty
 * draft, non-empty draft, unavailable or refused pipeline) is asserted
 * directly; the source and the dispatcher are plain objects, asserted without a
 * browser.
 *
 * @module @dsh-app/plugin-doc/tests/skill-reference
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SKILL_NAME } from '../src/skill.ts'
import {
  CHIP_APPEARANCE,
  CHIP_LABEL,
  REFERENCE_SOURCE,
  SKILL_TOKEN,
  createSkillReferenceSource,
  referenceChip,
  skillReferenceDispatcher,
} from '../src/client/skill-reference.ts'
import {
  OFFICE_CHIP_TOKENS,
  PREFILL_SKILL,
  applySkillReference,
  composerInput,
  removeSkillReference,
  skillDegradation,
  skillReferenceHint,
  skillReferencePlan,
  stripOfficeTokens,
  stripSkillToken,
} from '../src/client/skill-prefill.ts'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Every file under src/, as absolute paths. */
function sourceFiles(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const entry = join(dir, name)
      return statSync(entry).isDirectory() ? walk(entry) : [entry]
    })
  return walk(join(pluginRoot, 'src'))
}

/** A fake ui-session binding; `ctx` present only when a pipeline is installed. */
function bindingOf(
  actions: { setDraft: (text: string) => void } | undefined,
  state: { draft?: unknown, phase?: unknown, draftRev?: unknown } | undefined,
  ctx?: unknown,
) {
  return {
    props: actions === undefined ? {} : { inputActions: actions },
    hooks: state === undefined ? {} : { input: { getSnapshot: () => state } },
    ...(ctx === undefined ? {} : { ctx }),
  }
}

/** A fake session context whose bail records the dispatch and answers `reply`. */
function ctxOf(calls: unknown[], reply: unknown): unknown {
  return {
    bail(thisArg: unknown, event: string, request: unknown) {
      calls.push({ thisArg, event, request })
      return reply
    },
  }
}

test('skill reference: constants mirror the installed skill name', () => {
  assert.equal(SKILL_NAME, 'dsh-word')
  assert.equal(PREFILL_SKILL, SKILL_NAME)
  assert.equal(SKILL_TOKEN, `/${SKILL_NAME}`)
  assert.equal(REFERENCE_SOURCE, 'dsh-office-word')
  assert.equal(CHIP_LABEL, 'Word')
  assert.equal(CHIP_APPEARANCE, 'session')
})

test('skill reference: the registered source owns the codec and claims no menu space', async () => {
  const source = createSkillReferenceSource()
  assert.equal(source.trigger, '/')
  assert.equal(source.name, REFERENCE_SOURCE)
  assert.equal(source.showGroupTitle, false)
  // The `/` menu stays the kernel skill source's: no candidates, no query work.
  assert.deepEqual(await source.candidates(), [])
  // The constant lexicon is what makes the token read as a reference.
  assert.deepEqual(source.lexicon(), [SKILL_NAME])
  // Both projections are the literal gesture the host injects from.
  assert.equal(source.codec.clipboardText(SKILL_NAME), SKILL_TOKEN)
  assert.equal(await source.codec.serialize(SKILL_NAME), SKILL_TOKEN)
  assert.deepEqual(source.onPick(), { insert: referenceChip() })
})

test('skill reference: the chip payload carries label, skill ref, and clipboard token', () => {
  assert.deepEqual(referenceChip(), {
    source: REFERENCE_SOURCE,
    ref: SKILL_NAME,
    label: CHIP_LABEL,
    appearance: 'session',
    clipboardText: SKILL_TOKEN,
  })
})

test('skill reference: the dispatcher rides the session context and guards the span', () => {
  const calls: unknown[] = []
  const ctx = ctxOf(calls, true)
  const dispatch = skillReferenceDispatcher(bindingOf(undefined, undefined, ctx))
  assert.equal(typeof dispatch, 'function')
  assert.equal(dispatch?.({ start: 0, end: 0, draftRev: 7 }), true)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    thisArg: ctx,
    event: 'slash/input-insert-reference',
    request: { reference: referenceChip(), span: { start: 0, end: 0, draftRev: 7 } },
  })

  // A refused edit answers false, exactly like a CAS/phase refusal.
  assert.equal(skillReferenceDispatcher(bindingOf(undefined, undefined, ctxOf([], undefined)))?.({
    start: 0, end: 0, draftRev: 7,
  }), false)
  // No session scope and no dispatch verb both mean "no pipeline".
  assert.equal(skillReferenceDispatcher(bindingOf(undefined, undefined)), undefined)
  assert.equal(skillReferenceDispatcher(bindingOf(undefined, undefined, {})), undefined)
  assert.equal(skillReferenceDispatcher(undefined), undefined)
})

test('skill reference: an empty draft gets the chip, not the literal token', () => {
  const written: string[] = []
  const calls: unknown[] = []
  const binding = bindingOf({ setDraft: text => { written.push(text) } }, { draft: '', phase: 'plain', draftRev: 3 }, ctxOf(calls, true))
  const decision = applySkillReference(binding, true)
  assert.equal(decision.kind, 'insert')
  assert.deepEqual(calls.length, 1)
  assert.deepEqual(written, [])
})

test('skill reference: a non-empty draft keeps the user text and still gains the chip at the head', () => {
  const written: string[] = []
  const calls: unknown[] = []
  const binding = bindingOf(
    { setDraft: text => { written.push(text) } },
    { draft: '总结这份材料', phase: 'plain', draftRev: 4 },
    ctxOf(calls, true),
  )
  const decision = applySkillReference(binding, true)
  assert.equal(decision.kind, 'insert')
  assert.deepEqual(calls.length, 1)
  // The whole-draft write is never reached over user text.
  assert.deepEqual(written, [])
})

test('skill reference: a whitespace-only draft counts as empty', () => {
  const calls: unknown[] = []
  const decision = applySkillReference(
    bindingOf({ setDraft: () => {} }, { draft: '   ', phase: 'plain', draftRev: 1 }, ctxOf(calls, true)),
    true,
  )
  assert.equal(decision.kind, 'insert')
})

test('skill reference: an absent pipeline degrades to the literal token on an empty draft', () => {
  const written: string[] = []
  const decision = applySkillReference(
    bindingOf({ setDraft: text => { written.push(text) } }, { draft: '', phase: 'plain', draftRev: 2 }),
    true,
  )
  assert.deepEqual(decision, { kind: 'seed', draft: `${SKILL_TOKEN} ` })
  assert.deepEqual(written, [`${SKILL_TOKEN} `])
})

test('skill reference: a refused insertion degrades the same way', () => {
  const written: string[] = []
  const decision = applySkillReference(
    bindingOf({ setDraft: (text: string) => { written.push(text) } }, { draft: '', phase: 'plain', draftRev: 2 }, ctxOf([], false)),
    true,
  )
  assert.deepEqual(decision, { kind: 'seed', draft: `${SKILL_TOKEN} ` })
  assert.deepEqual(written, [`${SKILL_TOKEN} `])
})

test('skill reference: user text is only reported when no chip could be placed', () => {
  for (const ctx of [undefined, ctxOf([], false)]) {
    const written: string[] = []
    const decision = applySkillReference(
      bindingOf({ setDraft: text => { written.push(text) } }, { draft: '总结这份材料', phase: 'plain', draftRev: 2 }, ctx),
      true,
    )
    assert.deepEqual(decision, { kind: 'notice' })
    assert.deepEqual(written, [])
  }
})

test('skill reference: turning the mode off and unreadable or busy faces do nothing', () => {
  const written: string[] = []
  const actions = { setDraft: (text: string) => { written.push(text) } }
  assert.deepEqual(applySkillReference(bindingOf(actions, { draft: '', phase: 'plain', draftRev: 1 }, ctxOf([], true)), false), { kind: 'skip' })
  assert.deepEqual(applySkillReference(undefined, true), { kind: 'skip' })
  assert.deepEqual(applySkillReference(bindingOf(undefined, { draft: '', phase: 'plain', draftRev: 1 }), true), { kind: 'skip' })
  // An unreadable published state cannot be proven idle.
  assert.deepEqual(applySkillReference(bindingOf(actions, undefined), true), { kind: 'skip' })
  for (const phase of ['adjudicating', 'claimed', 'submitting']) {
    assert.deepEqual(applySkillReference(bindingOf(actions, { draft: '', phase, draftRev: 1 }, ctxOf([], true)), true), { kind: 'skip' }, `phase ${phase}`)
  }
  // A chip without a revision guard cannot be CAS'd, so it degrades instead.
  assert.deepEqual(
    applySkillReference(bindingOf(actions, { draft: '', phase: 'plain' }, ctxOf([], true)), true),
    { kind: 'seed', draft: `${SKILL_TOKEN} ` },
  )
  assert.deepEqual(written, [`${SKILL_TOKEN} `])
})

test('skill reference: the plan table is pure and the degradation table is shared', () => {
  assert.deepEqual(skillReferencePlan({ draft: 'x', phase: 'plain', draftRev: 9 }, true, true), {
    kind: 'insert',
    span: { start: 0, end: 0, draftRev: 9 },
    empty: false,
  })
  assert.deepEqual(skillReferencePlan({ draft: '', phase: 'plain', draftRev: 9 }, true, false), { kind: 'seed', draft: `${SKILL_TOKEN} ` })
  assert.deepEqual(skillReferencePlan({ draft: 'x', phase: 'plain', draftRev: 9 }, true, false), { kind: 'notice' })
  assert.deepEqual(skillDegradation(true), { kind: 'seed', draft: `${SKILL_TOKEN} ` })
  assert.deepEqual(skillDegradation(false), { kind: 'notice' })
})

test('skill reference: composer input is read structurally off the binding', () => {
  const setDraft = (): void => {}
  const input = composerInput(bindingOf({ setDraft }, { draft: 'x', phase: 'plain', draftRev: 5 }))
  assert.equal(input?.setDraft, setDraft)
  assert.equal(input?.draft, 'x')
  assert.equal(input?.phase, 'plain')
  assert.equal(input?.draftRev, 5)
  assert.equal(input?.dispatch, undefined)
})

test('skill reference: the hint names the mode and the manual token', () => {
  const hint = skillReferenceHint('Word')
  assert.match(hint, /已开启 Word 模式/)
  assert.match(hint, new RegExp(SKILL_TOKEN))
})

test('skill reference: the client registers the source and no CSS skin remains', () => {
  assert.equal(existsSync(join(pluginRoot, 'src', 'client', 'skill-chip.ts')), false)
  const client = readFileSync(join(pluginRoot, 'src', 'client.ts'), 'utf8')
  assert.match(client, /ctx\.inject\(\['inputTriggers'\]/)
  assert.match(client, /registry\.registerSource\(createSkillReferenceSource\(\)\)/)
  assert.doesNotMatch(client, /mountSkillChip|skill-chip/)

  for (const file of sourceFiles()) {
    const source = readFileSync(file, 'utf8')
    assert.doesNotMatch(source, /dshOfficeChip/, `${file} still carries the retired chip class`)
  }
})

test('skill reference: the built client artifact carries the source and no chip skin', () => {
  const artifact = join(pluginRoot, 'lib', 'client.js')
  // lib/ is generated output and absent in a fresh checkout; assert on it only
  // when it exists, so a stale pre-change build still fails loudly.
  if (!existsSync(artifact)) return
  const bundle = readFileSync(artifact, 'utf8')
  assert.match(bundle, /dsh-office-word/)
  assert.match(bundle, /slash\/input-insert-reference/)
  assert.match(bundle, /registerSource/)
  assert.match(bundle, /clipboardText/)
  assert.doesNotMatch(bundle, /dshOfficeChip/)
})

test('chip cleanup: the office token regex removes head, mid-text, trailing and coexisting tokens', () => {
  assert.deepEqual(OFFICE_CHIP_TOKENS, ['/dsh-ppt', '/dsh-word', '/dsh-sheet', '/dsh-pdf'])
  const strip = (text: string): string => stripOfficeTokens(text).text

  assert.equal(strip('/dsh-word '), '')
  assert.equal(strip('/dsh-ppt 材料'), '材料', 'a head token and its separator go together')
  assert.equal(strip('材料 /dsh-pdf 继续'), '材料 继续', 'a mid-text token keeps the surrounding text')
  assert.equal(strip('材料 /dsh-sheet'), '材料 ', 'a token at the very end still goes, its leading space stays')
  assert.equal(strip('/dsh-ppt /dsh-word '), '', 'coexisting office tokens all go')
  assert.equal(strip('材料 /dsh-ppt /dsh-pdf 继续'), '材料 继续')
  assert.equal(strip('材料原文'), '材料原文')
  assert.equal(strip('/dsh-pptX '), '/dsh-pptX ')
  assert.equal(strip('比值 1/2'), '比值 1/2')
})

test('chip cleanup: stripSkillToken removes only the named token', () => {
  assert.deepEqual(stripSkillToken('/dsh-word /dsh-pdf 材料', '/dsh-word'), { text: '/dsh-pdf 材料', removed: true })
  assert.deepEqual(stripSkillToken('材料', '/dsh-word'), { text: '材料', removed: false })
})

test('chip cleanup: turning another format on replaces the existing office chip', () => {
  const written: string[] = []
  const calls: unknown[] = []
  const state = { draft: '/dsh-ppt 总结这份材料', phase: 'plain', draftRev: 3 }
  const binding = bindingOf(
    { setDraft: text => { written.push(text); state.draft = text; state.draftRev += 1 } },
    state,
    ctxOf(calls, true),
  )
  const decision = applySkillReference(binding, true)
  assert.equal(decision.kind, 'insert')
  assert.deepEqual(written, ['总结这份材料'])
  assert.equal(calls.length, 1)
  assert.deepEqual((calls[0] as { request: { span: unknown } }).request.span, { start: 0, end: 0, draftRev: 4 })
})

test('chip cleanup: without a pipeline the cleaned draft gets the literal token back', () => {
  const written: string[] = []
  const state = { draft: '/dsh-sheet ', phase: 'plain', draftRev: 2 }
  const binding = bindingOf(
    { setDraft: text => { written.push(text); state.draft = text; state.draftRev += 1 } },
    state,
  )
  const decision = applySkillReference(binding, true)
  assert.deepEqual(decision, { kind: 'seed', draft: `${SKILL_TOKEN} ` })
  assert.deepEqual(written, ['', `${SKILL_TOKEN} `])
})

test('chip cleanup: an unreadable draft is reported and does not block the flip', () => {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (message: unknown) => { warnings.push(String(message)) }
  try {
    const calls: unknown[] = []
    const decision = applySkillReference(
      bindingOf({ setDraft: () => {} }, { phase: 'plain', draftRev: 2 }, ctxOf(calls, true)),
      true,
    )
    assert.deepEqual(decision, { kind: 'skip' })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /跳过办公 chip 清理/)
  } finally {
    console.warn = original
  }
})

test('chip cleanup: the stand-down path removes only this plugin chip', () => {
  const written: string[] = []
  const state = { draft: '/dsh-word /dsh-pdf 材料', phase: 'plain', draftRev: 1 }
  const binding = bindingOf(
    { setDraft: text => { written.push(text); state.draft = text } },
    state,
  )
  assert.equal(removeSkillReference(binding), true)
  assert.deepEqual(written, ['/dsh-pdf 材料'])
  assert.equal(removeSkillReference(binding), false)
  assert.equal(written.length, 1)
})
