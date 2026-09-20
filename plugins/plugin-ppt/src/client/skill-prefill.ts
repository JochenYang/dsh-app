/**
 * Skill-reference insertion policy for the PPT capsule.
 *
 * Turning the mode on puts this plugin's chip at the head of the draft, over
 * whatever the user already typed. Because the office formats are mutually
 * exclusive, the same flip first strips any other office chip already sitting
 * in the draft (its clipboard-text form is the literal `/<skill> ` token), so
 * switching PDF → PPT replaces the chip instead of stacking a second one. The
 * cleanup is best effort: when the draft cannot be read it is skipped (and
 * reported) rather than blocking the insertion.
 *
 * The chip is editor state, so this policy never rewrites the draft unless the
 * kernel pipeline refused the insertion: an empty draft then degrades to the
 * literal `/<skill> ` token (still enough for the host to inject the skill
 * body), while a draft that already holds user text is only reported — the
 * whole-draft `setDraft` write must never discard what the user typed. The
 * cleanup is the one deliberate exception, and it only rewrites the draft when
 * it actually removed a chip token.
 *
 * The decision is DOM- and React-free (the binding is read structurally), so
 * the branch table is unit-testable without the browser-only react externals.
 *
 * @module @dsh-app/plugin-ppt/client/skill-prefill
 */

import { SKILL_NAME, SKILL_TOKEN, skillReferenceDispatcher } from './skill-reference.ts'
import type { ReferenceDispatch } from './skill-reference.ts'
import type { PptKey } from './locales.ts'

/** The skill this plugin installs; mirrors `SKILL_NAME` in src/skill.ts. */
export const PREFILL_SKILL = SKILL_NAME

/** The office chip tokens sharing the draft namespace, as clipboard text. */
export const OFFICE_CHIP_TOKENS: readonly string[] = ['/dsh-ppt', '/dsh-word', '/dsh-sheet', '/dsh-pdf']

/** Chip token plus the single trailing separator the insertion appends. */
const OFFICE_CHIP_PATTERN = /\/dsh-(?:ppt|word|sheet|pdf)(?![A-Za-z0-9_-])[ \t]*/g

/**
 * The minimal shape of one ui-session binding this module reads: the composer
 * write face rides `props.inputActions`, the published state rides the `input`
 * hook, and the session-scoped context rides the materialized binding itself.
 * All are optional in practice (the absent hero binding), hence the per-member
 * guards.
 */
export interface ComposerBinding {
  readonly props: Readonly<Record<string, unknown>>
  readonly hooks: Readonly<Record<string, { getSnapshot(): unknown } | undefined>>
  readonly ctx?: unknown
}

/** The composer write face plus the published draft, phase, and pipeline. */
export interface ComposerInput {
  readonly setDraft: (text: string) => void
  /** Clipboard-text draft, or `undefined` while the state is unavailable. */
  readonly draft: string | undefined
  /** Machine phase, or `undefined` while the state is unavailable. */
  readonly phase: string | undefined
  /** Editor revision the insertion span must CAS against. */
  readonly draftRev: number | undefined
  /** Chip insertion over the session scope, or `undefined` without a pipeline. */
  readonly dispatch: ReferenceDispatch | undefined
}

/** A resolved mode-on decision, before any write or dispatch. */
export type SkillReferencePlan =
  /** Put one chip at the head; `empty` decides what a refusal may degrade to. */
  | { readonly kind: 'insert', readonly span: { readonly start: 0, readonly end: 0, readonly draftRev: number }, readonly empty: boolean }
  /** No chip available: write the literal token (safe only over an empty draft). */
  | { readonly kind: 'seed', readonly draft: string }
  /** No chip available over user text: report, write nothing. */
  | { readonly kind: 'notice' }
  /** Not a mode-on flip, or the draft cannot be read/written safely. */
  | { readonly kind: 'skip' }

/** One draft rewrite that removed a chip token. */
export interface ChipCleanup {
  readonly text: string
  readonly removed: boolean
}

/** Escape a literal token for use inside a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Remove every office chip token (token + trailing whitespace) from a draft,
 * leaving all other text byte-for-byte intact. Pure, so the boundary cases
 * (token at the head, mid-text, several coexisting) are unit-testable.
 */
export function stripOfficeTokens(text: string): ChipCleanup {
  const cleaned = text.replace(OFFICE_CHIP_PATTERN, '')
  return { text: cleaned, removed: cleaned !== text }
}

/** Remove one specific skill token from a draft (the stand-down path). */
export function stripSkillToken(text: string, token: string): ChipCleanup {
  const cleaned = text.replace(new RegExp(`${escapeRegExp(token)}(?![A-Za-z0-9_-])[ \\t]*`, 'g'), '')
  return { text: cleaned, removed: cleaned !== text }
}

/**
 * Read the composer face off one session binding.
 * @param binding - the current ui-session binding, absent in the hero.
 * @returns the write face, published state, and pipeline, or `undefined`.
 */
export function composerInput(binding: ComposerBinding | undefined): ComposerInput | undefined {
  const actions = binding?.props.inputActions
  if (typeof actions !== 'object' || actions === null) return undefined
  const setDraft: unknown = (actions as { setDraft?: unknown }).setDraft
  if (typeof setDraft !== 'function') return undefined
  const published = binding?.hooks.input?.getSnapshot()
  const state = typeof published === 'object' && published !== null
    ? published as { draft?: unknown, phase?: unknown, draftRev?: unknown }
    : undefined
  return {
    setDraft: setDraft as (text: string) => void,
    draft: typeof state?.draft === 'string' ? state.draft : undefined,
    phase: typeof state?.phase === 'string' ? state.phase : undefined,
    draftRev: typeof state?.draftRev === 'number' ? state.draftRev : undefined,
    dispatch: skillReferenceDispatcher(binding),
  }
}

/**
 * Decide what one mode-on flip does to the draft.
 * @param state - published input state, or `undefined` when unavailable.
 * @param turningOn - whether this flip turns the mode on.
 * @param canDispatch - whether a chip insertion pipeline is resolvable.
 */
export function skillReferencePlan(
  state: { readonly draft?: unknown, readonly phase?: unknown, readonly draftRev?: unknown } | undefined,
  turningOn: boolean,
  canDispatch: boolean,
): SkillReferencePlan {
  if (!turningOn || state === undefined) return { kind: 'skip' }
  // A busy machine or an unreadable face is never touched: only the idle,
  // observable plain phase is a safe moment to edit the draft.
  if (typeof state.draft !== 'string' || state.phase !== 'plain') return { kind: 'skip' }
  const empty = state.draft.trim() === ''
  const rev = state.draftRev
  if (canDispatch && typeof rev === 'number' && Number.isSafeInteger(rev) && rev >= 0) {
    return { kind: 'insert', span: { start: 0, end: 0, draftRev: rev }, empty }
  }
  return skillDegradation(empty)
}

/**
 * The no-chip branch: the literal token goes in only when the draft is empty,
 * because `setDraft` replaces the whole draft.
 * @param empty - whether the published draft holds no text.
 */
export function skillDegradation(empty: boolean): SkillReferencePlan {
  return empty ? { kind: 'seed', draft: `${SKILL_TOKEN} ` } : { kind: 'notice' }
}

/**
 * Drop the other office chips from the draft before this format places its own.
 * Best effort: an unreadable draft is reported and left for the insertion path
 * (which degrades on its own rules) instead of blocking the turn-on. The face
 * is re-read after the rewrite because `setDraft` bumps the editor revision
 * the chip CAS must target.
 */
function cleanOfficeDraft(
  binding: ComposerBinding | undefined,
  input: ComposerInput | undefined,
): ComposerInput | undefined {
  if (input === undefined || input.phase !== 'plain') return input
  if (input.draft === undefined) {
    console.warn('[dsh-app plugin-ppt] the composer draft is unreadable; skipped the office chip cleanup')
    return input
  }
  const cleaned = stripOfficeTokens(input.draft)
  if (!cleaned.removed) return input
  input.setDraft(cleaned.text)
  return composerInput(binding) ?? input
}

/**
 * Apply a mode-on flip to the composer: replace any foreign office chip, then
 * insert this plugin's chip, or degrade exactly as an unavailable pipeline
 * would when the shell refuses the edit.
 * @param binding - the current ui-session binding.
 * @param turningOn - whether this flip turns the mode on.
 * @returns the resolved plan, so the caller can surface the hint for `notice`.
 */
export function applySkillReference(binding: ComposerBinding | undefined, turningOn: boolean): SkillReferencePlan {
  const input = turningOn ? cleanOfficeDraft(binding, composerInput(binding)) : composerInput(binding)
  const plan = skillReferencePlan(input, turningOn, input?.dispatch !== undefined)
  if (plan.kind === 'skip' || plan.kind === 'notice') return plan
  if (plan.kind === 'seed') {
    input?.setDraft(plan.draft)
    return plan
  }
  if (input?.dispatch !== undefined && input.dispatch(plan.span)) return plan
  // The shell refused (phase or revision CAS): fall back to the same table an
  // absent pipeline uses, so the host can still see the skill gesture.
  const degraded = skillDegradation(plan.empty)
  if (degraded.kind === 'seed') input?.setDraft(degraded.draft)
  return degraded
}

/**
 * Remove this plugin's own chip from the draft (the stand-down path: another
 * office format superseded this one). Writes only when a token was present.
 * @param binding - the current ui-session binding.
 * @returns whether the draft was rewritten.
 */
export function removeSkillReference(binding: ComposerBinding | undefined): boolean {
  const input = composerInput(binding)
  if (input === undefined || input.phase !== 'plain' || input.draft === undefined) return false
  const cleaned = stripSkillToken(input.draft, SKILL_TOKEN)
  if (!cleaned.removed) return false
  input.setDraft(cleaned.text)
  return true
}

/** Key of the hint shown when the turn-on could not place the skill reference. */
const SKILL_HINT_KEY = 'capsule.skillHint' satisfies PptKey

/**
 * One local hint as data: a dictionary key plus its params, resolved by the
 * caller's `t` seat. Nothing here builds a sentence, so a language switch
 * cannot leave a stale one behind.
 */
export interface SkillHintNotice {
  /** Key of this plugin's dictionary. */
  readonly key: typeof SKILL_HINT_KEY
  /** The capsule label and the literal token the user can type instead. */
  readonly params: { readonly label: string, readonly token: string }
}

/**
 * The hint shown when the mode turned on but the reference could not be placed
 * (the draft already held text, so nothing was written).
 * @param label - the format's capsule label.
 */
export function skillReferenceHint(label: string): SkillHintNotice {
  return { key: SKILL_HINT_KEY, params: { label, token: SKILL_TOKEN } }
}
