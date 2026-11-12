/**
 * Resolving an engine's stored key list into the values a request uses.
 *
 * Split out of `index.ts` for one reason: the environment is an input, so it is
 * passed in rather than read — which makes the two rules below testable without
 * a kernel, and keeps the plugin entry point from owning string policy.
 *
 * Neither function is a validator. A key that cannot resolve is dropped here
 * (`resolveKeys`) or counted for the page (`unresolvedKeyCount`), because a
 * stored entry the user can no longer reach must never be able to fail a search
 * or a load.
 *
 * @module @dsh-app/plugin-websearch/keys
 */

import { ENV_REFERENCE, type EngineEntry } from './wire.ts'

/** How the host reads an environment variable name. */
export type EnvLookup = (name: string) => string | undefined

/**
 * Resolve one engine's keys, in configuration order.
 *
 * `$ENV:NAME` reads the environment at call time (so a rotated variable reaches
 * the next search without a restart); a literal is returned as-is; an unset
 * variable drops out. Duplicates collapse, because two equal keys would spend
 * two attempts on one rejection.
 *
 * An empty result is not a failure: every engine that accepts a key also
 * answers anonymously, so this list is an upgrade and not a prerequisite.
 *
 * @param entry - the persisted engine row.
 * @param env - environment lookup (the host passes `process.env`).
 * @returns the keys to try, empty when none resolves.
 */
export function resolveKeys(entry: EngineEntry, env: EnvLookup): string[] {
  const out: string[] = []
  for (const raw of entry.apiKeys ?? []) {
    const match = ENV_REFERENCE.exec(raw)
    const value = match === null ? raw : env(match[1])
    if (value === undefined || value === '' || out.includes(value)) continue
    out.push(value)
  }
  return out
}

/**
 * How many configured entries are `$ENV:NAME` references whose variable is not
 * set.
 *
 * Counted from the REFERENCES, not from `stored − resolved`: that subtraction
 * also counts two references that resolve to the SAME value (collapsed by
 * {@link resolveKeys}) and a variable set to the empty string, and would then
 * tell the user their variable is unset when it is set.
 *
 * @param entry - the persisted engine row.
 * @param env - environment lookup.
 * @returns how many references did not resolve.
 */
export function unresolvedKeyCount(entry: EngineEntry, env: EnvLookup): number {
  let count = 0
  for (const raw of entry.apiKeys ?? []) {
    const match = ENV_REFERENCE.exec(raw)
    // A malformed reference (`$ENV:MY KEY`) is reported as unresolved too: the
    // resolver treats it as a literal, so it would otherwise be sent as a key
    // that can only fail, with nothing on the page saying why.
    if (match === null) {
      if (raw.startsWith('$ENV:')) count += 1
      continue
    }
    const value = env(match[1])
    if (value === undefined || value === '') count += 1
  }
  return count
}
