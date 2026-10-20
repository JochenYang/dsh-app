/**
 * The Office group in the composer's `/` menu.
 *
 * The suite's format capsules under the composer card are a MODE switch: they
 * turn PPT or PDF on for the session. This module is the other entry point —
 * a one-shot request. Typing `/` offers four rows (documents, PDF,
 * presentations, spreadsheets) that each drop a skill reference into the draft,
 * so a request can name its format before the user has written a word.
 *
 * Two decisions shape the data table:
 *
 * - A candidate's `name` IS the skill name. The menu renders `label` and, when
 *   it differs from `name`, shows `name` beside it as a dimmed alias that is
 *   also a search key. A friendly English command (`documents`) would therefore
 *   teach a spelling that resolves to nothing: this source claims no
 *   `matchEnter`, so a typed `/documents` stays ordinary prose, while the
 *   skill name the alias shows IS the gesture the host's pre-step boundary
 *   consumes. The alias and the working gesture are then the same string.
 * - Descriptions state what THIS product does, not what a generic Office
 *   toolchain does. `dsh-ppt` authors a PPTD project against bundled templates
 *   and exports an editable .pptx; `dsh-pdf` renders a structured project and
 *   converts existing Office files; the two kernel skills create, read and
 *   validate OOXML through the workspace's Python environment.
 *
 * This module is deliberately free of React and of every framework runtime:
 * the plugin's test harness bundles suites with esbuild for node, and a runtime
 * import of `@deepseek-ai/dsh-client-ui-primitives` drags that whole package —
 * react, shiki, katex — into a tree where none of those peers are installed.
 * The two collaborators that need those runtimes therefore arrive as
 * parameters: the translate seat, the icon factory, and the candidate ranker
 * (`client.ts` passes the kernel's own `rankByName`, so this group sorts by the
 * same rule as every other group).
 *
 * No `lexicon` is declared. The kernel's own skill source already rolls every
 * installed skill name, these four included, so declaring them again would only
 * duplicate a decoration the line already owns.
 *
 * @module @dsh-app/plugin-ppt/client/office-menu
 */

import type { ComponentType } from 'react'
import type { PptKey } from './locales.ts'

/** Trigger-source name; `/` source names are unique ('skill' and 'command' are the kernel's). */
export const OFFICE_MENU_SOURCE = 'dsh-office-menu'

/**
 * Menu position: behind the kernel's command source (default order 0) and ahead
 * of its skill source (order 2). That is what puts the group between 指令 and
 * 技能 instead of appending it after every skill the user has installed.
 */
export const OFFICE_MENU_ORDER = 1

/** The four file-type glyphs a menu row can carry. */
export type OfficeMenuIconKind = 'word' | 'pdf' | 'ppt' | 'excel'

/** One row of the group: the skill it invokes, its glyph, and its copy. */
export interface OfficeMenuItem {
  /** The skill this row invokes; also the candidate's `name` and the chip's `ref`. */
  readonly skill: string
  readonly iconKind: OfficeMenuIconKind
  readonly labelKey: PptKey
  readonly descriptionKey: PptKey
}

/**
 * The four rows, in menu order. `skill` values are the names the kernel and
 * this suite actually install — `office-docx` / `office-xlsx` ship with the
 * kernel's office skill bundle, `dsh-pdf` / `dsh-ppt` with this suite — so a
 * rename on either side has to reach this table or the row invokes nothing.
 */
export const OFFICE_MENU_ITEMS: readonly OfficeMenuItem[] = [
  {
    skill: 'office-docx',
    iconKind: 'word',
    labelKey: 'menu.documents.label',
    descriptionKey: 'menu.documents.description',
  },
  {
    skill: 'dsh-pdf',
    iconKind: 'pdf',
    labelKey: 'menu.pdf.label',
    descriptionKey: 'menu.pdf.description',
  },
  {
    skill: 'dsh-ppt',
    iconKind: 'ppt',
    labelKey: 'menu.presentations.label',
    descriptionKey: 'menu.presentations.description',
  },
  {
    skill: 'office-xlsx',
    iconKind: 'excel',
    labelKey: 'menu.spreadsheets.label',
    descriptionKey: 'menu.spreadsheets.description',
  },
]

/** Resolve a row by the skill name a candidate or chip carries. */
export function officeMenuItem(skill: string): OfficeMenuItem | undefined {
  return OFFICE_MENU_ITEMS.find(item => item.skill === skill)
}

/** One menu candidate (structural `InputTriggerCandidate`). */
export interface OfficeMenuCandidateLike {
  readonly name: string
  readonly label: string
  readonly description: string
  /** Section heading shared by the group's rows; the menu draws it once. */
  readonly section: string
  readonly icon: ComponentType<{ size?: number }>
}

/** One structured reference insertion (the kernel's `ReferenceInsert`). */
export interface OfficeMenuInsertLike {
  readonly source: string
  readonly ref: string
  readonly label: string
  readonly appearance?: 'session' | 'file' | 'folder'
  readonly clipboardText: string
}

/** What one pick asks the composer to do. */
export type OfficeMenuPickOutcome = { readonly insert: OfficeMenuInsertLike } | undefined

/** The trigger source this plugin registers (structural `InputTriggerSource`). */
export interface OfficeMenuSourceLike {
  readonly trigger: '/'
  readonly name: string
  readonly order: number
  readonly showGroupTitle: boolean
  candidates(
    session: { readonly sessionId: string },
    request: { readonly query: string, readonly signal: AbortSignal },
  ): Promise<readonly OfficeMenuCandidateLike[]>
  onPick(pick: { readonly candidate: { readonly name: string } }): OfficeMenuPickOutcome
  readonly codec: {
    clipboardText(ref: string): string
    serialize(ref: string): Promise<string>
  }
}

/** The registration verb of the kernel's root trigger service (`ctx.inputTriggers`). */
export interface OfficeMenuRegistryLike {
  registerSource(source: OfficeMenuSourceLike): () => void
}

/** Collaborators the group needs, all of them from the plugin's own client entry. */
export interface OfficeMenuDeps {
  /** Translate seat bound to this plugin's namespace. */
  readonly t: (key: PptKey) => string
  /** Glyph factory: a stable component per kind, sized by the menu renderer. */
  readonly iconFor: (kind: OfficeMenuIconKind) => ComponentType<{ size?: number }>
  /**
   * Candidate ranker. The kernel's `rankByName` is passed in: reusing it is what
   * keeps this group's fuzzy matching identical to every other group's, and
   * passing it in is what keeps this module out of the primitives runtime.
   */
  readonly rank: <T extends { readonly name: string, readonly label?: string }>(
    items: readonly T[],
    query: string,
  ) => readonly T[]
}

/** The chip payload one row inserts; `ref` is the skill name the codec answers. */
export function officeMenuChip(item: OfficeMenuItem, label: string): OfficeMenuInsertLike {
  return {
    source: OFFICE_MENU_SOURCE,
    ref: item.skill,
    label,
    // A file-type entry, not a mode: the composer chip carries the format's own
    // glyph family. The suite's two mode sources answer 'session' because a
    // mode is session state; a one-shot request names a file format.
    appearance: 'file',
    clipboardText: `/${item.skill}`,
  }
}

/**
 * Build the group's trigger source.
 *
 * The candidate list is built per call from the current locale, so a language
 * switch is reflected on the next menu open without re-registering anything.
 * An empty query returns all four rows; any other query goes through the
 * injected ranker.
 */
export function createOfficeMenuSource(deps: OfficeMenuDeps): OfficeMenuSourceLike {
  const rows = (): readonly OfficeMenuCandidateLike[] => OFFICE_MENU_ITEMS.map(item => ({
    name: item.skill,
    label: deps.t(item.labelKey),
    description: deps.t(item.descriptionKey),
    section: deps.t('menu.group'),
    icon: deps.iconFor(item.iconKind),
  }))

  return {
    trigger: '/',
    name: OFFICE_MENU_SOURCE,
    order: OFFICE_MENU_ORDER,
    // The rows carry their own `section`, and the menu draws a section heading
    // only where it changes — so the group title would print the same word
    // twice above the first row.
    showGroupTitle: false,
    async candidates(_session, { query, signal }) {
      if (signal.aborted) return []
      const items = rows()
      return query.length === 0 ? items : deps.rank(items, query)
    },
    onPick({ candidate }) {
      const item = officeMenuItem(candidate.name)
      if (item === undefined) return undefined
      return { insert: officeMenuChip(item, deps.t(item.labelKey)) }
    },
    codec: {
      // Both projections are the literal skill gesture: the token IS the name
      // the host's pre-step boundary recognizes, so a chip and the same text
      // typed by hand submit identically. No extra sentence is appended — the
      // skill body is injected from the token, and a second instruction would
      // only say it again in the same request.
      clipboardText: (ref: string) => `/${ref}`,
      serialize: async (ref: string) => `/${ref}`,
    },
  }
}
