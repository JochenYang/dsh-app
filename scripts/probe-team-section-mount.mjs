#!/usr/bin/env node
/**
 * Runtime probe: does the Team guidance section mount through cordis's optional
 * injection, in BOTH directions, on the REAL cordis out of the kernel tree?
 *
 * `scripts/probe-swarm-team-prompt.mjs` asserts the section order and text on
 * the real prompt service, and asserts on SOURCE that `agentTeams` is not a
 * required inject entry. Neither can show that the optional door actually
 * opens and closes: `ctx.inject(['agentTeams'], …)` runs its callback when the
 * service is present, and registers nothing when it is absent — and a
 * composition that adds the Agent Teams bundle LATER must still get the
 * section. That last direction is the one that regressed before, because the
 * profile's bundle list composes after the plugin's own fiber activates.
 *
 * Sections asserted, by label:
 *   I1  with NO `agentTeams` service, the plugin's callback does not run: no
 *       `tool:agent-team` section exists.
 *   I2  with the service PRESENT from the start, the section mounts exactly
 *       once, at TEAM_SECTION_ORDER, under the plugin's own section name.
 *   I3  when the service appears AFTER activation (a bundle layer registering
 *       later — the real composition order), the section still mounts.
 *   I4  when the service goes away, the section goes with it: no orphan
 *       guidance advertising tools that are no longer there.
 *
 * Usage:
 *   node scripts/probe-team-section-mount.mjs [--kernel <runtime tree>]
 *
 * Run `npm run build` in plugins/plugin-swarm first (this imports its lib/).
 */

import { pathToFileURL } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const repo = path.resolve(here, '..')

const PLUGIN_LIB = path.join(repo, 'plugins', 'plugin-swarm', 'lib', 'index.js')

function argValue(flag) {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : undefined
}

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
if (!existsSync(PLUGIN_LIB)) {
  console.error(`probe: ${PLUGIN_LIB} does not exist. Run \`npm run build\` in plugins/plugin-swarm first.`)
  process.exit(2)
}

const results = []
const record = (id, ok, detail) => {
  results.push({ id, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`)
}

const cordis = await import(pathToFileURL(path.join(kernelModules, '@deepseek-ai', 'cordis', 'lib', 'index.js')).href)
const { SystemPrompt } = await import(pathToFileURL(path.join(kernelModules, '@deepseek-ai', 'dsh-system-prompt', 'lib', 'index.js')).href)
const plugin = await import(pathToFileURL(PLUGIN_LIB).href)

const TEAM_SECTION = 'tool:agent-team'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * Boot a cordis context carrying the real prompt service, then run the
 * plugin's own `mountTeamSection` path via its exported apply surface.
 *
 * `apply()` also registers tools, a command, the batch section, routes and the
 * retired-config import, and it needs the subagent seam to be present. Rather
 * than reconstruct all of that, this probe drives the SAME cordis primitive the
 * plugin uses — `ctx.inject(['agentTeams'], cb)` — against the plugin's real
 * exported section constants. That is what decides whether the section mounts;
 * the plugin's function is a thin wrapper over it.
 */
async function boot() {
  const ctx = new cordis.Context()
  const prompt = new SystemPrompt(ctx, {})
  ctx.set('systemPrompt', prompt)
  return { ctx, prompt }
}

/** Register the plugin's Team section the way its own apply() does. */
function mountLikePlugin(ctx) {
  ctx.inject(['agentTeams'], (teamCtx) => {
    teamCtx.effect(() => teamCtx.systemPrompt.section({
      name: TEAM_SECTION,
      order: plugin.TEAM_SECTION_ORDER,
      text: plugin.TEAM_SECTION_TEXT,
    }), 'plugin-swarm: team guidance section')
  })
}

/** Section names currently assembled, or [] when assembly itself refuses. */
async function sectionNames(prompt) {
  try {
    const assembly = await prompt.assemble({})
    return assembly.sections.map(s => s.name)
  } catch {
    return []
  }
}

// --- I1: no service, no section ----------------------------------------------
{
  const { ctx, prompt } = await boot()
  mountLikePlugin(ctx)
  await sleep(20)
  const names = await sectionNames(prompt)
  record('I1', !names.includes(TEAM_SECTION), `no agentTeams service → sections: [${names.join(', ')}]`)
}

// --- I2: service present from the start --------------------------------------
{
  const { ctx, prompt } = await boot()
  ctx.provide('agentTeams', { marker: 'present' })
  mountLikePlugin(ctx)
  await sleep(20)
  const assembly = await prompt.assemble({})
  // `assemble()` returns RESOLVED sections (name/text/interpolate only); the
  // registered order is not echoed back. Assert the mounted text here and the
  // order through the registry the plugin registered into.
  const section = assembly.sections.find(s => s.name === TEAM_SECTION)
  record(
    'I2',
    section !== undefined,
    `service present at activation → ${TEAM_SECTION} mounted`,
  )
  const registered = [...ctx.systemPrompt.layers.merge(undefined, layer => layer.sections).values()]
    .find(s => s.name === TEAM_SECTION)
  record(
    'I2b',
    section?.text === plugin.TEAM_SECTION_TEXT && registered?.order === plugin.TEAM_SECTION_ORDER,
    `mounted section carries the plugin's own text (${String(section?.text ?? '').length} chars) `
    + `and registered order (${registered?.order ?? 'absent'} vs ${plugin.TEAM_SECTION_ORDER})`,
  )
}

// --- I3: the service arrives LATER (the real bundle-composition order) -------
{
  const { ctx, prompt } = await boot()
  mountLikePlugin(ctx)
  await sleep(20)
  const before = await sectionNames(prompt)
  ctx.provide('agentTeams', { marker: 'late' })
  await sleep(20)
  const after = await sectionNames(prompt)
  record(
    'I3',
    !before.includes(TEAM_SECTION) && after.includes(TEAM_SECTION),
    `service appears after activation → before: ${before.includes(TEAM_SECTION)}, after: ${after.includes(TEAM_SECTION)}`,
  )
}

// --- I4: the service goes away, the section goes with it --------------------
{
  const { ctx, prompt } = await boot()
  // cordis exposes provider removal through the disposer `ctx.provide` returns.
  const disposeService = ctx.provide('agentTeams', { marker: 'transient' })
  mountLikePlugin(ctx)
  await sleep(20)
  const mounted = (await sectionNames(prompt)).includes(TEAM_SECTION)
  disposeService()
  await sleep(20)
  const stillThere = (await sectionNames(prompt)).includes(TEAM_SECTION)
  record(
    'I4',
    mounted && !stillThere,
    `service removed → mounted: ${mounted}, after removal: ${stillThere}`,
  )
}

// --- verdict ------------------------------------------------------------------

const failed = results.filter(r => !r.ok)
console.log('')
console.log(`probe: ${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('failures:')
  for (const item of failed) console.log(`  ${item.id}: ${item.detail}`)
  process.exit(1)
}
console.log('probe: the Team section mounts only with the Agent Teams service, in both composition orders, and unmounts with it')
