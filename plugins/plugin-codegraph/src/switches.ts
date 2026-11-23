/**
 * The switches this plugin reads from the environment, in one place.
 *
 * Why environment variables and not a row in the settings page: each one exists
 * to turn OFF a behaviour that is on by default and that a user may want gone on
 * one machine only (a pre-fetch that is not wanted, a note appended to search
 * results). They are read at the moment of use, never cached at mount, so a
 * restart is the whole procedure — and the settings page says so, with each
 * switch's current state next to its name: a switch nobody can find is a switch
 * nobody can turn (see `codegraph.switches.*` in the client's dictionary).
 *
 * The convention is the one `DSH_APP_CODEGRAPH_SOURCE` already had: the variable
 * set to `0` (or `false`) turns the behaviour off; absent, empty or any other
 * value leaves it on. "Off" being the value a user has to type is deliberate —
 * a typo in a variable meant to switch something ON must not change behaviour.
 *
 * @module @dsh-app/plugin-codegraph/switches
 */

/** The names, exported so the settings page and the tests name them once. */
export const SWITCH_ENV = {
  prefetch: 'DSH_APP_CODEGRAPH_PREFETCH',
  grepNote: 'DSH_APP_CODEGRAPH_GREP_NOTE',
  source: 'DSH_APP_CODEGRAPH_SOURCE',
} as const

/** Whether each switch is on right now. */
export interface PluginSwitches {
  /** Attach the starter pack for a request that names indexed files or symbols. */
  readonly prefetch: boolean
  /** Append where a searched identifier is declared, after any search call (a `run_code` sub-dispatch included). */
  readonly grepNote: boolean
  /**
   * Include source in answers: a declaration's lines in `codegraph_context`, the
   * call-site line on each `codegraph_impact` row and the target's declaration.
   */
  readonly source: boolean
}

/** One variable, by the `0` / `false` convention. */
export function switchIsOn(env: Readonly<Record<string, string | undefined>>, name: string): boolean {
  const value = env[name]
  return value !== '0' && value !== 'false'
}

/** Read every switch from `env` (the live environment by default). */
export function readSwitches(env: Readonly<Record<string, string | undefined>> = process.env): PluginSwitches {
  return {
    prefetch: switchIsOn(env, SWITCH_ENV.prefetch),
    grepNote: switchIsOn(env, SWITCH_ENV.grepNote),
    source: switchIsOn(env, SWITCH_ENV.source),
  }
}

/**
 * The switches whose behaviour is wired up, and therefore shown on the settings
 * page. A switch that gates nothing must not be listed: "on" beside a feature
 * that does not exist is a lie the page would tell every time it renders.
 */
export const WIRED_SWITCHES: readonly (keyof PluginSwitches)[] = ['prefetch', 'grepNote', 'source']
