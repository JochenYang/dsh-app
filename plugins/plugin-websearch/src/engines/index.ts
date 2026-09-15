/**
 * The engine registry: maps one engine id to a constructed {@link Engine}.
 *
 * Construction takes the resolved config (keys, SearXNG instances) because an
 * engine is a closure over its own settings — the chain never passes
 * per-engine config into `run`, so a stale key cannot linger in a shared
 * object between calls.
 *
 * @module @dsh-app/plugin-websearch/engines
 */

import type { EngineId, WebSearchFile } from '../wire.ts'
import { anySearchEngine } from './anysearch.ts'
import { bingEngine } from './bing.ts'
import { exaEngine } from './exa.ts'
import { parallelEngine } from './parallel.ts'
import { searxngEngine } from './searxng.ts'
import type { Engine } from './types.ts'

/** Resolve one engine id into a runnable engine for the current config. */
export function createEngine(id: EngineId, file: WebSearchFile): Engine {
  switch (id) {
    case 'bing':
      return bingEngine()
    case 'anysearch':
      return anySearchEngine()
    case 'searxng':
      return searxngEngine(file.searxngInstances)
    case 'exa':
      return exaEngine()
    case 'parallel':
      return parallelEngine()
    default: {
      // Exhaustiveness guard: adding an id to ENGINE_IDS without a case here
      // is a compile error, not a silent "engine never runs".
      const never: never = id
      throw new Error(`未知引擎：${String(never)}`)
    }
  }
}

export type { Engine, EngineRequest } from './types.ts'
