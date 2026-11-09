/**
 * Query-side alias expansion: the VOCABULARY layer of recall.
 *
 * Why this exists: `textMatchesQuery` (memory-store.ts) answers "does this card
 * contain these words", and it cannot answer "is this the same thing under
 * another name". Measured on this machine's store, a card about the PPT plugin
 * was unreachable by `幻灯片`, a card about PowerShell by `powershell`, a card
 * about the workspace by `工作区` — the memory is there and cannot be found,
 * which is the same as not having it.
 *
 * ## Shape: alternatives per WORD, not variants per SENTENCE
 *
 * The first implementation replaced one member per generated string, which is
 * wrong in a way that only shows up with two aliases at once: `powershell 工作区`
 * produced `pwsh 工作区` and `powershell workspace` but never `pwsh workspace`,
 * so a card written with both other names matched nothing — and no budget
 * increase could help, because the combination was never built.
 *
 * The fix is to stop expressing this as sentences. A query is split into WORD
 * POSITIONS; a position whose word is a group member becomes a SET of
 * alternatives; a card matches when every position has at least one alternative
 * present in it. That is the same predicate as the cartesian product, evaluated
 * without building it.
 *
 * ## What this layer does NOT do
 *
 * Chinese has no word separators, so `工作区域` is ONE position and is not the
 * member `工作区` — it is a different word ("work area", not "workspace"). Only a
 * segmenter could tell those apart, and there is none here, so the rule is:
 * **a member expands only where it is a whole position.** The cost is that a
 * compound such as `幻灯片模板` does not expand (write `幻灯片 模板`); the
 * alternative — substring expansion — was measured to cut words apart
 * (`工作区域` → `workspace域`, `非工作区` → `workspace`) and invent matches that
 * are not there. Fewer expansions beat wrong ones.
 *
 * Members that carry a separator (`hot-reload`, `deepseek harness`) cannot be a
 * single position either, so they get the one piece of text surgery this module
 * still does: a whole-query rewrite, with ASCII word boundaries on both ends, so
 * `shot-reload` is not `hot-reload`. Inside such a member a separator matches
 * any run of `-`/whitespace INCLUDING none, which is how one member covers
 * `hot-reload`, `hot reload` and `hotreload`.
 *
 * ## Three rules this module will not break
 *
 *   1. **Read path only.** `search` plans; `forget` does not call it. A
 *      destructive path that answered synonyms would delete a family of cards
 *      for one word, and the archive is a poor excuse for that.
 *   2. **Bounded.** {@link MAX_ALIAS_VARIANTS} caps the rewrites one query may
 *      produce, shared round-robin across the members it contains.
 *   3. **Additive only.** `search` keeps exact hits ahead of alias hits, so
 *      expansion can only ADD reachable cards.
 *
 * @module @dsh-app/plugin-memory/recall-aliases
 */

/** One group of interchangeable names for the same thing. */
export type AliasGroup = readonly string[]

/** How many rewritten queries one query may produce (the variant budget). */
export const MAX_ALIAS_VARIANTS = 12

/** Members per group. Beyond this the group is a thesaurus, not an alias. */
export const MAX_ALIAS_MEMBERS = 8

/** Characters per member: an alias longer than this is a phrase, not a name. */
export const MAX_ALIAS_MEMBER_CHARS = 30

/** Groups one file may declare. */
export const MAX_ALIAS_GROUPS = 200

/**
 * The built-in table.
 *
 * Small on purpose, and every group is here on evidence: it either names the
 * same thing in two registers (a tool's two spellings, a plugin and the
 * artefact it produces, a Chinese word and its English counterpart) or it is
 * not here at all.
 *
 * Measured on a real 193-card store, and CUT for it. `ws`, `ps1`, `pdf`/`pdfjs`,
 * `ppt`/`pptx`/`slides` and `compact`/`compactification` all started here and
 * were removed: they are abbreviations that also name other things, so the
 * reverse direction widened queries that had no problem (`pptd` started
 * answering with a video card that merely says "翻页式 PPT"; `压缩会话` started
 * answering with a DynamicIsland `compact` capsule and a pnpm `dsh-live-compact`
 * dependency), while the forward direction gained nothing (`pdf` went 1 → 1).
 * A group earns its place by being MEASURED to find the other name, not by
 * sounding related.
 *
 * A user extends this through `<root>/aliases.json` (see
 * {@link parseAliasGroups}); these entries win on a conflict, so a user file
 * adds groups rather than editing these.
 */
export const DEFAULT_ALIAS_GROUPS: readonly AliasGroup[] = [
  // PowerShell is spelled two ways in practice (`powershell` 0 → 4 cards here).
  ['pwsh', 'powershell'],
  // The office plugin and the words a user reaches for when naming its output
  // (`幻灯片` 0 → 1).
  ['pptd', '幻灯片'],
  // The workspace: the concept the harness is scoped by (`workspace` 5 → 12,
  // `工作目录` 0 → 12).
  ['workspace', '工作区', '工作目录'],
  // Hot module replacement (`hotreload` / `hot-reload` / `hmr` 0 → 2 each).
  ['热重载', 'hotreload', 'hot-reload', 'hmr'],
]

// NOT here, each measured on that same store:
//   `ws`      — its own query already returns 28 cards (substring of `pwsh`), and
//               the group added 9 more that were about WebSocket.
//   `ps1`     — grew PowerShell queries to 4 runtime/credential cards.
//   `pdf` / `pdfjs` — 1 → 1 forward, and the reverse invented a card with no PDF.js.
//   `ppt` / `pptx` / `slides` — 4 → 4 forward, while `pptd` started answering with
//               a video card that merely says "翻页式 PPT".
//   `compact` / `compactification` — grew queries to a DynamicIsland `compact`
//               capsule and a pnpm `dsh-live-compact` dependency.
//   `dsh` / `deepseek-harness` — the only group whose REVERSE was catastrophic:
//               `dsh` is the product's own name in 60 cards, so expanding any
//               spelling of the long form into it answered with the whole store
//               (0 → 60). Expansion is symmetric, so a group that must not widen
//               one direction cannot be in a symmetric table.
//
// The lesson is in the last line: a group has to be measured in BOTH directions.
// A user who wants one of those can put it in `<root>/aliases.json` — that is
// their store, their noise — but it will not ship as a default.

/** A query split into what this layer can act on. */
export interface AliasPlan {
  /**
   * One entry per word position, each listing the words that may stand in for
   * it — the word itself first, so an empty alternative set is never a thing.
   * A position with one entry is an ordinary word: nothing to substitute.
   */
  positions: string[][]
  /**
   * Rewritten whole queries, ORIGINAL FIRST, for members that carry a separator
   * and therefore cannot be a single position. Usually just `[query]`.
   */
  variants: string[]
}

/** A word that needs no separator handling: letters + digits only. */
const ASCII_WORD = /^[a-z0-9]+$/u

/** A member this module can rewrite the whole query for: ASCII with separators. */
const SEPARATED_MEMBER = /^[a-z0-9]+(?:[-\s]+[a-z0-9]+)*$/iu

/** Whether a member is one ASCII word (the only shape with a word boundary). */
function isAsciiWord(value: string): boolean {
  return ASCII_WORD.test(value)
}

/** Whether a member carries a separator and is not a CJK word. */
function isSeparated(value: string): boolean {
  return !isAsciiWord(value) && SEPARATED_MEMBER.test(value)
}

/**
 * The words a query contributes to matching: split on everything that is not a
 * letter or a digit, lowercased, and split AGAIN at every ASCII ↔ non-ASCII
 * boundary, because Chinese runs scripts together without a separator —
 * `memory召回` is two words to a reader (and would otherwise stay ONE token, so
 * the pair had to appear adjacent and in that order, the very defect token-AND
 * exists to fix).
 *
 * Lives here because both the matcher and the alias positions need the same
 * answer to "what are the words of this query"; `memory-store.ts` re-exports it
 * for the callers that already import it from there.
 */
export function queryTokens(query: string): string[] {
  const coarse = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(token => token !== '')
  const out: string[] = []
  for (const token of coarse) {
    for (const part of token.split(/(?<=[a-z0-9])(?=[^a-z0-9])|(?<=[^a-z0-9])(?=[a-z0-9])/u)) {
      if (part !== '') out.push(part)
    }
  }
  return out
}

/** Case-insensitive key for a member (matching is case-insensitive). */
function memberKey(value: string): string {
  return value.toLowerCase()
}

/**
 * Members that can be swapped in place at their own position: everything that is
 * one word (an ASCII word or a Chinese one). Separator-carrying members go to
 * the rewrite path instead.
 */
function positionIndex(groups: readonly AliasGroup[]): Map<string, AliasGroup> {
  const index = new Map<string, AliasGroup>()
  for (const group of groups) {
    for (const member of group) {
      if (isSeparated(member)) continue
      const key = memberKey(member)
      if (!index.has(key)) index.set(key, group)
    }
  }
  return index
}

/** The alternatives available at each word position. */
function positionsOf(query: string, groups: readonly AliasGroup[]): string[][] {
  const tokens = queryTokens(query)
  if (tokens.length === 0) return []
  const index = positionIndex(groups)
  return tokens.map((token) => {
    const group = index.get(memberKey(token))
    if (group === undefined) return [token]
    const others = group.filter(member => memberKey(member) !== memberKey(token))
    // The word itself leads, so a card matching only the user's own word is
    // found by the exact pass; these alternatives are what the alias pass adds.
    return [token, ...others]
  })
}

/**
 * A separated member as a boundary-anchored pattern, or `undefined` for anything
 * that is not one (a single ASCII word, a Chinese word).
 *
 * Every separator run in the member becomes `[-\s]*`, which is what makes ONE
 * member cover `hot-reload`, `hot reload` and `hotreload`; the lookarounds are
 * what keep `shot-reload` from being read as `hot-reload`.
 *
 * Exported because the SAME pattern has to judge a CANDIDATE against card text:
 * defending the boundary only on the query side was measured to let
 * `hot-reload` match a card that says `shot reload`.
 */
export function separatedMemberPattern(member: string): RegExp | undefined {
  if (!isSeparated(member)) return undefined
  const parts = member.split(/[-\s]+/u).filter(part => part !== '')
  if (parts.length < 2) return undefined
  const body = parts.map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('[\\s-]*')
  return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, 'iu')
}

/**
 * Key used to dedupe rewritten queries: case-folded, with every separator run
 * (space, hyphen, underscore) folded to one space.
 *
 * The folding is load-bearing, not cosmetic: the patterns above treat `a-b` and
 * `a b` as the same query, so counting them as two variants spent the budget
 * twice and could starve the real alias (measured: `limit = 2` left `a-b` and
 * `a b` and never reached `x`).
 */
function variantKey(text: string): string {
  return text.trim().toLowerCase().replace(/[\s_-]+/gu, ' ')
}

/**
 * Plan one query: its word positions, plus whole-query rewrites for the
 * separator-carrying members it contains.
 *
 * @param query - the user's words, verbatim.
 * @param groups - the alias table in force (defaults to the built-in one).
 * @param limit - rewritten queries, original included.
 */
export function planAliases(
  query: string,
  groups: readonly AliasGroup[] = DEFAULT_ALIAS_GROUPS,
  limit = MAX_ALIAS_VARIANTS,
): AliasPlan {
  const positions = positionsOf(query, groups)
  const variants: string[] = [query]
  const budget = Math.max(1, limit)
  const seen = new Set<string>([variantKey(query)])
  /** Push one rewritten query, unless it is a repeat or the budget is spent. */
  const push = (text: string): boolean => {
    if (variants.length >= budget) return false
    const key = variantKey(text)
    if (seen.has(key)) return false
    seen.add(key)
    variants.push(text)
    return true
  }
  /** Rewrite one hit inside `base`, consuming the MATCHED span.
   *  The span, not `member.length`: a separator run may be longer than the
   *  member's (two spaces where the member has one), and slicing by the member's
   *  length would leave debris inside the query. */
  const rewrite = (base: string, hit: { start: number, length: number }, replacement: string): string =>
    `${base.slice(0, hit.start)}${replacement}${base.slice(hit.start + hit.length)}`

  // PHASE A — one substitute per member, round-robin over the members the query
  // contains, before ANY member gets a second one.
  //
  // This is the fairness the first version lacked: spending the budget on the
  // first member's whole group left the second member untouched, so a query with
  // two separated members could exhaust twelve variants and never produce the
  // one that changed both (measured: two 7-member groups, `x y` missing).
  // Half the budget is held back for phase B so breadth cannot eat the depth —
  // but never less than ONE substitute, or a tiny budget would produce no
  // variant at all (measured: budget 2 did nothing, so the real alias never
  // appeared even though there was room for it).
  const hits = separatedHits(query, groups)
  const breadthCap = Math.min(budget, Math.max(2, Math.floor(budget / 2)))
  for (let round = 0; variants.length < breadthCap; round += 1) {
    // "Progress" means a member still had a substitute to offer, NOT that a
    // variant landed: a round whose only candidate folds onto the original must
    // not end the phase, or the next candidate is never asked (measured: `a-b`
    // offered `a b`, which dedupes to the original, and `x` was never reached).
    let hadCandidate = false
    for (const hit of hits) {
      const replacement = hit.others[round]
      if (replacement === undefined) continue
      hadCandidate = true
      if (variants.length >= breadthCap) break
      push(rewrite(query, hit, replacement))
    }
    if (!hadCandidate) break
  }

  // PHASE B — deepen from what phase A produced, breadth-first, so a variant
  // that changed one member can become one that changed two.
  for (let index = 1; index < variants.length && variants.length < budget; index += 1) {
    const base = variants[index]!
    for (const hit of separatedHits(base, groups)) {
      for (const replacement of hit.others) {
        if (variants.length >= budget) break
        push(rewrite(base, hit, replacement))
      }
    }
  }
  return { positions, variants }
}

/** Every separated member present in `text`, with its span and its group. */
function separatedHits(
  text: string,
  groups: readonly AliasGroup[],
): Array<{ member: string, others: string[], start: number, length: number }> {
  const hits: Array<{ member: string, others: string[], start: number, length: number }> = []
  for (const group of groups) {
    for (const member of group) {
      if (!isSeparated(member)) continue
      const pattern = separatedMemberPattern(member)
      if (pattern === undefined) continue
      const match = pattern.exec(text)
      if (match === null) continue
      const others = group.filter(other => memberKey(other) !== memberKey(member))
      if (others.length === 0) continue
      hits.push({ member, others, start: match.index ?? 0, length: match[0].length })
    }
  }
  // Left to right, so the first variant a reader sees changes the earliest word.
  return hits.sort((a, b) => a.start - b.start || b.length - a.length)
}

/**
 * Validate an alias table read from a user file.
 *
 * Tolerant by construction — the file is hand-edited, and an alias file that is
 * half wrong must not take recall down with it. A rejected group is DROPPED (not
 * repaired), and a member that already belongs to an earlier group is dropped
 * from the later one: one member cannot mean two things, and first-come wins so
 * the built-in table keeps its meaning when a user file overlaps it.
 *
 * @param raw - the parsed JSON (`[["a","b"], …]` or `{ groups: [[…]] }`).
 * @returns the usable groups, plus how many entries were refused.
 */
export function parseAliasGroups(raw: unknown): { groups: AliasGroup[], rejected: number } {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null && Array.isArray((raw as { groups?: unknown }).groups)
      ? (raw as { groups: unknown[] }).groups
      : undefined
  if (list === undefined) return { groups: [], rejected: 1 }
  let rejected = 0
  const taken = new Set<string>()
  const groups: AliasGroup[] = []
  for (const candidate of list) {
    if (groups.length >= MAX_ALIAS_GROUPS) { rejected += 1; continue }
    if (!Array.isArray(candidate)) { rejected += 1; continue }
    const members: string[] = []
    for (const value of candidate) {
      // Checked BEFORE the push: a `> limit` test after it lets a group reach
      // one member past the ceiling.
      if (members.length >= MAX_ALIAS_MEMBERS) break
      if (typeof value !== 'string') continue
      const member = value.trim()
      if (member === '' || member.length > MAX_ALIAS_MEMBER_CHARS) continue
      const key = memberKey(member)
      if (taken.has(key) || members.some(known => memberKey(known) === key)) continue
      members.push(member)
    }
    // A one-member group is not an alias; it is a note to self.
    if (members.length < 2) { rejected += 1; continue }
    for (const member of members) taken.add(memberKey(member))
    groups.push(members)
  }
  return { groups, rejected }
}

/**
 * Concatenate alias tables, first-come winning on a repeated member.
 *
 * @param tables - bases first, overlays last.
 * @returns one table where no member appears twice.
 */
export function mergeAliasGroups(...tables: ReadonlyArray<readonly AliasGroup[]>): AliasGroup[] {
  const taken = new Set<string>()
  const merged: AliasGroup[] = []
  for (const table of tables) {
    for (const group of table) {
      const members = group.filter((member) => {
        const key = memberKey(member)
        if (taken.has(key)) return false
        taken.add(key)
        return true
      })
      if (members.length >= 2) merged.push(members)
    }
  }
  return merged
}
