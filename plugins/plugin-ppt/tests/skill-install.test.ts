/**
 * The skill install, and the dead directories it retires.
 *
 * `plugin-doc` / `plugin-sheet` installed `dsh-word` / `dsh-sheet` and were
 * removed when Word/Excel generation moved to the kernel's own Office skills.
 * Nothing deletes a skill directory when its plugin disappears, so an installation
 * that carried them keeps a SKILL.md whose workflow opens with `doc_write` — a
 * tool that exists nowhere — and a model following it fails at step one.
 *
 * Two properties this suite exists to pin, because getting either wrong is
 * worse than doing nothing:
 *
 *   - the retirement is judged by the BODY, not the name. `dsh-word` is a legal
 *     market slug (`plugin-market/src/skills.ts` `parseSkillSlug`), so the same
 *     path can hold a skill the user installed from a catalog — deleting that on
 *     every start would erase a stranger's skill for ever, invisibly;
 *   - a live skill, a sibling's skill and the user's own directory survive, and
 *     the retired directory goes because its text names a tool that is gone.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  installSkill,
  LEGACY_SKILL_NAME,
  RETIRED_SKILLS,
  retireSkills,
  SKILL_MARKDOWN,
  SKILL_NAME,
  skillFilePath,
} from '../src/skill.ts'

/** Write a SKILL.md into `$home/skills/<name>/`; returns the directory. */
function plantSkill(home: string, name: string, body: string): string {
  const dir = join(home, 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), body)
  return dir
}

/** The body the removed plugins shipped: a workflow that opens with a dead tool. */
const DEAD_WORD = '# Word 文档生成\n\n1. 用 `doc_write` 写成 JSON…\n2. 调用 `doc_check`…\n'

/** A plausible user-installed skill that happens to share the retired name. */
const USER_WORD = '# My own word helper\n\nUse the file tools; no custom tool required.\n'

test('a dead skill directory is retired because its text names a dead tool', async () => {
  const home = mkdtempSync(join(os.tmpdir(), 'ppt-skill-retire-'))
  try {
    const dead = plantSkill(home, 'dsh-word', DEAD_WORD)
    assert.deepEqual((await retireSkills(home)).removed, ['dsh-word'])
    assert.ok(!existsSync(dead), 'the dead skill is gone')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a retired directory that is a link is unlinked, not followed', async () => {
  // The repo has emptied a runtime tree once by following a junction (see
  // test/recursive-delete-guard.test.mjs). The async `rm` does not follow, and
  // this pins that the retirement inherits that property: the LINK goes, the tree
  // it pointed at keeps its files.
  const root = mkdtempSync(join(os.tmpdir(), 'ppt-skill-link-'))
  try {
    const home = join(root, 'home')
    const runtime = join(root, 'runtime', 'word-skill')
    mkdirSync(runtime, { recursive: true })
    writeFileSync(join(runtime, 'SKILL.md'), DEAD_WORD)
    writeFileSync(join(runtime, 'keep.txt'), 'must survive\n')
    const link = join(home, 'skills', 'dsh-word')
    mkdirSync(join(home, 'skills'), { recursive: true })
    symlinkSync(runtime, link, process.platform === 'win32' ? 'junction' : 'dir')

    assert.deepEqual((await retireSkills(home)).removed, ['dsh-word'])
    assert.ok(!existsSync(link), 'the link itself is gone')
    assert.deepEqual(readdirSync(runtime).sort(), ['SKILL.md', 'keep.txt'], 'the linked tree is intact')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a skill of the same NAME that is not ours is left alone', async () => {
  // The market allows `dsh-word` as a slug, so this directory may belong to the
  // user. Its body names no dead tool, and that is the whole test.
  const home = mkdtempSync(join(os.tmpdir(), 'ppt-skill-foreign-'))
  try {
    const mine = plantSkill(home, 'dsh-word', USER_WORD)
    const report = await retireSkills(home)
    assert.deepEqual(report.removed, [])
    assert.equal(report.skipped[0]?.name, 'dsh-word')
    assert.match(report.skipped[0]?.reason ?? '', /not this suite/u)
    assert.ok(existsSync(mine), "a user's own skill must never be deleted")
    assert.equal(readFileSync(join(mine, 'SKILL.md'), 'utf8'), USER_WORD)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('the legacy directory is retired when its text names the dead ppt_* tools', async () => {
  const home = mkdtempSync(join(os.tmpdir(), 'ppt-skill-legacy-'))
  try {
    // The first-generation body: it described the retired `ppt_*` pipeline, and
    // that text is what marks this directory as the suite's own.
    const legacy = plantSkill(home, LEGACY_SKILL_NAME, '# 旧版演示文稿技能\n\n1. 用 `ppt_write` 写成 JSON…\n')
    const sibling = plantSkill(home, 'dsh-pdf', '# PDF\n\n`pdf_read`…\n')
    const own = plantSkill(home, 'my-own-skill', '# mine\n')

    const result = await installSkill(home)
    assert.equal(result.change, 'installed')
    assert.deepEqual([...result.retired.removed].sort(), [LEGACY_SKILL_NAME].sort())

    assert.ok(!existsSync(legacy))
    assert.ok(existsSync(sibling), "the sibling's skill is not this plugin's to remove")
    assert.ok(existsSync(own), "the user's own skill must never be touched")
    assert.equal(readFileSync(skillFilePath(home), 'utf8'), SKILL_MARKDOWN)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a legacy directory whose text names no dead tool is kept, and says why', async () => {
  // Behaviour change this pins: the old code deleted `dsh-app-ppt` by name. It is
  // a legal market slug, so a directory at that path may now belong to a user
  // skill — the body is what decides, exactly as for the other two.
  const home = mkdtempSync(join(os.tmpdir(), 'ppt-skill-legacy-foreign-'))
  try {
    const foreign = plantSkill(home, LEGACY_SKILL_NAME, USER_WORD)
    const report = await retireSkills(home)
    assert.deepEqual(report.removed, [])
    assert.equal(report.skipped[0]?.name, LEGACY_SKILL_NAME)
    assert.match(report.skipped[0]?.reason ?? '', /not this suite/u)
    assert.ok(existsSync(foreign), 'a same-named skill that is not ours survives')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a clean home installs once and retires nothing on the second mount', async () => {
  const home = mkdtempSync(join(os.tmpdir(), 'ppt-skill-idempotent-'))
  try {
    const first = await installSkill(home)
    assert.equal(first.change, 'installed')
    assert.deepEqual(first.retired.removed, [])
    assert.deepEqual(first.retired.skipped, [])

    const second = await installSkill(home)
    assert.equal(second.change, 'unchanged', 'an unchanged file must not be rewritten')
    assert.deepEqual(second.retired.removed, [])
    assert.deepEqual(second.retired.skipped, [])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('the retired rosters stay honest', async () => {
  // Each marker has to be a tool that really is absent from the kernel: a marker
  // naming a live tool would delete a working skill. `doc_*` / `sheet_*` were
  // removed with their plugins; the suite's own office tools are `pptd_*` and
  // `pdf_*`, never named here.
  assert.deepEqual(RETIRED_SKILLS.map(entry => entry.name), ['dsh-word', 'dsh-sheet', LEGACY_SKILL_NAME])
  for (const { name, markers } of RETIRED_SKILLS) {
    assert.notEqual(name, SKILL_NAME, 'a live skill is never on the retirement roster')
    assert.ok(markers.length > 0, `${name} needs at least one marker`)
    for (const marker of markers) {
      assert.match(marker, /^(?:doc|sheet|ppt)_/u, `${marker} is not a removed-plugin tool name`)
    }
  }
})

test('the skill body names the tools that actually exist', async () => {
  // The defect this pins: the body said `ppt_write → ppt_check → ppt_render`,
  // three names that exist nowhere, while the plugin registers `pptd_*`. A model
  // following the retired names fails at its first step, so the text has to name
  // the real pipeline and never the old one.
  assert.match(SKILL_MARKDOWN, /pptd_write_file/u)
  assert.match(SKILL_MARKDOWN, /pptd_check/u)
  assert.match(SKILL_MARKDOWN, /pptd_render/u)
  assert.doesNotMatch(SKILL_MARKDOWN, /\bppt_(?:write|check|render)\b/u)
})
