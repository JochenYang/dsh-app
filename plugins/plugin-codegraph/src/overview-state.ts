/**
 * Which overview text THIS assembly should hand out, decided across assemblies.
 *
 * `prompt.ts` renders one block from one graph read; it cannot see the previous
 * assembly, and the kernel's runtime-context snapshot is append-only — a changed
 * text is a NEW user message and every earlier copy stays in context. So a block
 * that is honest about a half-finished pass, or that changes twice in a minute
 * because the graph did, is re-sent whole each time, and the model re-reads all of
 * it. Measured on 234 real sessions: 35 re-pushed the overview 354 times, for
 * roughly 51 million tokens re-read. Rendering stability (`magnitude`'s rungs,
 * hubs by rung, no line numbers) removes most of the causes; this module decides
 * what to do about the rest, in three rules:
 *
 *   - **A failure is passed through, and touches nothing.** A failed pass is
 *     terminal until a human retries; a model that is shown the previous shape
 *     while the graph is broken edits against a graph the plugin itself says not
 *     to trust. The failure sentence is the one text that must always win, so it
 *     is the one input that bypasses every rule here.
 *   - **A status is replaced by the last complete block, once there is one.** A
 *     re-index flips the block to one "being built" sentence and back; measured,
 *     32 of the 274 re-pushed diffs were exactly that flip. During a rebuild the
 *     previous shape is still the best description of the project — the tools
 *     report `indexing` on their own — so the block keeps saying it instead of
 *     turning into a status and back. The FIRST index has no previous block and
 *     still gets the status sentence, which is the window it was written for.
 *   - **A changed full block is adopted at most once per interval, per session.**
 *     Two real changes inside five minutes are usually one edit's noise (a file
 *     entering the entry list, then leaving again). The session keeps reading the
 *     text it was shown until the interval has passed, then takes the newest
 *     candidate at the next assembly — so a change is delayed, never dropped.
 *
 * Per SESSION, keyed by the session object: two sessions on one project are
 * two conversations, and one's interval must not decide the other's text. The
 * last complete block is per PROJECT, because a status has no session of its own
 * to borrow from and the shape it replaces belongs to the project.
 *
 * Pure and synchronous: the clock is injected so the interval is testable, and
 * nothing here reads a graph, a queue or a Context.
 *
 * @module @dsh-app/plugin-codegraph/overview-state
 */

/** What kind of text an assembly has produced, which decides which rule applies. */
export type OverviewCandidateKind = 'full' | 'status' | 'failure'

/** How long a session keeps the text it was shown before taking a new one. */
const DEFAULT_MIN_INTERVAL_MS = 5 * 60 * 1000

/** What one session has been shown, and when that last changed. */
interface SessionState {
  /** The text the session last received, or undefined before its first full block. */
  shown: string | undefined
  /**
   * When `shown` last became a DIFFERENT text, in the injected clock's milliseconds.
   *
   * Undefined until that first change: the interval runs between two changes, not
   * from the first block, so the first change a session sees is always adopted.
   */
  changedAt: number | undefined
}

/** What one project remembers, across its sessions. */
interface ProjectState {
  /** The most recent complete block, whatever session produced it. */
  lastFull: string | undefined
  /** How many times the full block changed after the first one. */
  changes: number
  /** Per-session text and timing; a session that goes away takes its entry with it. */
  readonly sessions: WeakMap<object, SessionState>
  /** The entry for assemblies that carry no session object. */
  readonly anonymous: SessionState
}

/** The constructor options. Both are optional; the defaults are the production values. */
export interface OverviewStabilizerOptions {
  /** The clock, in milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number
  /** The minimum time between two adopted changes in one session. Defaults to five minutes. */
  readonly minIntervalMs?: number
}

/**
 * Decide, per assembly, which overview text reaches the model.
 *
 * One instance per process. `resolve` is called with the text `prompt.ts` produced
 * and returns the text to hand out; the caller never sees the bookkeeping.
 */
export class OverviewStabilizer {
  private readonly now: () => number
  private readonly minIntervalMs: number
  private readonly projects = new Map<string, ProjectState>()

  constructor(options: OverviewStabilizerOptions = {}) {
    this.now = options.now ?? Date.now
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
  }

  /** The project's record, created on first sight. */
  private project(cwd: string): ProjectState {
    let state = this.projects.get(cwd)
    if (state === undefined) {
      state = { lastFull: undefined, changes: 0, sessions: new WeakMap(), anonymous: { shown: undefined, changedAt: undefined } }
      this.projects.set(cwd, state)
    }
    return state
  }

  /** One session's record within a project; `undefined` session means the shared anonymous one. */
  private session(state: ProjectState, session: object | undefined): SessionState {
    if (session === undefined) return state.anonymous
    let entry = state.sessions.get(session)
    if (entry === undefined) {
      entry = { shown: undefined, changedAt: undefined }
      state.sessions.set(session, entry)
    }
    return entry
  }

  /**
   * The text this assembly should return.
   *
   * @param cwd - the project, as the session's cwd names it.
   * @param session - the session object the assembly belongs to, when there is one.
   * @param kind - what the candidate is: a complete block, the indexing status, or a failure.
   * @param candidate - the text `prompt.ts` produced for this assembly.
   * @returns the text to hand to the kernel.
   */
  resolve(cwd: string, session: object | undefined, kind: OverviewCandidateKind, candidate: string): string {
    // A failure is terminal and the one text that must be seen. It changes no
    // record: a failure between two complete blocks must not make the next
    // complete block look like a change, nor reset a session's interval.
    if (kind === 'failure') return candidate

    const project = this.project(cwd)

    // A re-index keeps the previous shape in front of the model; the tools say
    // `indexing` on their own. Only a project that has never produced a complete
    // block gets the status sentence, which is the first-index window it was
    // written for. Nothing is recorded: a status is not a shape.
    //
    // The SESSION's text first, the project's only for a session that has none:
    // a session inside its interval is still reading an older block, and handing
    // it the project's newest one here would be followed by the next full
    // assembly taking it back — one flip per re-index, which is what this rule
    // exists to remove.
    if (kind === 'status') return this.session(project, session).shown ?? project.lastFull ?? candidate

    // An empty full block is silence ("no graph yet"), not a shape: passed through
    // and recorded nowhere, so it cannot become the `lastFull` a later status returns.
    if (candidate === '') return candidate

    // The project's latest complete block, whatever session produced it: a status
    // in any session borrows this.
    project.lastFull = candidate

    const entry = this.session(project, session)
    // First block this session has ever been offered: adopt it. NO clock starts
    // here — the interval measures between two CHANGES, and a first block is not
    // one. "Changed twice within a minute" must mean the first change lands and
    // the second waits; a clock started at the first block would hold back the
    // first change too, for five minutes, which is the opposite of the rule.
    if (entry.shown === undefined) {
      entry.shown = candidate
      return candidate
    }
    if (entry.shown === candidate) return entry.shown

    // A real change for this session. Within the interval it waits: the session
    // keeps the text it has, and takes whatever is newest at the first assembly
    // after the interval. Delayed, never dropped — and the candidate adopted then
    // is the CURRENT one, not this one queued. An undefined `changedAt` means this
    // is the session's first change, which is always due.
    const now = this.now()
    if (entry.changedAt !== undefined && now - entry.changedAt < this.minIntervalMs) return entry.shown

    entry.shown = candidate
    entry.changedAt = now
    project.changes += 1
    return candidate
  }

  /**
   * How many times this project's full block changed after its first one.
   *
   * Counts adopted changes across every session of the project — the number a
   * reader of the logs wants when asking "how often did the model re-read this".
   *
   * @param cwd - the project.
   * @returns the count, 0 for a project never seen.
   */
  changes(cwd: string): number {
    return this.projects.get(cwd)?.changes ?? 0
  }
}
