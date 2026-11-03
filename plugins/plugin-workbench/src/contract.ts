/**
 * Facts both halves of the workbench hub must agree on.
 *
 * One member so far, and it earns a module: the Creator prompt (client half)
 * tells the agent which skill to load, and the skill installer (host half) names
 * the directory it writes. The two spellings are the same string, and a client
 * module cannot import the host's `skill.ts` — that module reads and writes the
 * filesystem, so pulling it into the browser bundle would drag `node:fs` into
 * the renderer. A shared pure constant is what keeps the prompt and the install
 * path from drifting apart without a test that can only compare what it was
 * given.
 *
 * The two SEAT names are deliberately not here: a `SlotMap` key must be a literal
 * in the declaration, so a constant could not be used where it matters, and the
 * seats are stated once in `client.ts` and once in the skill body — a second
 * copy in this file would be the third place to keep in step.
 *
 * @module @dsh-app/plugin-workbench/contract
 */

/**
 * The skill that carries the workbench card contract, and the directory it is
 * installed under in `$DSH_HOME/skills/`.
 */
export const WORKBENCH_SKILL_NAME = 'dsh-app-workbench-card'
