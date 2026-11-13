/**
 * The kernel preflight's contract.
 *
 * `scripts/kernel-preflight.mjs` exists because three line moves paid for the
 * same miss: a change no gate could see until it was already adapted (a renamed
 * registry return value, a renamed Office provider plus a cut skill list, a new
 * peer that `--legacy-peer-deps` skips). Each is a question about the TARGET
 * line, askable without adapting anything.
 *
 * What is worth asserting, and nothing else:
 *
 *   1. the installed line is clean. This is what makes the script usable as a
 *      CI step: it must not report a blocker against the line this repository
 *      actually runs, or the report becomes noise and stops being read.
 *   2. a target that dropped a name we import is a blocker, naming the symbol.
 *   3. a target that does not ship a package we import is a blocker naming the
 *      package — the rename case (dsh-office-to-pdf → dsh-office-kit) is exactly
 *      this, and it is invisible to every type gate because the failing import
 *      is a runtime value.
 *   4. the two skill-name mirrors are compared against the target's own list.
 *      The 7 → 4 cut was three names, and both copies of the list refused at
 *      different moments (build, boot).
 *   5. overlay rows: a patched row the target no longer carries is a silent
 *      no-op, and an insert id that collides with a row the target added is a
 *      duplicate mount.
 *   6. the CLI contract: `--json` parses, an unknown flag exits 2, `--dir` and
 *      `--npm` are exclusive.
 *
 * Deliberately NOT asserted: any count of packages, slots or overlay rows. Those
 * move with every ordinary dependency change; pinning them would make the test
 * a churn source rather than a contract.
 *
 * The fixtures are fake upstream trees, not real ones: a real checkout would
 * make this suite depend on network state and on a repository that is not this
 * one. What matters is that each check fires on the shape it is meant to catch.
 *
 * @module test/kernel-preflight.test
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { followedSpec } from '../scripts/kernel-line.mjs'
import { Findings, checkLine, compareVersions, installedTarget, ourImports, ourOverlayRows } from '../scripts/kernel-preflight.mjs'
import { scratchDir } from './scratch.mjs'

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const script = path.join(repoRoot, 'scripts', 'kernel-preflight.mjs')

/**
 * Run the preflight and return its parsed JSON report.
 *
 * @param {string[]} args - CLI arguments.
 * @returns {{ status: number, report: object }} the exit code and the report.
 */
function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args, '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, report: JSON.parse(stdout) }
  } catch (error) {
    // A non-zero exit is the interesting case: the report is on stdout, the exit
    // code on the error. Anything else is a real failure of the script.
    if (typeof error.stdout === 'string' && error.stdout.trim().startsWith('{')) {
      return { status: error.status, report: JSON.parse(error.stdout) }
    }
    throw error
  }
}

/**
 * Write a fake upstream checkout.
 *
 * @param {Record<string, string>} files - repository-relative path → content.
 * @returns {string} the checkout root.
 */
function checkout(files) {
  const dir = scratchDir('dsh-preflight-')
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(dir, relative)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return dir
}

/** A package manifest for the fake line, at the version this repository follows. */
function manifest(name) {
  return JSON.stringify({ name, version: followedSpec().replace(/^[\^~]/u, ''), type: 'module' }, null, 2)
}

test('the installed line reports no blocker', () => {
  const { status, report } = run([])
  assert.equal(status, 0, `the followed line must be clean: ${JSON.stringify(report.findings.filter((f) => f.severity === 'blocker'))}`)
  assert.equal(report.target.mode, 'installed')
  assert.equal(report.target.line, followedSpec().replace(/^[\^~]/u, ''))
  assert.equal(report.blockers, 0)
  // The line check must have RUN, not silently skipped: it is the one that says
  // every consumed package resolves at one version.
  assert.ok(report.findings.some((finding) => finding.check === 'line' && finding.subject === report.target.line))
})

test('a target that dropped an imported name is a blocker naming the symbol', () => {
  // `dsh-tools` ships an empty entry: every name this repository imports from
  // it is gone, which is the removal case a type gate cannot see for a value.
  const dir = checkout({
    'packages/tooling/dsh-tools/package.json': manifest('@deepseek-ai/dsh-tools'),
    'packages/tooling/dsh-tools/src/index.ts': 'export const nothingWeUse = 1\n',
  })
  const { status, report } = run(['--dir', dir])
  assert.equal(status, 1)
  const finding = report.findings.find((item) => item.check === 'exports' && item.subject === '@deepseek-ai/dsh-tools')
  assert.ok(finding, 'the dropped name must be reported')
  assert.equal(finding.severity, 'blocker')
  assert.match(finding.detail, /defineTool/u)
})

test('a package the target no longer ships is a blocker naming the package', () => {
  // The rename case: rc.2 replaced `dsh-office-to-pdf` with `dsh-office-kit`, and
  // the refusal was a runtime import in a plugin whose build does not type check.
  const dir = checkout({
    'packages/tooling/dsh-tools/package.json': manifest('@deepseek-ai/dsh-tools'),
    'packages/tooling/dsh-tools/src/index.ts': 'export const nothingWeUse = 1\n',
  })
  const imported = [...ourImports(repoRoot).keys()].map((spec) => spec.split('/').slice(0, 2).join('/'))
  const absent = imported.find((name) => name.includes('atomic-write'))
  assert.ok(absent, 'this repository imports a package the fixture omits')
  const { report } = run(['--dir', dir])
  const finding = report.findings.find((item) => item.check === 'published' && item.subject === absent)
  assert.ok(finding, `${absent} must be reported as absent from the target`)
  assert.equal(finding.severity, 'blocker')
})

test('the skill-name mirrors are compared against the target list', () => {
  const upstream = ['office', 'office-docx', 'office-pptx', 'office-xlsx', 'office-render', 'office-recalculate', 'office-export-pdf']
  const dir = checkout({
    'packages/skill/dsh-skill-office/package.json': manifest('@deepseek-ai/dsh-skill-office'),
    'packages/skill/dsh-skill-office/src/index.ts': `export const SKILL_NAMES = [\n${upstream.map((name) => `  '${name}',`).join('\n')}\n]\n`,
    'packages/tooling/dsh-tools/package.json': manifest('@deepseek-ai/dsh-tools'),
    'packages/tooling/dsh-tools/src/index.ts': 'export const nothingWeUse = 1\n',
  })
  const { report } = run(['--dir', dir])
  const finding = report.findings.find((item) => item.check === 'skill-office' && item.severity === 'blocker')
  assert.ok(finding, 'the skill list drift must be reported')
  // Our mirror has the four names the line kept; the three it dropped are the
  // difference that broke the build and the boot at different moments.
  assert.match(finding.detail, /office-render/u)
})

test('an overlay row the target dropped is a blocker, a colliding insert id too', () => {
  const { patched, inserted } = ourOverlayRows(repoRoot)
  assert.ok(patched.length > 0 && inserted.length > 0, 'this repository patches and inserts overlay rows')
  const dir = checkout({
    // One row of ours, and no row for the ones we patch: the patch is a no-op
    // and the insert is a duplicate mount.
    'packages/bundle/base/cordis.patch.yml': `- insert:\n    - id: ${inserted[0]}\n      name: x\n`,
    'packages/tooling/dsh-tools/package.json': manifest('@deepseek-ai/dsh-tools'),
    'packages/tooling/dsh-tools/src/index.ts': 'export const nothingWeUse = 1\n',
  })
  const { report } = run(['--dir', dir])
  const missing = report.findings.find((item) => item.check === 'overlay' && item.subject === patched[0])
  assert.ok(missing, `the patched row ${patched[0]} must be reported as gone`)
  assert.equal(missing.severity, 'blocker')
  const collision = report.findings.find((item) => item.check === 'overlay' && item.subject === inserted[0])
  assert.ok(collision, `the insert id ${inserted[0]} must be reported as colliding`)
  assert.match(collision.detail, /collides/u)
})

test('the CLI contract: exclusive modes and an unknown flag', () => {
  assert.throws(() => execFileSync(process.execPath, [script, '--dir', '.', '--npm', '1.0.0'], { stdio: 'ignore' }), /Command failed/u)
  assert.throws(() => execFileSync(process.execPath, [script, '--nope'], { stdio: 'ignore' }), /Command failed/u)
})

test('a host service id the target dropped is a blocker', () => {
  // The host-side twin of a slot, and the 0.2.2 break itself: rc.2 renamed the
  // Office provider's service id, and every `ctx.officeToPdf.…` call became a
  // property read on `undefined` in the plugins whose build does not type check.
  const dir = checkout({
    'packages/tooling/dsh-tools/package.json': manifest('@deepseek-ai/dsh-tools'),
    'packages/tooling/dsh-tools/src/index.ts': 'export const nothingWeUse = 1\n',
    'packages/tooling/dsh-tools/src/context.ts': "declare module '@deepseek-ai/cordis' {\n  interface Context {\n    tools: unknown\n  }\n}\n",
  })
  const { report } = run(['--dir', dir])
  const finding = report.findings.find((item) => item.check === 'services' && item.subject === 'officeKit')
  assert.ok(finding, 'the renamed service must be reported')
  assert.equal(finding.severity, 'blocker')
  // A name the baseline never declared (cordis's own members) must not be
  // reported: that would blame the line for the scan's own blind spot.
  assert.ok(!report.findings.some((item) => item.check === 'services' && item.subject === 'effect'))
})

test('a newly declared peer that nothing installs is a blocker', () => {
  // `--legacy-peer-deps` does not install peers, so a peer the target ADDS fails
  // at bundle time ("Could not resolve") in every suite that bundles the package,
  // and never at type-check time. The name is invented: a real one could be
  // installed by the time this runs, which would test the tree, not the check.
  const dir = checkout({
    'packages/tooling/dsh-tools/package.json': JSON.stringify({
      name: '@deepseek-ai/dsh-tools',
      version: followedSpec().replace(/^[\^~]/u, ''),
      type: 'module',
      peerDependencies: { '@deepseek-ai/dsh-invented-peer': '^0.2.2' },
    }, null, 2),
    'packages/tooling/dsh-tools/src/index.ts': 'export const nothingWeUse = 1\n',
  })
  const { report } = run(['--dir', dir])
  const finding = report.findings.find((item) => item.check === 'peers' && item.subject === '@deepseek-ai/dsh-tools → @deepseek-ai/dsh-invented-peer')
  assert.ok(finding, 'the added peer must be reported')
  assert.equal(finding.severity, 'blocker')
  assert.match(finding.detail, /no manifest of this repository installs/u)
})

test('a move can be re-audited in its own direction: --baseline-dir', () => {
  const before = checkout({
    'packages/tooling/dsh-commands/package.json': manifest('@deepseek-ai/dsh-commands'),
    'packages/tooling/dsh-commands/src/index.ts': 'export interface CommandResult {\n  ok: boolean\n}\n',
  })
  const after = (member) => checkout({
    'packages/tooling/dsh-commands/package.json': manifest('@deepseek-ai/dsh-commands'),
    'packages/tooling/dsh-commands/src/index.ts': `export interface CommandResult {\n  ok: boolean\n  ${member}\n}\n`,
  })

  // An OPTIONAL member added breaks no call site: a note, not a work item.
  const optional = run(['--dir', after('extra?: string'), '--baseline-dir', before])
  const note = optional.report.findings.find((item) => item.check === 'declarations' && item.subject.endsWith('CommandResult') && item.severity === 'note')
  assert.ok(note, 'an added optional member must be reported as additive')
  assert.match(note.detail, /additive/u)
  assert.ok(!optional.report.findings.some((item) => item.check === 'declarations' && item.severity === 'adapt' && item.subject.endsWith('CommandResult')),
    'an added optional member must not be a work item')

  // A REQUIRED member added is the shape that forces call-site changes.
  const required = run(['--dir', after('extra: string'), '--baseline-dir', before])
  const adapt = required.report.findings.find((item) => item.check === 'declarations' && item.severity === 'adapt' && item.subject.endsWith('CommandResult'))
  assert.ok(adapt, 'an added required member must be a work item')
})

test('a transitive pin the target moved past is a blocker', () => {
  // The zod case: the kernel's projection began pinning a version the plugin did
  // not bundle, and the mismatch surfaced as a missing method at runtime.
  const dir = checkout({
    'packages/tooling/dsh-commands/package.json': JSON.stringify({
      name: '@deepseek-ai/dsh-commands',
      version: followedSpec().replace(/^[\^~]/u, ''),
      type: 'module',
      dependencies: { zod: '99.0.0' },
    }, null, 2),
    'packages/tooling/dsh-commands/src/index.ts': 'export interface CommandResult {\n  ok: boolean\n}\n',
  })
  const { report } = run(['--dir', dir])
  const finding = report.findings.find((item) => item.check === 'deps' && item.subject.startsWith('zod 99.0.0'))
  assert.ok(finding, 'the mismatched pin must be reported')
  assert.equal(finding.severity, 'blocker')
  assert.match(finding.detail, /this tree has/u)
})

test('the baseline flags are exclusive', () => {
  assert.throws(
    () => execFileSync(process.execPath, [script, '--baseline-dir', '.', '--baseline-npm', '1.0.0'], { stdio: 'ignore' }),
    /Command failed/u,
  )
})

test('the line-move process keeps the preflight as its first step', () => {
  // The documented process is the only thing that makes this command run at the
  // right moment; a step that quietly drops out of the checklist is a step that
  // stops happening. Four assertions, each pinned to what the doc actually says:
  const doc = readFileSync(path.join(repoRoot, 'docs', 'agents', 'kernel-line-regression.md'), 'utf8')

  // 1. both target shapes are named (a checkout before publication, the
  //    published packages after it)
  assert.match(doc, /check:preflight -- --npm/u)
  assert.match(doc, /check:preflight -- --dir/u)

  // 2. the checklist gates on it BEFORE the contact-surface scan
  const checklist = doc.slice(doc.indexOf('## 9 升线清单'))
  const preflightAt = checklist.indexOf('check:preflight')
  const touchpointsAt = checklist.indexOf('check:touchpoints')
  assert.ok(preflightAt > 0, 'the checklist must name the preflight')
  assert.ok(touchpointsAt === -1 || preflightAt < touchpointsAt, 'the preflight must come before the touchpoint scan')

  // 3. the round's record has a field for the result
  assert.match(doc, /`预检`/u)

  // 4. the command exists in the manifest: a doc naming a script nobody wired is
  //    worse than no doc at all
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  assert.match(manifest.scripts['check:preflight'] ?? '', /kernel-preflight\.mjs/u)
})

test('one line: a copy BELOW the followed line blocks, a copy ABOVE it is a bump', () => {
  // Two failures used to share one blocker, and that is why the check could not
  // run on every pull request: the day upstream tags a release, the plugin trees
  // float ahead of the root lockfile and every unrelated PR went red. They mean
  // different things, so they get different severities.
  const installed = (pluginVersion, rootVersion) => {
    const dir = scratchDir('dsh-preflight-line-')
    for (const [relative, version] of [['node_modules', rootVersion], [path.join('plugins', 'plugin-x', 'node_modules'), pluginVersion]]) {
      const pkg = path.join(dir, relative, '@deepseek-ai', 'dsh-tools')
      mkdirSync(pkg, { recursive: true })
      writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', version }, null, 2))
      writeFileSync(path.join(pkg, 'index.d.ts'), 'export const defineTool = 1\n')
    }
    return dir
  }
  const report = (dir, policy) => {
    const findings = new Findings()
    checkLine(installedTarget(dir), new Map([['@deepseek-ai/dsh-tools', new Set(['defineTool'])]]), findings, policy)
    return findings.items
  }
  const floor = followedSpec().replace(/^[\^~]/u, '')
  const older = '0.2.2-rc.1'
  const newer = '0.2.2-rc.99'

  const stale = report(installed(older, floor))
  const staleFinding = stale.find((item) => item.check === 'line' && item.severity === 'blocker' && item.subject.startsWith('@deepseek-ai/dsh-tools'))
  assert.ok(staleFinding, 'a copy older than the followed line must block — it wins resolution silently')
  assert.match(staleFinding.subject, new RegExp(older.replace(/\./gu, '\.')))

  const ahead = report(installed(newer, floor))
  assert.ok(!ahead.some((item) => item.check === 'line' && item.severity === 'blocker' && item.subject.includes(newer)),
    'a copy ahead of the line is a bump that is due, not a defect')
  const bump = ahead.find((item) => item.check === 'line' && item.severity === 'note' && item.subject.includes('ahead of the followed line'))
  assert.ok(bump, 'the drift must still be reported, with the action')
  assert.match(bump.detail, /bump the line/u)

  // …and a release run wants it fatal again.
  const exact = report(installed(newer, floor), 'exact')
  assert.ok(exact.some((item) => item.check === 'line' && item.severity === 'blocker'), '--line-policy=exact must block on drift')
})

test('version comparison understands prereleases', () => {
  // The whole repository moves BETWEEN prereleases; a comparator that drops the
  // rc number reads 0.2.2-rc.1 and 0.2.2-rc.2 as equal, and the drift rule above
  // then never fires.
  assert.ok(compareVersions('0.2.2-rc.1', '0.2.2-rc.2') < 0)
  assert.ok(compareVersions('0.2.2-rc.10', '0.2.2-rc.9') > 0)
  assert.ok(compareVersions('0.2.2', '0.2.2-rc.9') > 0)
  assert.ok(compareVersions('^0.2.2-rc.2', '0.2.2-rc.2') === 0)
  assert.ok(compareVersions('0.2.1', '0.2.2-rc.2') < 0)
})

test('a line package pinned to the line version is not a transitive mismatch', () => {
  // The first release-day run reported 11 blockers of the shape "dsh-brand
  // 0.2.2-rc.3 pinned, this tree has rc.2" — the expected state before a bump,
  // owned by the line check, not by this one. Third-party pins stay judged.
  const dir = checkout({
    'packages/tooling/dsh-commands/package.json': JSON.stringify({
      name: '@deepseek-ai/dsh-commands',
      version: followedSpec().replace(/^[\^~]/u, ''),
      type: 'module',
      // A line package two lines ahead of this tree, and a third-party pin that
      // really is behind: only the second one is a finding.
      dependencies: { '@deepseek-ai/dsh-brand': '0.2.2-rc.99', zod: '99.0.0' },
    }, null, 2),
    'packages/tooling/dsh-commands/src/index.ts': 'export interface CommandResult {\n  ok: boolean\n}\n',
  })
  const { report } = run(['--dir', dir])
  assert.ok(!report.findings.some((item) => item.check === 'deps' && item.subject.includes('dsh-brand')),
    'a line package pin belongs to the line check, not the transitive one')
  assert.ok(report.findings.some((item) => item.check === 'deps' && item.subject.startsWith('zod 99.0.0')),
    'a third-party pin that is behind is still a finding')
})
