/**
 * What stepping the kernel line BACKWARDS costs the session logs on disk.
 *
 * The harness keeps two promises that meet here. A format migration only ever
 * publishes a version-named successor — "never move, overwrite, or delete
 * committed generations" — and it makes no promise in the other direction:
 * "predecessors imply neither fallback nor downgrade support" (deepseek-harness,
 * AGENTS.md). 0.1.7 is the first line whose writer is format V4, so an older
 * kernel meeting one of its logs neither lists it nor opens it: the session
 * listing SKIPS such an entry in silence (only an explicit open reports the
 * version), which means a rolled-back install shows a session list with those
 * sessions simply absent.
 *
 * Nothing is lost — the bytes are on disk and a return to the newer line brings
 * them back — but "absent from the list" is exactly what data loss looks like
 * from the outside, and a user who believes their data is gone is a user who may
 * delete what is still recoverable. So the rollback path asks this module one
 * question before it moves: are there any logs on the newer format?
 *
 * Read-only by construction: the walk never opens a log, never parses one, and
 * never writes. The answer only chooses a sentence.
 *
 * @module session-logs
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * A committed generation of the V4 log, by file name.
 *
 * The persistence backend names generations `<base>[.vN].<ext>` — the version is
 * in the file name, which is what makes this answerable with a directory walk
 * instead of a log read. `session.jsonl[.zstd]` with no suffix is the oldest
 * committed generation (format v0/v1), and every later one carries its number.
 *
 * The accepted forms are listed rather than approximated: `session.v4.jsonl` and
 * `session.v4.jsonl.zstd` are the generations this line writes, while a copy
 * someone made beside them (`…jsonl.bak`, `…zstd.tmp`) is not one — counting it
 * would put a number in the rollback notice that no session accounts for. A
 * future extension belongs in this pattern.
 */
const V4_LOG_FILE = /^session\.v4\.jsonl(?:\.zstd)?$/u

/** How deep the sessions tree nests: `<root>/<project>/<session-id>/<log>`. */
const TREE_DEPTH = 3

/**
 * How many session logs under `root` were written at format V4.
 *
 * Best effort by design, and deliberately so: the caller uses the number to pick
 * which sentence a notice shows, never to decide whether an action is safe. A
 * missing, empty or unreadable tree therefore answers 0 — the same answer as a
 * tree with no V4 log in it — rather than failing a recovery path that has a
 * server to bring back up.
 *
 * @param root - the sessions root (`<DSH_HOME>/sessions`).
 * @returns the number of V4 generation files found, capped at {@link CAP} to
 *   keep a pathological tree from turning a notice into a walk of its own.
 */
export async function countV4SessionLogs(root: string): Promise<number> {
  let found = 0
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (found >= CAP) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found >= CAP) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < TREE_DEPTH) await walk(full, depth + 1)
        continue
      }
      if (entry.isFile() && V4_LOG_FILE.test(entry.name)) found += 1
    }
  }
  await walk(root, 1)
  return found
}

/**
 * Ceiling on the count. A number that large already says "the list will look
 * empty"; counting further only delays the notice it is collected for.
 */
const CAP = 1000
