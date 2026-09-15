/**
 * The persisted store:
 * `$DSH_HOME/storages/dsh-app-plugin-websearch/config.json`.
 *
 * The desktop shell rewrites the loader overlay on every server start, so
 * this file is the single durable source of truth for the user's engine
 * order, keys and provider choice. Reads validate and DEGRADE (fall back to
 * the defaults with a warning) instead of failing the boot — the same
 * discipline as plugin-mcp's store. Writes are atomic (tmp + rename).
 *
 * Secret hygiene: `apiKey` values may be `$ENV:NAME` references (resolved at
 * call time, never persisted resolved); literal values are allowed (the file
 * is local and user-owned) but are never returned to the client — routes mask
 * them.
 *
 * @module @dsh-app/plugin-websearch/store
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { defaultFile, validateFile, WebSearchValidationError, type WebSearchFile } from './wire.ts'

/** Read + parse the file, or undefined when absent/unusable. */
function readRaw(path: string, log: (message: string) => void): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined // missing file: the common first-run case
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('expected a JSON object')
    }
    return parsed
  } catch (error) {
    log(`websearch config: unreadable, falling back to defaults: ${(error as Error).message}`)
    return undefined
  }
}

/**
 * The config store. Reads validate and degrade to the defaults; writes are
 * atomic and full-file (the routes own merge semantics).
 */
export class WebSearchStore {
  readonly filePath: string

  constructor(dir: string, private readonly log: (message: string) => void) {
    this.filePath = `${dir}/config.json`
  }

  /**
   * Read the validated config. A missing or unusable file yields the
   * defaults; an invalid one is logged and degraded rather than thrown, so a
   * hand-edit typo cannot take the search tool down.
   */
  load(): WebSearchFile {
    const raw = readRaw(this.filePath, this.log)
    if (raw === undefined) return defaultFile()
    try {
      return validateFile(raw)
    } catch (error) {
      this.log(`websearch config: invalid, falling back to defaults: ${error instanceof Error ? error.message : String(error)}`)
      return defaultFile()
    }
  }

  /**
   * Persist a full config. Throws {@link WebSearchValidationError} for an
   * invalid body; the file is written atomically so a crash mid-write cannot
   * leave a truncated config behind.
   */
  save(raw: unknown): WebSearchFile {
    const file = validateFile(raw)
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
    renameSync(tmp, this.filePath)
    return file
  }
}
