/**
 * The chain accounting of the most recent search, ANSWERED BY QUERY.
 *
 * The seam's `WebSearchResult` has no room for this — it is a portable shape
 * owned upstream — so the provider records what happened beside it and the
 * settings page's self-test reads it back to say which engine actually answered
 * and whether the result was a cache hit.
 *
 * A plain last-write-wins slot was enough while a tool call carried one query.
 * It is not on this kernel line: `web_search` accepts a LIST of queries and runs
 * them through the seam at once, so several calls to the provider interleave
 * inside one tool call — and the slot then holds whichever call FINISHED last,
 * not the one the reader is looking at. The self-test (clear → search → read)
 * would be handed another query's engine and cache verdict while naming its own
 * result.
 *
 * Keying the record by the query removes that: a concurrent call for a different
 * query can no longer be mistaken for ours, and a concurrent call for the SAME
 * query is interchangeable with ours — same engines, same cache key, same answer.
 *
 * @module @dsh-app/plugin-websearch/accounting
 */

/** One search's chain accounting, as the self-test reports it. */
export interface SearchAccounting {
  readonly engine: string
  readonly cached: boolean
  readonly attempts: number
  readonly failed: readonly string[]
}

/** The most recent search's accounting, readable only by the query that asked. */
export class AccountingBox {
  private value: { readonly query: string, readonly accounting: SearchAccounting } | undefined

  /**
   * Record one completed search.
   * @param query - the query that search answered.
   * @param accounting - what its chain did.
   */
  set(query: string, accounting: SearchAccounting): void {
    this.value = { query, accounting }
  }

  /**
   * The accounting for `query`.
   * @param query - the query the caller just ran.
   * @returns its accounting, or undefined when the box holds another query's (a
   *   concurrent call finished after ours) — never a different query's record.
   */
  get(query: string): SearchAccounting | undefined {
    return this.value?.query === query ? this.value.accounting : undefined
  }

  /** Drop whatever is held. Used before the self-test's own search runs. */
  clear(): void {
    this.value = undefined
  }
}
