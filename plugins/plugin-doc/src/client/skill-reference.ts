/**
 * The composer's real skill reference for the Word capsule.
 *
 * Turning the mode on puts one kernel reference chip at the head of the draft.
 * The chip is a Lexical decorator node owned by the conversation shell, so it
 * is editor state: the browser's spell checker does not read it as a word, and
 * Backspace deletes it whole. The literal `/<skill> ` seed could only ever be
 * plain text — the shell's lexicon scan is a paint layer, not state — which is
 * why the retired CSS skin had to guess the token from an empty data attribute.
 *
 * Two halves of one contract make that insertion work:
 * - A registered trigger source ({@link REFERENCE_SOURCE}) owning the chip's
 *   codec. Submit serializes every chip occurrence through its source's codec
 *   and rejects an unknown or codec-less source outright, so registration is
 *   what keeps sending alive; both projections answer the literal
 *   {@link SKILL_TOKEN}, which is exactly the gesture the host's pre-step
 *   boundary consumes to inject the skill body.
 * - The scoped `slash/input-insert-reference` event, dispatched on the
 *   session-scoped context carried by the live ui-session binding.
 *
 * The source advertises no `/` candidates (the `/` menu belongs to the kernel
 * skill source), no match hooks, and a constant one-name lexicon: the pipeline
 * treats the token as a reference name wherever it is typed, and nothing here
 * claims Enter or Space.
 *
 * @module @dsh-app/plugin-doc/client/skill-reference
 */

/** The skill this plugin installs; mirrors `SKILL_NAME` in src/skill.ts. */
export const SKILL_NAME = 'dsh-word'

/** The literal gesture the host pre-step boundary recognizes. */
export const SKILL_TOKEN = `/${SKILL_NAME}`

/** Trigger-source name; `/` source names are unique ('skill' is the kernel's). */
export const REFERENCE_SOURCE = 'dsh-office-word'

/** Inline label the chip shows in the composer. */
export const CHIP_LABEL = 'Word'

/**
 * Chip glyph kind. The kernel knows session/file/folder only — there is no
 * skill kind — and a skill is a session-scoped capability rather than a
 * filesystem object, so 'session' is the closest of the three.
 */
export const CHIP_APPEARANCE = 'session' as const

/** One structured reference insertion (the kernel's `ReferenceInsert`). */
export interface ReferenceInsertLike {
  readonly source: string
  readonly ref: string
  readonly label: string
  readonly appearance?: 'session' | 'file' | 'folder'
  readonly clipboardText: string
}

/** One pick-time draft span guarded by the editor revision (`TokenSpan`). */
export interface TokenSpanLike {
  readonly start: number
  readonly end: number
  readonly draftRev: number
}

/** The session-scoped context verb the insertion rides (`Context.bail`). */
export interface ReferenceDispatchContext {
  /**
   * @param thisArg - the dispatch subject; the scoped listeners ride this context.
   * @param event - the insert-reference scoped event.
   * @param request - the reference and its revision-guarded span.
   * @returns `true` when the input applied the edit.
   */
  bail(
    thisArg: ReferenceDispatchContext,
    event: 'slash/input-insert-reference',
    request: { readonly reference: ReferenceInsertLike, readonly span: TokenSpanLike },
  ): unknown
}

/** Insert one chip at the guarded span; `false` = the shell refused (phase/CAS). */
export type ReferenceDispatch = (span: TokenSpanLike) => boolean

/**
 * The chip payload this plugin inserts. `ref` is the skill name so the codec
 * serializes without a second lookup, and `clipboardText` is the literal token
 * so native copy and the draft mirror stay text-compatible.
 */
export function referenceChip(): ReferenceInsertLike {
  return {
    source: REFERENCE_SOURCE,
    ref: SKILL_NAME,
    label: CHIP_LABEL,
    appearance: CHIP_APPEARANCE,
    clipboardText: SKILL_TOKEN,
  }
}

/** The trigger source this plugin registers (structural `InputTriggerSource`). */
export interface SkillReferenceSourceLike {
  readonly trigger: '/'
  readonly name: string
  readonly order: number
  readonly showGroupTitle: boolean
  /** No `/` candidates: the kernel skill source owns that menu. */
  candidates(): Promise<readonly unknown[]>
  /** The token the kernel should treat as a reference name. */
  lexicon(): readonly string[]
  onPick(): { readonly insert: ReferenceInsertLike }
  readonly codec: {
    clipboardText(ref: string): string
    serialize(ref: string): Promise<string>
  }
}

/** The registration verb of the kernel's root trigger service (`ctx.inputTriggers`). */
export interface ReferenceSourceRegistry {
  registerSource(source: SkillReferenceSourceLike): () => void
}

/**
 * Build this plugin's trigger source: an empty candidate list (a ready empty
 * group draws nothing and closes), a constant lexicon, and a codec that
 * answers both projections as the literal gesture.
 */
export function createSkillReferenceSource(): SkillReferenceSourceLike {
  return {
    trigger: '/',
    name: REFERENCE_SOURCE,
    // Behind the kernel skill source (order 2); registration order is not
    // load-bearing with an empty candidate list.
    order: 50,
    showGroupTitle: false,
    async candidates() { return [] },
    lexicon() { return [SKILL_NAME] },
    onPick() { return { insert: referenceChip() } },
    codec: {
      clipboardText: () => SKILL_TOKEN,
      serialize: async () => SKILL_TOKEN,
    },
  }
}

/**
 * Read the session-scoped dispatch face off one live ui-session binding.
 * The binding materialized for an open session carries the session-scoped
 * context (`ScopedStandardSourceBinding.ctx`), and the insert-reference
 * listener rides that same context. The absent hero binding carries none,
 * which is exactly the "no pipeline yet" case.
 *
 * @param binding - the current ui-session binding, read structurally.
 * @returns the span-guarded dispatcher, or `undefined` without a pipeline.
 */
export function skillReferenceDispatcher(binding: unknown): ReferenceDispatch | undefined {
  const ctx = (binding as { readonly ctx?: unknown } | undefined)?.ctx
  if (typeof ctx !== 'object' || ctx === null) return undefined
  if (typeof (ctx as { bail?: unknown }).bail !== 'function') return undefined
  const actx = ctx as ReferenceDispatchContext
  return (span) => actx.bail(actx, 'slash/input-insert-reference', { reference: referenceChip(), span }) === true
}
