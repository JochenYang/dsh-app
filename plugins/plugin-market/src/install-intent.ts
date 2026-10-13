/**
 * The one-shot install intent: the binding between the row a user confirmed
 * and the install the host runs.
 *
 * Why it exists. `POST /install` used to take the package name, the exact
 * version, the force flag, the repo key AND the git target straight from the
 * renderer, so "the row the panel showed" and "what the install chain received"
 * were two independent claims with nothing tying them together. An intent
 * closes that gap: the renderer names a catalog ROW (a selector), the host
 * resolves that row inside its OWN catalog snapshot, and mints an opaque token
 * binding the facts — package, declared version, git target, force, repo
 * identity, the source row and the catalog generation it came from, the target
 * profile, an expiry and a nonce. `POST /install` then submits the token alone:
 * a `package`, `version`, `force`, `repoKey` or `gitTarget` in the body is
 * ignored, the install target is the host's own reading of its catalog, and no
 * spec of the renderer's choosing reaches the CLI.
 *
 * What that removes, precisely. Two powers the old body carried are gone:
 * pinning an exact version, and naming a git target. Both now come from the
 * resolved row, so neither can be chosen by the caller. What it does NOT
 * remove: the row can still come from a catalog SOURCE the renderer added via
 * `POST /sources`, because the source list is user-editable by design (that
 * model is out of this module's scope). A renderer can therefore still push a
 * package name down the chain — one step more than before, and it needs a
 * public https host to serve the forged catalog — but never a version pin or a
 * git target of its choosing, and every fact the chain acts on is one this host
 * resolved and bound.
 *
 * One shot. Consuming deletes the entry before anything else runs — before the
 * expiry and profile checks — so a replay (a duplicated request, a re-sent
 * body, a second tab) can never install twice, whether the first attempt
 * succeeded, failed or was refused.
 *
 * The model-facing `market_install_plugin` rides the same lane in process
 * (`installPluginByName` issues and consumes without an HTTP round-trip), so
 * the conversational path cannot skip a check the panel's path applies.
 *
 * Two properties of the lane that the checks above do not give it, and which
 * are enforced here rather than by a caller:
 *
 * - The expiry is measured on a MONOTONIC clock, so a wall clock moved
 *   backwards cannot extend a minted intent's authority (see
 *   {@link IntentClock}).
 * - Issuance is rate-fenced per profile, so a burst of mints cannot evict the
 *   confirmation the user has open (see {@link ISSUE_BUCKET_CAPACITY}).
 *
 * @module @dsh-app/plugin-market/install-intent
 */

import { randomBytes } from 'node:crypto'
import { GIT_TARGET_PATTERN, type CatalogEntry } from './catalog.ts'
import { MarketValidationError } from './errors.ts'
import { repoKeyOf } from './identity.ts'
import { validatePackageName } from './npm.ts'

/**
 * How long a minted intent stays usable, in ms.
 *
 * The interval it must cover is HUMAN: the panel mints the intent when the
 * install confirmation opens and the user consumes it by pressing confirm —
 * reading the dialog, deciding, and possibly being interrupted first. The
 * confirm copy is one short paragraph, so the ordinary interval is a few
 * seconds; fifteen minutes covers the realistic interruption (a message, a
 * call, someone walking away from an open dialog) with a wide margin, while
 * keeping a minted intent's authority short. It is deliberately far shorter
 * than the 6 h catalog cache TTL: past that point the row an intent was
 * resolved from may have been rebuilt, and re-opening the confirmation is one
 * click.
 *
 * The interval is counted on the MONOTONIC clock — see {@link IntentClock}.
 */
export const INSTALL_INTENT_TTL_MS = 15 * 60 * 1000

/**
 * The two clocks one intent lives on.
 *
 * `wall` stamps the intent: `issuedAt`, the `expiresAt` the panel is shown, and
 * the audit trail. `monotonic` is the ONLY clock an expiry is decided on, and
 * the only one the issue-rate fence reads. A wall clock is adjustable — the
 * user, an NTP correction or a timezone-shaped bug can move it backwards — and
 * a deadline computed from it moves with it, so a system clock set back ten
 * minutes would hand a minted intent ten more minutes of authority. The whole
 * point of the TTL is that the authority is SHORT, so the fence reads a clock
 * that cannot be moved from outside the process.
 *
 * Both are injected together (the store takes one {@link IntentClock}), because
 * a test that moves one and not the other is exactly the case worth pinning:
 * with the clocks split, "the wall clock moved, the monotonic one did not" is
 * expressible, and so is the reverse.
 */
export interface IntentClock {
  /** Milliseconds since the Unix epoch: the stamp and the deadline shown to the panel. */
  readonly wall: () => number
  /** Monotonic milliseconds from an arbitrary origin; never moves backwards. */
  readonly monotonic: () => number
}

/**
 * The process's own clocks: `Date.now` for the stamp, `process.hrtime.bigint()`
 * for the fence. `hrtime` is the platform's monotonic clock, so no wall-clock
 * adjustment reaches it. The nanosecond count is divided before it is
 * converted: ms-since-boot fits a double exactly for every uptime that matters,
 * while the raw nanosecond count would lose whole milliseconds after ~104 days.
 */
const processClock: IntentClock = {
  wall: () => Date.now(),
  monotonic: () => Number(process.hrtime.bigint() / 1_000_000n),
}

/**
 * Pending-intent ceiling. Every intent leaves on use or on expiry, so this only
 * ever holds live confirmations; a renderer that minted without confirming
 * would otherwise grow the map without bound. Past the cap the OLDEST pending
 * intent is evicted — a confirmation nobody pressed is the least valuable
 * entry, and eviction fails safe: its consume reports `install.tokenUnknown`.
 */
export const MAX_PENDING_INTENTS = 64

/**
 * Issue-rate fence: a token bucket per profile.
 *
 * WHY IT EXISTS. A pending intent is one slot in the {@link MAX_PENDING_INTENTS}
 * map, and that map's overflow rule drops the OLDEST entry — which is the
 * user's own confirmation whenever they have one open, since it was minted when
 * the dialog opened and the flood came after it. Measured in review: 64 issues
 * arrive in about 10 ms, so anything able to reach the route could evict a live
 * confirmation faster than the person in front of it can press the button. The
 * bucket bounds how fast that map can be filled.
 *
 * CAPACITY 8. One confirmation costs one token, and the panel's own recovery
 * costs a second one when the token died while the dialog stood open, so eight
 * covers several confirmations back to back — a user confirming row by row, or
 * the model-facing tool installing a handful of plugins in one turn. It is also
 * far below the 64-entry ceiling, so a refused flood cannot fill the map, let
 * alone push out the entry at its head.
 *
 * REFILL 1/s. The work behind a confirmation is a kernel CLI run, so a real
 * sequence of installs is paced by seconds and never by this bucket; sustained
 * issuance above one per second is not a person doing anything. Past the burst
 * the fence therefore answers at human speed, while a flood is held to a crawl:
 * evicting 64 entries takes about a minute instead of 10 ms.
 */
export const ISSUE_BUCKET_CAPACITY = 8
export const ISSUE_BUCKET_REFILL_PER_SECOND = 1

/** One profile's bucket: whole tokens, refilled from the monotonic clock. */
interface IssueBucket {
  tokens: number
  /** Monotonic ms of the last refill. */
  at: number
}

/** Random in, opaque out: a token is a capability, never a value to parse. */
function randomToken(): string {
  return randomBytes(32).toString('base64url')
}

/** The profile an install targets: its name, and the absolute directory it resolves to. */
export interface InstallTargetIdentity {
  readonly profile: string
  readonly profileDir: string
}

/**
 * What the renderer may name: a catalog row. `entryId` is the row's own id (the
 * panel's selector); `package` is the npm name, the model-facing tool's
 * selector. Both are LOOKUP KEYS ONLY — neither is used as an install target
 * until it has matched a row of the host's own catalog, and the target comes
 * from that row. An unparsable value matches nothing, which is a refusal, not
 * a fallback.
 */
export interface IntentSelector {
  readonly entryId?: unknown
  readonly package?: unknown
}

/**
 * One build of the host's own catalog: the merged rows it served (or the
 * persisted/bundled equivalent), when that build happened, and how to attribute
 * one row to the directory source that contributed it.
 */
export interface CatalogBuild {
  readonly entries: readonly CatalogEntry[]
  /** Build timestamp (cache write / fetch / snapshot generation); null = unknown. */
  readonly at: number | null
  /** The source URL that contributed `pkg`, or null when the origin is unknowable. */
  readonly sourceOf: (pkg: string) => string | null
}

/**
 * The host's own catalog, held for intent issuance.
 *
 * `remember` is called with the build the host just made (every `/catalog`
 * answer, every `market_search` plugin lookup), so an intent resolves from
 * exactly the rows the user has been looking at. The injected disk reader is
 * the cold-start fallback: a process that has served nothing yet still resolves
 * against the persisted cache, then the bundled offline snapshot — all of it
 * the host's own data, none of it the caller's claim.
 */
export class CatalogHold {
  private build: CatalogBuild | null = null

  constructor(private readonly fromDisk: () => CatalogBuild | null = () => null) {}

  /** Record the catalog the host just built. */
  remember(build: CatalogBuild): void {
    this.build = build
  }

  /** The catalog an intent resolves from: the last build, else the disk fallback. */
  current(): CatalogBuild | null {
    return this.build ?? this.fromDisk()
  }
}

/** The facts one intent binds — everything the install chain will run with. */
export interface InstallIntentFacts {
  /**
   * The row's package field. An npm name on the npm path; on the git path it is
   * the row's display key (a page URL for a git-only row) and never reaches the
   * CLI — it only feeds the same-name fallback lookup the gate already did.
   */
  readonly package: string
  /** The row's source-declared version (display metadata; the chain resolves the real one). */
  readonly version: string | null
  /** `github:owner/repo[#commit]` for a git row; null for an npm row. */
  readonly gitTarget: string | null
  /** The user's confirmed replacement of a same-name install. */
  readonly force: boolean
  /** Normalized repo identity of the row; null when the row proves none. */
  readonly repoKey: string | null
  /** Where the row came from: the directory source, the row id, the catalog build. */
  readonly source: {
    readonly sourceUrl: string | null
    readonly entryId: string
    readonly catalogAt: number | null
  }
}

/** One minted intent: the bound facts plus its identity and validity window. */
export interface InstallIntent extends InstallIntentFacts {
  /** Target profile name as it was at issuance. */
  readonly profile: string
  /** Target profile directory as it was at issuance. */
  readonly profileDir: string
  /** Per-intent random value (audit: distinguishes two intents with equal facts). */
  readonly nonce: string
  /** Wall clock (ms since the epoch) at issuance: audit and display only. */
  readonly issuedAt: number
  /**
   * Wall-clock deadline shown to the panel: `issuedAt` plus the TTL. It is NOT
   * the fence — see {@link IntentClock}: the refusal is decided on the
   * monotonic deadline kept beside this intent, so a wall clock moved backwards
   * cannot extend the intent's authority however far it is moved.
   */
  readonly expiresAt: number
}

/** One pending intent, with the deadline the expiry fence actually reads. */
interface PendingIntent {
  readonly intent: InstallIntent
  /** Monotonic ms past which `consume` refuses — the fence. */
  readonly expiresAtMono: number
}

/** What issuance hands back: the token the renderer holds, and its deadline. */
export interface IssuedIntent {
  readonly token: string
  readonly expiresAt: number
}

/** What a selector named: one row, nothing, or an id the catalog repeats. */
type EntryLookup =
  | { readonly kind: 'row', readonly entry: CatalogEntry }
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous', readonly count: number }

/**
 * The row a selector names. `entryId` is the panel's key (the row's own id, as
 * the catalog payload carried it) and `package` the model-facing tool's key;
 * an id that matches MORE than one row is refused rather than resolved to the
 * first — the id is source-declared and two rows of a merged payload may carry
 * the same one, and installing "whichever row came first" is exactly the gap
 * between the row a user confirmed and the fact an install acts on.
 */
function lookupEntry(entries: readonly CatalogEntry[], selector: IntentSelector): EntryLookup {
  const entryId = typeof selector.entryId === 'string' ? selector.entryId.trim() : ''
  if (entryId !== '') {
    const matches = entries.filter(entry => entry.id === entryId)
    if (matches.length === 0) return { kind: 'none' }
    if (matches.length > 1) return { kind: 'ambiguous', count: matches.length }
    return { kind: 'row', entry: matches[0]! }
  }
  const raw = typeof selector.package === 'string' ? selector.package : ''
  if (raw.trim() === '') return { kind: 'none' }
  // An npm name is the model-facing tool's only handle, so it is validated AS a
  // name before it is used as a key: a malformed string reads as malformed
  // input, never as a row that is missing. The package is the payload's merge
  // key, so it names one row; the grammar admits no uppercase, so no folding.
  const name = validatePackageName(raw)
  const entry = entries.find(row => row.package === name)
  return entry === undefined ? { kind: 'none' } : { kind: 'row', entry }
}

/** The selector's own value, for the refusal that names what could not be found. */
function selectorLabel(selector: IntentSelector): string {
  if (typeof selector.entryId === 'string' && selector.entryId.trim() !== '') return selector.entryId.trim()
  if (typeof selector.package === 'string' && selector.package.trim() !== '') return selector.package.trim()
  return ''
}

/**
 * The one-shot intent lane: issuance (which resolves the row host-side) and
 * consumption (which is the only way an install may learn its target).
 *
 * `currentTarget` is a THUNK, not a captured value: the fence has to compare
 * the profile the user confirmed against the profile the app runs at the moment
 * of the click, and those can differ (a profile switch, a restart, a changed
 * `$DSH_HOME`).
 */
export class InstallIntentStore {
  private readonly pending = new Map<string, PendingIntent>()
  /** One bucket per profile: a flood on one profile cannot spend another's quota. */
  private readonly buckets = new Map<string, IssueBucket>()

  constructor(
    private readonly currentTarget: () => InstallTargetIdentity,
    /**
     * The catalog an intent resolves from. Public so the host's own catalog
     * readers — the `/catalog` route and the model bridge — can feed it the
     * build they just made.
     */
    readonly hold: CatalogHold,
    /** Both clocks, injected together so a test can move either one alone. */
    private readonly clock: IntentClock = processClock,
    private readonly mintToken: () => string = randomToken,
  ) {}

  /**
   * Mint an intent for the row `selector` names.
   *
   * Every fact is read from the resolved row, so the package that will be
   * installed is the host's own reading of its catalog — the caller's claim is
   * only ever a lookup key. Everything that can make the row unusable for the
   * CURRENT profile is refused here, where the user can still see the reason
   * beside the row they clicked.
   *
   * The rate fence runs FIRST, before the row is even resolved: what it bounds
   * is the filling of the pending map, and that map is filled by any mint that
   * gets past the fence — so the fence has to be the first thing a mint passes.
   *
   * @param selector - the row to install (entry id, else npm package name).
   * @param force - the user's confirmed replacement of a same-name install.
   * @returns the token and its deadline.
   * @throws MarketValidationError with a coded reason when the row cannot be
   *   installed, or `install.rateLimited` when this profile has spent its burst.
   */
  issue(selector: IntentSelector, force: boolean): IssuedIntent {
    const target = this.currentTarget()
    const monoNow = this.clock.monotonic()
    this.spendIssueToken(target.profile, monoNow)
    const facts = this.factsOf(selector, force)
    const issuedAt = this.clock.wall()
    const entry: InstallIntent = {
      ...facts,
      profile: target.profile,
      profileDir: target.profileDir,
      nonce: randomBytes(16).toString('hex'),
      issuedAt,
      expiresAt: issuedAt + INSTALL_INTENT_TTL_MS,
    }
    const token = this.mintToken()
    this.pending.set(token, { intent: entry, expiresAtMono: monoNow + INSTALL_INTENT_TTL_MS })
    this.evict(monoNow)
    return { token, expiresAt: entry.expiresAt }
  }

  /**
   * Take one token out of the profile's bucket, refilling it for the time that
   * passed first. The refill is computed on demand rather than by a timer, so
   * the elapsed monotonic time is the only input it needs.
   * @throws MarketValidationError `install.rateLimited` when the bucket is empty.
   */
  private spendIssueToken(profile: string, monoNow: number): void {
    const bucket = this.buckets.get(profile) ?? { tokens: ISSUE_BUCKET_CAPACITY, at: monoNow }
    const elapsed = monoNow - bucket.at
    if (elapsed > 0) {
      bucket.tokens = Math.min(
        ISSUE_BUCKET_CAPACITY,
        bucket.tokens + (elapsed / 1000) * ISSUE_BUCKET_REFILL_PER_SECOND,
      )
      bucket.at = monoNow
    }
    this.buckets.set(profile, bucket)
    if (bucket.tokens < 1) {
      const seconds = Math.max(1, Math.ceil((1 - bucket.tokens) / ISSUE_BUCKET_REFILL_PER_SECOND))
      throw new MarketValidationError({
        code: 'install.rateLimited',
        params: { seconds },
        text: `install confirmations are being issued too fast; try again in ${String(seconds)} second(s)`,
      })
    }
    bucket.tokens -= 1
  }

  /**
   * Take the facts one minted intent bound. One use ONLY: the entry is deleted
   * before the first check that can fail, so a refusal, a failed install and a
   * replay all leave the token dead.
   *
   * @param token - the value the caller submitted (any shape).
   * @returns the bound intent.
   * @throws MarketValidationError when the token is malformed, unknown/used, expired, or was minted for another profile.
   */
  consume(token: unknown): InstallIntent {
    const value = typeof token === 'string' ? token.trim() : ''
    if (value === '') {
      throw new MarketValidationError({
        code: 'install.tokenInvalid',
        text: 'the install request must carry the token the market issued',
      })
    }
    const entry = this.pending.get(value)
    if (entry === undefined) {
      throw new MarketValidationError({
        code: 'install.tokenUnknown',
        text: 'this install confirmation is no longer valid (it was already used, or the market restarted); reopen the confirmation and try again',
      })
    }
    this.pending.delete(value)
    // The monotonic deadline, not `intent.expiresAt`: the wall clock the panel
    // is shown may have been moved, and this is the check that must not move.
    if (this.clock.monotonic() >= entry.expiresAtMono) {
      throw new MarketValidationError({
        code: 'install.tokenExpired',
        params: { minutes: Math.round(INSTALL_INTENT_TTL_MS / 60_000) },
        text: `this install confirmation expired (${String(Math.round(INSTALL_INTENT_TTL_MS / 60_000))} minutes); reopen the confirmation and try again`,
      })
    }
    const intent = entry.intent
    const target = this.currentTarget()
    if (target.profile !== intent.profile) {
      throw new MarketValidationError({
        code: 'install.tokenProfileMismatch',
        params: { issued: intent.profile, current: target.profile },
        text: `this install confirmation was issued for profile "${intent.profile}" but the app now runs profile "${target.profile}"; reopen the confirmation`,
      })
    }
    if (target.profileDir !== intent.profileDir) {
      throw new MarketValidationError({
        code: 'install.tokenHomeChanged',
        text: 'the app data directory changed after this install confirmation was issued; reopen the confirmation',
      })
    }
    return intent
  }

  /**
   * Drop what has expired; past the cap, drop the oldest pending intent. The
   * deadline it reads is the monotonic one, the same the fence uses, so a
   * moved wall clock cannot keep a dead entry resident either.
   */
  private evict(monoNow: number): void {
    for (const [token, entry] of this.pending) {
      if (monoNow >= entry.expiresAtMono) this.pending.delete(token)
    }
    while (this.pending.size > MAX_PENDING_INTENTS) {
      const oldest = this.pending.keys().next()
      if (oldest.done === true) return
      this.pending.delete(oldest.value)
    }
  }

  /**
   * Resolve a selector to the facts an install will bound. The row comes from
   * the host's own catalog; a row that is missing, uninstallable, or carries an
   * install target this host cannot prove is refused with a coded reason.
   */
  private factsOf(selector: IntentSelector, force: boolean): InstallIntentFacts {
    const build = this.hold.current()
    if (build === null) {
      throw new MarketValidationError({
        code: 'install.catalogUnavailable',
        text: 'the market has no catalog to resolve an install against yet; open the market once and try again',
      })
    }
    const found = lookupEntry(build.entries, selector)
    if (found.kind === 'ambiguous') {
      throw new MarketValidationError({
        code: 'install.entryAmbiguous',
        params: { id: selectorLabel(selector), count: found.count },
        text: `the catalog carries ${String(found.count)} rows with the id "${selectorLabel(selector)}"; which one to install is ambiguous`,
      })
    }
    if (found.kind === 'none') {
      throw new MarketValidationError({
        code: 'install.entryUnknown',
        params: { id: selectorLabel(selector) },
        text: `the catalog carries no row for "${selectorLabel(selector)}"; reload the catalog and try again`,
      })
    }
    const entry = found.entry
    if (entry.installable === false) {
      throw new MarketValidationError({
        code: 'install.notInstallable',
        params: { package: entry.package },
        text: `the catalog row "${entry.package}" has no install target`,
      })
    }
    const source = { sourceUrl: build.sourceOf(entry.package), entryId: entry.id, catalogAt: build.at }
    const repoKey = entry.repoKey ?? repoKeyOf(entry.homepage)
    const version = entry.version ?? null
    if (entry.gitTarget !== undefined) {
      // A git row's identity IS its repository: the same-repo guard compares
      // repo keys, so a row that proves none cannot be installed under this
      // gate at all (the panel's own git path refused it the same way).
      if (!GIT_TARGET_PATTERN.test(entry.gitTarget) || repoKey === null) {
        throw new MarketValidationError({
          code: 'install.gitTargetInvalid',
          text: 'a git install target must read github:owner/repo (optionally #commit) and name a repository the host can identify',
        })
      }
      return { package: entry.package, version, gitTarget: entry.gitTarget, force, repoKey, source }
    }
    return {
      package: validatePackageName(entry.package),
      version,
      gitTarget: null,
      force,
      repoKey,
      source,
    }
  }
}
