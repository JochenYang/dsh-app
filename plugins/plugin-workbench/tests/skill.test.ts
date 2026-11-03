/**
 * The seat-contract skill: what it says, where it lands, and that installing it
 * twice changes nothing.
 *
 * Two properties here cannot be seen from a type check and have each gone wrong
 * in this suite before:
 *
 * - the body is a TEMPLATE LITERAL, so every backtick in it is escaped. A missed
 *   escape does not produce a wrong file — it ends the literal and the module
 *   stops parsing, or worse, silently ships a body with a stray backslash in it.
 *   The assertions below read the PRODUCED text, which is the only place that
 *   difference is visible.
 * - "installed on every mount" must not mean "rewritten on every mount". A
 *   content-compared write is the difference between a boot that touches the
 *   user's skills directory and one that leaves it alone, so both passes are
 *   exercised.
 *
 * TWO DRIFT GUARDS, because the body now CARRIES the contract instead of pointing
 * at it. It used to name a repository path, and a measured Creator session — run
 * in the user's own folder, with the app installed as built output — spent fifty
 * tool calls looking for that source tree, inside a build artefact and two
 * unrelated repositories, before writing anything. So the body reproduces the
 * container's declaration block, and:
 *
 * - `reproduces the container declaration verbatim` compares the two texts after
 *   normalizing line endings, trailing whitespace and common indentation, so a
 *   seat change that skips the skill cannot ship an agent a stale declaration;
 * - `lists every owner prop ... and invents none` reads the member names out of
 *   `page.tsx`'s interface and requires the skill's own list to be exactly that
 *   set — a prop added to the container, or a name it dropped, is red.
 *
 * Both were checked by mutation while they were written: a one-token change in
 * the skill's block, and a renamed prop bullet, each turned exactly its own test
 * red. A third guard asserts the body carries no repository path at all, which is
 * the defect this round fixes.
 *
 * The host entry is applied for real, against a temporary `$DSH_HOME`, because
 * the interesting failure is the wiring, not the function: `apply` is
 * fire-and-forget, so "the skill installs on mount" is exactly the claim that
 * needs an end-to-end observation rather than a unit call.
 *
 * @module plugin-workbench/tests/skill
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import { installSkill, SKILL_MARKDOWN, SKILL_NAME, skillFilePath } from '../src/skill.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const srcDir = join(here, '..', 'src')

/** Homes created by one test, removed afterwards. */
const homes: string[] = []

/**
 * A fresh harness home under the OS temp directory.
 * @returns its absolute path.
 */
async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-app-workbench-skill-'))
  homes.push(home)
  return home
}

afterEach(async () => {
  delete process.env.DSH_HOME
  await Promise.all(homes.splice(0).map(async (home) => { await rm(home, { recursive: true, force: true }) }))
})

/**
 * Wait until `probe` holds, or give up.
 *
 * `apply` starts the install and returns; there is no promise to await, by
 * design (the skill file outlives the fiber). Polling the filesystem is the only
 * honest way to observe it — with a bound, so a regression fails instead of
 * hanging the suite.
 *
 * @param probe - the condition to wait for.
 * @returns whether it held before the deadline.
 */
async function eventually(probe: () => Promise<boolean>): Promise<boolean> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await probe()) return true
    await new Promise((resolve) => { setTimeout(resolve, 25) })
  }
  return probe()
}

/** The smallest host context `apply` uses: one logger. */
function hostContext(): { ctx: Context, warnings: string[] } {
  const warnings: string[] = []
  const ctx = {
    logger: () => ({
      info: () => {},
      warn: (message: string) => { warnings.push(message) },
    }),
  }
  return { ctx: ctx as unknown as Context, warnings }
}

describe('workbench seat-contract skill body', () => {
  /**
   * The shipped body with CRLF folded to LF.
   *
   * `SKILL_MARKDOWN` is a template literal, so its newlines are whatever the
   * checkout has: LF in CI, CRLF on a Windows clone (`core.autocrlf`). Asserting
   * `\n` against the raw string would pass here and fail on the other platform —
   * the assertions below are about the TEXT, so they read the normalized form,
   * and the install tests compare the raw one, which is what actually lands.
   */
  const body = SKILL_MARKDOWN.replace(/\r\n/gu, '\n')

  it('names both seats the agent has to register into', () => {
    assert.ok(body.includes('workbench.item'), 'the card grid seat')
    assert.ok(body.includes('workbench.view'), 'the page seat')
  })

  it('states the id/key rule, which is the one failure with no error message', () => {
    // A card whose `id` and whose page's `key` differ compiles, renders, and then
    // does nothing when pressed: the container reads only `key`.
    assert.match(body, /registers with `id`/u)
    assert.match(body, /registers with `key`/u)
    assert.match(body, /both must be the SAME string/u)
    assert.match(body, /silent|pressing it does nothing/iu)
  })

  it('says what `order` does, what the container owns, and how long a card lives', () => {
    assert.match(body, /`order`/u)
    assert.match(body, /sorts ascending/u)
    assert.match(body, /frame/iu)
    assert.match(body, /this session only/u)
    assert.match(body, /restart/u)
  })

  it('carries real backticks, not the escapes of the template literal it is written in', () => {
    // The body is a template literal; a bare backtick would end it. These read
    // the resolved text, so a doubled or over-escaped sequence fails here rather
    // than shipping as literal backslashes into the skill the model reads.
    assert.ok(body.includes('`workbench.item`'), 'an inline code span around the seat name')
    // Two fenced blocks: the declaration a card pastes, and the two
    // registrations. Four fences, each carrying a language so a renderer gets it
    // right — and an odd count is a broken block.
    assert.deepEqual(body.match(/^```[a-z]+$/gmu), ['```ts', '```js'])
    assert.equal(body.split('```').length, 5, 'two fenced blocks, each opened and closed')
    assert.doesNotMatch(body, /\\`/u)
  })

  /**
   * Text between the two `workbench-card-slot` markers, normalized.
   *
   * The comparison is deliberately mechanical rather than "does this look the
   * same": line endings unified (a Windows checkout writes CRLF into the
   * template literal), trailing whitespace dropped, and the common indentation
   * removed — the skill nests the block one level inside its `declare module`
   * wrapper, and the container nests it inside its own.
   *
   * A marker is a COMMENT LINE that starts with BEGIN / END, not any line that
   * mentions the token: `plugin-todo`'s card names the block in a doc comment
   * above its own copy, so a substring match would slice from the prose and
   * compare two different regions (measured: that is exactly what a first
   * version of this helper did).
   *
   * @param text - the file or body to slice.
   * @returns the lines strictly between the marker lines.
   */
  function blockBetweenMarkers(text: string): string {
    const lines = text.replace(/\r\n/gu, '\n').split('\n')
    const marker = (name: string): RegExp => new RegExp(`^\\s*//\\s*${name} workbench-card-slot\\b`, 'u')
    const start = lines.findIndex(line => marker('BEGIN').test(line))
    const end = lines.findIndex(line => marker('END').test(line))
    assert.ok(start !== -1, 'the BEGIN marker is missing')
    assert.ok(end > start, 'the END marker is missing, or comes before BEGIN')
    const inner = lines.slice(start + 1, end).map(line => line.trimEnd())
    const indents = inner.filter(line => line.trim() !== '').map(line => line.length - line.trimStart().length)
    const common = indents.length === 0 ? 0 : Math.min(...indents)
    return inner.map(line => line.slice(common)).join('\n').trim()
  }

  it('reproduces the container declaration verbatim, which is the drift the block warns about', () => {
    // The skill no longer points at the container's source: an agent runs in the
    // user's folder, the app ships as built output, and a path here sent a real
    // session into a build artefact and two unrelated repositories. So the body
    // CARRIES the block — and this compares it with the container's own copy, so
    // a seat change that skips the skill cannot ship: every card the agent writes
    // would paste a declaration that no longer matches what the container
    // declares.
    const container = readFileSync(join(srcDir, 'client.ts'), 'utf8')
    const shipped = blockBetweenMarkers(container)
    assert.ok(shipped.length > 0, 'the container block is empty')
    assert.equal(blockBetweenMarkers(body), shipped)
  })

  it('lists every owner prop the card is handed, and invents none', () => {
    // The interface is declared OUTSIDE the markers (the block only references
    // it), so the block alone does not tell a card what it receives. Read the
    // names where they are defined...
    const page = readFileSync(join(srcDir, 'client', 'page.tsx'), 'utf8')
    const start = page.indexOf('export interface WorkbenchCardOwnerProps')
    assert.ok(start !== -1, 'the owner-props interface is not in page.tsx')
    const declared = page.slice(start, page.indexOf('\n}', start))
    const members = [...declared.matchAll(/readonly (\w+):/gu)].map(match => match[1] ?? '')
    assert.deepEqual([...members].sort(), ['enterWorkspace', 'entryMessage', 'openView'])

    // ... and require the skill's own list to be exactly that set, in BOTH
    // directions: a prop added to the container and not written here is red, and
    // so is a name the container dropped. The bullet shape is deliberate — it is
    // the only list in this body whose entries start with a backticked call.
    const listed = [...body.matchAll(/^- `(\w+)\(/gmu)].map(match => match[1] ?? '')
    assert.deepEqual([...new Set(listed)].sort(), [...members].sort())
  })

  it('names only paths a packaged install actually has, and never a checkout of ours', () => {
    // The measured defect: a sentence naming `plugins/…/src/client.ts` sent a real
    // Creator session looking for a source tree that was not in the user's
    // workspace, then into a build artefact (which never holds a `SlotMap`), then
    // into two unrelated repositories. The rule is narrower now, not looser: the
    // body may name ONE example path, the one that exists at run time, and the
    // rest of the ban stays.
    //
    // 1. Nothing machine-specific, and nothing relative to a work tree.
    assert.doesNotMatch(body, /\b[A-Za-z]:[\\/]/u)
    // A Git-Bash style absolute path (`/d/…`), which is how the measured sessions
    // wrote their searches.
    assert.doesNotMatch(body, /(^|[\s(`])\/[a-z]\//u)
    assert.doesNotMatch(body, /~\/\.dsh/u)
    assert.doesNotMatch(body, /(^|[\s(`])(plugins|scratch|docs|scripts|src)\//mu)
    // 2. Every scoped package name is BOUND to the profile's node_modules — a bare
    // `@dsh-app/…` reads as an import a card could make, and that import does not
    // exist for a card. (`/api/plugins/dsh-app/…` is a route, not this shape.)
    const scoped = [...body.matchAll(/@dsh-app\/[A-Za-z0-9.-]+/gu)]
    assert.ok(scoped.length > 0, 'the body should name the example package')
    for (const match of scoped) {
      const before = body.slice(0, match.index ?? 0)
      assert.match(
        before,
        /\$DSH_PROFILE_DIR\/node_modules\/$/u,
        `${match[0]} must sit under $DSH_PROFILE_DIR/node_modules/, never bare`,
      )
    }
    // 3. The two facts both measured sessions were missing have to be IN the body:
    // who owns packaging and mounting, and where a plugin's data lives.
    assert.match(body, /\bcordis-plugin-development\b/u)
    assert.match(body, /\$DSH_HOME\/storages\//u)
    // The tools a session legitimately starts with are still named — the rule is
    // about paths, not about identifiers.
    assert.match(body, /cordis_inspect_list/u)
    assert.match(body, /cordis_inspect_query/u)
  })

  it('opens with the frontmatter the discovery path requires', () => {
    assert.ok(body.startsWith('---\n'))
    assert.match(body, new RegExp(`^---\\nname: ${SKILL_NAME}\\n`, 'u'))
    assert.match(body, /^description: .+$/mu)
  })

  it('is English, like every other file of this half', () => {
    assert.doesNotMatch(body, /[\p{Script=Han}]/u)
  })
})

describe('workbench seat-contract skill install', () => {
  it('lands at $DSH_HOME/skills/<name>/SKILL.md with the body it ships', async () => {
    const home = await makeHome()
    assert.equal(skillFilePath(home), join(home, 'skills', SKILL_NAME, 'SKILL.md'))
    assert.equal(await installSkill(home), 'installed')
    assert.equal(await readFile(skillFilePath(home), 'utf8'), SKILL_MARKDOWN)
  })

  it('does not rewrite an unchanged file, and a second pass adds no second copy', async () => {
    const home = await makeHome()
    assert.equal(await installSkill(home), 'installed')
    // A rewritten file is what a timestamp compare would show; the function's own
    // answer is the contract, and the directory listing proves there is exactly
    // one file either way.
    assert.equal(await installSkill(home), 'unchanged')
    const directory = join(home, 'skills', SKILL_NAME)
    assert.deepEqual(await readdir(directory), ['SKILL.md'])
  })

  it('refreshes a body that is this plugin own but out of date', async () => {
    const home = await makeHome()
    await mkdir(join(home, 'skills', SKILL_NAME), { recursive: true })
    // An older generation of OUR skill: it names the seats, so it is ours to
    // replace — which is what makes a fixed contract reach an existing install.
    await writeFile(skillFilePath(home), '# old\n\nregister into `workbench.item`\n', 'utf8')
    assert.equal(await installSkill(home), 'installed')
    assert.equal(await readFile(skillFilePath(home), 'utf8'), SKILL_MARKDOWN)
  })

  it('keeps a same-named skill whose body is not ours', async () => {
    // The slug is a legal market slug, so the directory can hold somebody else's
    // skill. Overwriting it on every start is data loss with no error message.
    const home = await makeHome()
    const foreign = '# somebody else\'s skill\n\nThis one has nothing to do with cards.\n'
    await mkdir(join(home, 'skills', SKILL_NAME), { recursive: true })
    await writeFile(skillFilePath(home), foreign, 'utf8')
    assert.equal(await installSkill(home), 'kept-foreign')
    assert.equal(await readFile(skillFilePath(home), 'utf8'), foreign)
  })
})

describe('workbench host apply', () => {
  it('installs the skill on mount, under the $DSH_HOME it resolves', async () => {
    const home = await makeHome()
    process.env.DSH_HOME = home
    const { ctx, warnings } = hostContext()
    apply(ctx)
    const landed = await eventually(async () => {
      try {
        return (await readFile(skillFilePath(home), 'utf8')) === SKILL_MARKDOWN
      } catch {
        return false
      }
    })
    assert.ok(landed, 'the host half must install the seat-contract skill on mount')
    assert.deepEqual(warnings, [])
  })

  it('stays quiet and keeps going when the install cannot write', async () => {
    // A read-only or otherwise unusable home must not fail the mount: this plugin
    // is the whole workbench UI, and losing it over a skill write is worse than
    // losing the skill. The failure is logged, not thrown.
    const home = await makeHome()
    // A FILE where the skills directory has to be makes mkdir fail for certain,
    // on every platform, without depending on permissions.
    await writeFile(join(home, 'skills'), 'not a directory', 'utf8')
    process.env.DSH_HOME = home
    const { ctx, warnings } = hostContext()
    apply(ctx)
    const reported = await eventually(async () => warnings.length > 0)
    assert.ok(reported, 'the failure must be logged')
    assert.match(warnings.join('\n'), /workbench skill install failed/u)
  })
})
