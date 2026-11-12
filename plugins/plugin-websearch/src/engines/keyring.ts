/**
 * The per-engine key ring: which of the user's keys to try, in what order, and
 * what a rejection means for the next attempt.
 *
 * Why this lives beside the engines rather than in `chain.ts`: the chain's unit
 * is one ENGINE ATTEMPT, and that is exactly the unit a key swap must stay
 * inside of. A user who configured three keys for Exa still sees one engine
 * attempt with one latency; the fact that the first two answered 402 is a
 * property of the key, not of the engine.
 *
 * What a key swap does and does not buy: every provider in the roster meters
 * per ACCOUNT, so keys created in one account share one quota, and swapping
 * between them changes nothing. Keys from different accounts (a team's free
 * tiers) genuinely add up. The settings copy says so; this comment is why the
 * mechanism is worth having anyway.
 *
 * State is process-scoped and deliberately NOT persisted. Quotas reset on the
 * provider's own schedule (daily for AnySearch, monthly for Exa and Parallel),
 * so a persisted cooldown would be a guess that outlives its evidence; a
 * restart re-trying every key costs one request and is always safe.
 *
 * @module @dsh-app/plugin-websearch/engines/keyring
 */

import { HttpError, isAbort, type Engine, type EngineRequest } from './types.ts'
import type { WebSearchSource } from '@deepseek-ai/dsh-web'

/**
 * How long a rejected key stays out of rotation.
 *
 * Short on purpose: the point is to stop a spent key from being retried on
 * every search of a turn, not to model the provider's reset clock. Five
 * minutes means a user who tops up their account sees the key come back
 * without restarting the kernel.
 */
export const KEY_COOLDOWN_MS = 5 * 60_000

/** The statuses that mean "this key is spent or wrong", not "the engine broke". */
const KEY_REJECTION_STATUSES: readonly number[] = [401, 402, 429]

/**
 * Whether an engine failure is the key's fault.
 *
 * Deliberately narrow. A 403 is left out: it is as likely to be a WAF as a
 * quota, and rotating a key list into a blocking endpoint spends the rest of
 * the list on the same refusal. A 5xx, a timeout or a parse fault is never a
 * key problem, and rotating on those would turn one failure into N.
 */
export function isKeyRejection(error: unknown): boolean {
  return error instanceof HttpError && KEY_REJECTION_STATUSES.includes(error.status)
}

/** One configured key and the moment it becomes usable again (0 = now). */
interface KeyState {
  readonly key: string
  coolingUntil: number
}

/** The key ring of one engine. */
export class Keyring {
  private states: KeyState[] = []

  /**
   * @param engineId - for diagnostics and the module registry.
   * @param keys - the resolved keys, in try order.
   * @param now - clock, injectable so the cooldown can be tested without waiting.
   */
  constructor(
    readonly engineId: string,
    keys: readonly string[],
    private readonly now: () => number = Date.now,
  ) {
    this.setKeys(keys)
  }

  /**
   * Adopt a new key list after a config save.
   *
   * A key that is still configured keeps its cooldown: re-saving an unrelated
   * field must not hand a spent key back to the next search. A removed key
   * simply disappears, and a re-added one starts clean.
   */
  setKeys(keys: readonly string[]): void {
    const previous = new Map(this.states.map(state => [state.key, state.coolingUntil]))
    this.states = keys.map(key => ({ key, coolingUntil: previous.get(key) ?? 0 }))
  }

  /** Keys believed to have quota, in configuration order. */
  available(): string[] {
    const now = this.now()
    return this.states.filter(state => state.coolingUntil <= now).map(state => state.key)
  }

  /** How many keys are configured at all. */
  size(): number {
    return this.states.length
  }

  /** The keys that are currently cooling off. */
  coolingKeys(): string[] {
    const now = this.now()
    return this.states.filter(state => state.coolingUntil > now).map(state => state.key)
  }

  /** How many are currently cooling off after a rejection. */
  coolingCount(): number {
    return this.coolingKeys().length
  }

  /** The configured position of one key, or undefined when it is not configured. */
  indexOf(key: string): number | undefined {
    const index = this.states.findIndex(state => state.key === key)
    return index === -1 ? undefined : index
  }

  /** Take one key out of rotation for {@link KEY_COOLDOWN_MS}. */
  markExhausted(key: string): void {
    const state = this.states.find(item => item.key === key)
    if (state !== undefined) state.coolingUntil = this.now() + KEY_COOLDOWN_MS
  }
}

/**
 * The process-wide rings, one per engine id.
 *
 * Module scope because the alternative is threading state through the provider,
 * the chain and the probe route for something the user never configures
 * directly. The registry is the single owner of "which keys are hot", so the
 * chain and the settings badge cannot disagree about it.
 */
const rings = new Map<string, Keyring>()

/**
 * The ring for one engine, updated to the current key list.
 *
 * @param engineId - the engine the keys belong to.
 * @param keys - the resolved keys, in try order.
 * @returns the engine's ring (created on first use).
 */
export function keyringFor(engineId: string, keys: readonly string[]): Keyring {
  const existing = rings.get(engineId)
  if (existing === undefined) {
    const ring = new Keyring(engineId, keys)
    rings.set(engineId, ring)
    return ring
  }
  existing.setKeys(keys)
  return existing
}

/**
 * How one engine's keys stand right now, for the settings badge.
 *
 * READ-ONLY on purpose: it runs on a GET (the page refreshes whenever it
 * mounts or saves), and creating or re-seeding a ring from a read would let an
 * unrelated refresh reorder the rotation state out from under an in-flight
 * search.
 *
 * @param engineId - the engine the keys belong to.
 * @param keys - the resolved keys as currently configured.
 * @returns the configured count and how many of them are cooling off.
 */
export function keyStatus(engineId: string, keys: readonly string[]): { count: number, cooling: number } {
  const ring = rings.get(engineId)
  if (ring === undefined) return { count: keys.length, cooling: 0 }
  const cooling = new Set(ring.coolingKeys())
  return { count: keys.length, cooling: keys.filter(key => cooling.has(key)).length }
}

/** Drop every ring. Test seam: production never needs it (restart = new map). */
export function resetKeyrings(): void {
  rings.clear()
}

/** What one keyed engine attempt produced. */
export interface KeyedOutcome<T> {
  readonly value: T
  /** Position of the key that answered; absent means the anonymous call did. */
  readonly keyIndex?: number
}

/** One attempt's error message, contained. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run one engine attempt across the key list.
 *
 * Order of attempts: every usable key in configuration order, then — always —
 * ONE anonymous call. That last step is what makes a key list degrade instead
 * of fail: all three keyed engines in the roster answer anonymously at a lower
 * ceiling.
 *
 * Two different questions, two different answers, deliberately:
 * - "should the next KEY be tried?" — only for 401/402/429
 *   ({@link isKeyRejection}). Rotating on a 500 or a timeout would multiply one
 *   failure into N requests against the same broken endpoint.
 * - "should the anonymous tier be tried?" — yes, for ANY failure that is not a
 *   caller cancellation. This is the answer that was wrong in the first cut: a
 *   key rejected with a status outside the list (a provider phrasing an invalid
 *   key as 400, an AnySearch business code in a 200 body) removed a working
 *   anonymous path, which is exactly the regression a key must never cause.
 *
 * @param ring - the engine's ring.
 * @param run - one call, given the key to use (undefined = anonymous).
 * @returns the value plus which key produced it.
 */
export async function runWithKeys<T>(
  ring: Keyring,
  run: (apiKey: string | undefined) => Promise<T>,
): Promise<KeyedOutcome<T>> {
  const rejected: unknown[] = []
  // Both the key and its CONFIGURED position are snapshotted before the first
  // await: `ring` is the module-level registry entry, and a config save during
  // a request replaces its state wholesale, so a post-hoc lookup could name the
  // wrong key — or claim the anonymous call answered when a key did.
  const candidates = ring.available().map(key => ({ key, index: ring.indexOf(key) }))
  for (const [position, candidate] of candidates.entries()) {
    try {
      const value = await run(candidate.key)
      return { value, keyIndex: candidate.index ?? position }
    } catch (error) {
      if (isAbort(error)) throw error
      if (isKeyRejection(error)) {
        ring.markExhausted(candidate.key)
        rejected.push(error)
        continue
      }
      // Not the key's fault, so no rotation — but the anonymous tier may still
      // answer where this key could not (a rejected key format, a per-key
      // restriction). Fall through to it rather than abandoning the engine.
      rejected.push(error)
      break
    }
  }
  try {
    return { value: await run(undefined) }
  } catch (error) {
    if (isAbort(error)) throw error
    if (rejected.length === 0) throw error
    // Both tiers failed. Naming what was tried is the difference between an
    // actionable failure and a bare "HTTP 402" that reads like the keyless
    // case it is no longer.
    throw new Error(
      `${ring.engineId}: ${rejected.length} configured key attempt(s) failed (${messageOf(rejected[0])}); the anonymous call also failed (${messageOf(error)})`,
    )
  }
}

/**
 * Run one engine attempt with the engine's keys.
 *
 * @param engine - the engine to call.
 * @param request - the composed request (key filled in per attempt).
 * @param ring - the engine's key ring.
 * @returns the sources and the index of the key that answered.
 */
export async function runEngineWithKeys(
  engine: Engine,
  request: Omit<EngineRequest, 'apiKey'>,
  ring: Keyring,
): Promise<KeyedOutcome<WebSearchSource[]>> {
  return runWithKeys(
    ring,
    apiKey => engine.run(apiKey === undefined ? request : { ...request, apiKey }),
  )
}
