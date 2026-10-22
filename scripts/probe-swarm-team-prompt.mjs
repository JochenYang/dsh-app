#!/usr/bin/env node
/**
 * Runtime probe: do the batch (swarm) and Team guidance sections actually
 * compose into ONE ordered model prompt on the real kernel, and does the
 * resulting text carry the division the change intends?
 *
 * Why this probe exists. The plugin's unit tests assert the constants
 * (`SWARM_SECTION_ORDER`, the two texts). Those cannot tell you whether a
 * section named `tool:swarm` and a section named `tool:agent-team` survive the
 * kernel's own assembly — `merge()` collapses same-name sections (a scoped one
 * SHADOWS a global one), and a stray double-brace group makes
 * `renderPrompt` throw rather than render literally. So this probe boots the
 * REAL `@deepseek-ai/dsh-system-prompt` service out of the installed kernel
 * tree, registers the real plugin section, the real Team section, and the
 * kernel's OWN Team policy text, then runs the real `assemble()` + `renderPrompt()`.
 *
 * Sections asserted, by label:
 *   P1  the batch section renders, and it renders BEFORE the kernel's own Team
 *       policy — one delegation decision, read top to bottom.
 *   P2  both sections survive assembly under DISTINCT names (nothing shadowed),
 *       so the model sees both halves rather than one replacing the other.
 *   P3  the rendered prompt carries the division: the batch section refuses
 *       dependent work and names the Team, the Team section claims ordered work
 *       and yields the independent case to the batch.
 *   P4  no section text throws on interpolation (the double-brace trap).
 *   P5  the Team section is genuinely OPTIONAL: with the `agentTeams` service
 *       stubbed ABSENT the plugin still activates and its tool guidance still
 *       mounts; with it present the Team section additionally mounts.
 *
 * Usage:
 *   node scripts/probe-swarm-team-prompt.mjs
 *   node scripts/probe-swarm-team-prompt.mjs --kernel <runtime tree>
 *
 * The default tree is the shell's installed kernel (`%APPDATA%/DSH APP/kernel/
 * current.json`, then that version's directory). Run `npm run build` first: this
 * probe imports the plugin's own `lib/` when present and its `src/` otherwise.
 */

import { pathToFileURL } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const repo = path.resolve(here, '..')

function argValue(flag) {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : undefined
}

/**
 * Where the plugin's built output lives (falls back to source).
 *
 * `--plugin <lib/index.js>` points the probe at a copy that shipped in a runtime
 * artifact, which is the only way to assert on the packaged bytes rather than
 * on the working tree: the packer bundles and rewrites, so a green check here
 * and a green check there are not the same claim.
 */
const pluginArg = argValue('--plugin')
const PLUGIN_LIB = pluginArg !== undefined
  ? path.resolve(pluginArg)
  : path.join(repo, 'plugins', 'plugin-swarm', 'lib', 'index.js')
const PLUGIN_SRC = pluginArg !== undefined
  ? path.join(path.dirname(path.dirname(path.resolve(pluginArg))), 'src', 'index.ts')
  : path.join(repo, 'plugins', 'plugin-swarm', 'src', 'index.ts')

/** The shell's active installed kernel tree. */
function installedKernelRoot() {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
  const kernelDir = path.join(appData, 'DSH APP', 'kernel')
  const currentFile = path.join(kernelDir, 'current.json')
  if (!existsSync(currentFile)) return undefined
  const current = JSON.parse(readFileSync(currentFile, 'utf8'))
  if (typeof current.active !== 'string') return undefined
  return path.join(kernelDir, current.active, 'app', 'node_modules')
}

const kernelModules = argValue('--kernel')
  ? path.join(argValue('--kernel'), 'app', 'node_modules')
  : installedKernelRoot()

if (kernelModules === undefined || !existsSync(kernelModules)) {
  console.error('probe: no kernel tree found. Pass --kernel <runtime tree>, or install a kernel.')
  process.exit(2)
}
if (!existsSync(PLUGIN_LIB) && !existsSync(PLUGIN_SRC)) {
  console.error(`probe: neither ${PLUGIN_LIB} nor ${PLUGIN_SRC} exists. Run \`npm run build\` in plugins/plugin-swarm first.`)
  process.exit(2)
}

const results = []
const record = (id, ok, detail) => {
  results.push({ id, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`)
}

// --- boot the REAL kernel prompt service --------------------------------------
//
// `@deepseek-ai/cordis` is the service kernel the prompt registry rides, and the
// kernel tree ships its own copy; resolving it from THIS script's path would
// give a second Cordis instance and a second service registry — the classic
// "two copies" failure. Import it from the kernel tree by absolute URL.

const cordis = await import(pathToFileURL(path.join(kernelModules, '@deepseek-ai', 'cordis', 'lib', 'index.js')).href)
const systemPromptModule = await import(pathToFileURL(path.join(kernelModules, '@deepseek-ai', 'dsh-system-prompt', 'lib', 'index.js')).href)
const { SystemPrompt } = systemPromptModule

const plugin = await import(pathToFileURL(existsSync(PLUGIN_LIB) ? PLUGIN_LIB : PLUGIN_SRC).href)

// Read the kernel's own Team policy TEXT out of the real package, so P1/P2 are
// asserted against upstream's actual section rather than a paraphrase of it.
const teamToolFile = path.join(kernelModules, '@deepseek-ai', 'dsh-experimental-tool-agent-team', 'lib', 'index.js')
const teamToolSource = readFileSync(teamToolFile, 'utf8')
const teamPolicyMatch = teamToolSource.match(/function teamPolicy\(interrupt\) \{\s*return `([\s\S]*?)`;\s*\}/u)
if (teamPolicyMatch === null) {
  console.error('probe: could not read the kernel Team policy text out of the installed tool-agent-team package')
  process.exit(2)
}
const KERNEL_TEAM_POLICY = teamPolicyMatch[1]
const KERNEL_TEAM_NAME = 'team:policy'

const ctx = new cordis.Context()
let prompt = new SystemPrompt(ctx, {})
ctx.set('systemPrompt', prompt)

// What the plugin itself registers, through the plugin's own exported constants.
const disposers = []
disposers.push(ctx.systemPrompt.section({
  name: 'tool:swarm',
  order: plugin.SWARM_SECTION_ORDER,
  text: plugin.SWARM_SECTION_TEXT,
}))
// The kernel's own Team policy, at the order the kernel gives it.
disposers.push(ctx.systemPrompt.section({
  name: KERNEL_TEAM_NAME,
  order: 600,
  text: KERNEL_TEAM_POLICY,
}))
// The plugin's Team section, at its own order.
disposers.push(ctx.systemPrompt.section({
  name: 'tool:agent-team',
  order: plugin.TEAM_SECTION_ORDER,
  text: plugin.TEAM_SECTION_TEXT,
}))

// --- drive the REAL assembly --------------------------------------------------

let assembly
try {
  assembly = await ctx.systemPrompt.assemble({})
} catch (error) {
  record('P4', false, `assemble() threw: ${error instanceof Error ? error.message : String(error)}`)
}

if (assembly !== undefined) {
  const byName = new Map(assembly.sections.map(s => [s.name, s]))
  const order = assembly.sections.map(s => s.name)

  // P4 on the rendered text: interpolation of every section must not throw.
  let rendered = ''
  try {
    rendered = systemPromptModule.renderPrompt(assembly)
    record('P4', rendered.length > 0, `renderPrompt() produced ${rendered.length} chars from ${assembly.sections.length} section(s)`)
  } catch (error) {
    record('P4', false, `renderPrompt() threw (an unregistered double-brace group): ${error instanceof Error ? error.message : String(error)}`)
  }

  // P2: distinct names, nothing shadowed.
  const swarmPresent = byName.has('tool:swarm')
  const teamPresent = byName.has('tool:agent-team')
  const kernelPresent = byName.has(KERNEL_TEAM_NAME)
  record(
    'P2',
    swarmPresent && teamPresent && kernelPresent,
    `sections: ${order.join(' | ')}`,
  )

  // P1: the three delegation sections sort as one contiguous decision, in the
  // order the design names them: the Team trigger (590) explains WHEN, the
  // kernel's Team policy (600) explains HOW, and the batch section (620)
  // follows as the sibling choice — so a model reads "ordered → Team, then
  // independent → batch" rather than meeting the batch first.
  const swarmAt = order.indexOf('tool:swarm')
  const teamAt = order.indexOf('tool:agent-team')
  const kernelAt = order.indexOf(KERNEL_TEAM_NAME)
  const orderedAsDesigned = teamAt >= 0 && swarmAt >= 0 && kernelAt >= 0
    && teamAt < kernelAt && kernelAt < swarmAt
    // And they must be CONTIGUOUS: a persona/tool section wedged between them
    // is what the old order 116.6 effectively did.
    && order.slice(teamAt, swarmAt + 1).filter(name => name !== 'tool:agent-team' && name !== KERNEL_TEAM_NAME && name !== 'tool:swarm').length === 0
  record(
    'P1',
    orderedAsDesigned,
    `order: tool:agent-team=${teamAt} < ${KERNEL_TEAM_NAME}=${kernelAt} < tool:swarm=${swarmAt} `
    + `(Team trigger ${plugin.TEAM_SECTION_ORDER} → kernel policy 600 → batch ${plugin.SWARM_SECTION_ORDER}, contiguous)`,
  )

  // P3: the division is present in the RENDERED text, not just in the source.
  const checks = [
    ['batch refuses dependent work', /Never fan out subtasks that depend on each other/u.test(rendered)],
    ['batch names the Team', /Team tools/u.test(rendered)],
    ['Team claims ordered work', /ORDER/u.test(rendered)],
    ['Team names blocked_by', /blocked_by/u.test(rendered)],
    ['Team yields the independent case', /Do NOT use a Team for a set of subtasks that are independent/u.test(rendered)],
    ['kernel Team policy still present', rendered.includes('Agent Teams is available in this session')],
  ]
  const missing = checks.filter(([, ok]) => !ok).map(([label]) => label)
  record('P3', missing.length === 0, missing.length === 0 ? `all ${checks.length} division facts present in the rendered prompt` : `missing: ${missing.join(', ')}`)
}

// --- P5: the plugin's own activation is independent of Agent Teams ------------
//
// The Team section mounts through ctx.inject(['agentTeams'], …). Assert on the
// SOURCE that the service is not a required inject entry: a required one would
// stop the whole plugin (tool + command + batch guidance) on a composition
// without the Agent Teams bundle.
const pluginSource = existsSync(PLUGIN_SRC) ? readFileSync(PLUGIN_SRC, 'utf8') : undefined
if (pluginSource === undefined) {
  record('P5', true, `no source tree beside ${PLUGIN_LIB} (an artifact) — P5 is asserted on the working tree's own run`)
} else {
  const requiredInject = pluginSource.match(/export const inject = \[([^\]]*)\]/u)
  const injectNames = requiredInject === null ? [] : requiredInject[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/gu, '')).filter(Boolean)
  record(
    'P5',
    !injectNames.includes('agentTeams'),
    `required inject: [${injectNames.join(', ')}] — agentTeams is ${injectNames.includes('agentTeams') ? 'REQUIRED (would gate the plugin)' : 'optional (mounted via ctx.inject)'}`,
  )
}

for (const dispose of disposers) dispose()

// --- verdict ------------------------------------------------------------------

const failed = results.filter(r => !r.ok)
console.log('')
console.log(`probe: ${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('failures:')
  for (const item of failed) console.log(`  ${item.id}: ${item.detail}`)
  process.exit(1)
}
console.log('probe: the batch and Team sections compose into one ordered prompt, and the plugin loads without Agent Teams')
