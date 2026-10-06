/**
 * The market's install tools: the write half of the bridge.
 *
 * A user who has been shown search results can name one and have it installed
 * in the same conversation, which is the whole point — the panel's own click
 * is the other way, not the only way. Every tool here is thin: it validates its
 * input and hands off to the SAME executors the panel uses, so an install from
 * the conversation and an install from the drawer are one path with one set of
 * checks:
 *
 *   - a plugin install resolves the exact version from the registry, refuses a
 *     name that is already installed, and goes through the serialized CLI
 *     executor (installer.ts) — so it can never run beside a panel action,
 *     and it targets the profile the app actually boots;
 *   - a skill install is the same zip download, SKILL.md check and atomic
 *     rename into `$DSH_HOME/skills` the panel's button performs.
 *
 * A refusal is a coded value, never a thrown error: the model reads the code
 * and the reason and tells the user what happened.
 *
 * @module @dsh-app/plugin-market/bridge-install
 */

import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { MarketExecutionError, MarketValidationError } from './errors.ts'
import type { PluginInstaller } from './installer.ts'
import { validatePackageName } from './npm.ts'
import { readInstalled } from './routes.ts'
import { installSkill, parseSkillSlug, uninstallSkill } from './skills.ts'

/**
 * What an install tool answers with, on success and on refusal alike.
 *
 * A TYPE ALIAS rather than an interface on purpose: `JsonValue` is an
 * index-signature type, and TypeScript grants an implicit index signature to
 * an object-literal alias but never to an interface — so only this form
 * assigns without an `as unknown as` escape (which the suite ratchets).
 */
type InstallOutcome = {
  readonly ok: boolean
  readonly kind: 'skill' | 'plugin'
  readonly id: string
  /** True only when this call performed the write. */
  readonly installed: boolean
  /** True when the kernel needs a restart before the thing is usable. */
  readonly restartHint: boolean
  /** Coded refusal, when `ok` is false. */
  readonly code?: string
  /** English diagnostic for a refusal (never model-facing prose). */
  readonly reason?: string
  /** CLI output tail (plugins only; the panel shows the same text). */
  readonly output?: string
  /** Build scripts pnpm skipped — the same allow-and-retry path the panel offers. */
  readonly blockedBuilds?: string[]
}

/** The skills directory every half of the market installs into. */
export function skillsDirOf(): string {
  return join(resolveDshHome(), 'skills')
}

/**
 * The coded refusal of a thrown value, when it carries one. Both market error
 * classes expose the same `host` shape, so a caller never has to know which
 * one it caught.
 */
function refusalCodeOf(cause: unknown): string | undefined {
  if (cause instanceof MarketValidationError) return cause.host.code
  if (cause instanceof MarketExecutionError) return cause.host.code
  return undefined
}

/**
 * The refusal shape every tool answers with — one place, so the three tools
 * cannot drift apart on what a failed call looks like.
 */
function refusalOf(kind: 'skill' | 'plugin', id: string, cause: unknown): InstallOutcome {
  const code = refusalCodeOf(cause)
  return {
    ok: false,
    kind,
    id,
    installed: false,
    restartHint: false,
    ...(code !== undefined ? { code } : {}),
    reason: cause instanceof Error ? cause.message : String(cause),
  }
}

/**
 * One skill install, from a raw slug to an outcome. Exported so the decision
 * (validation, the refusal shape) is testable without the network.
 *
 * The directory is resolved fresh on every call: `$DSH_HOME` is read at call
 * time, never captured at registration, so a test that pins a temp home sees
 * the install land there.
 *
 * @param slug - the caller's raw slug.
 * @returns the outcome; a refusal is returned, never thrown.
 */
export async function installSkillBySlug(slug: unknown): Promise<InstallOutcome> {
  const raw = typeof slug === 'string' ? slug.trim() : ''
  try {
    const id = parseSkillSlug(raw)
    await installSkill(skillsDirOf(), id)
    return { ok: true, kind: 'skill', id, installed: true, restartHint: true }
  } catch (cause: unknown) {
    return refusalOf('skill', raw, cause)
  }
}

/**
 * One skill uninstall. The slug is validated the same way, so a caller can
 * never name a path outside the skills root.
 * @param slug - the caller's raw slug.
 * @returns the outcome; a refusal is returned, never thrown.
 */
export async function uninstallSkillBySlug(slug: unknown): Promise<InstallOutcome> {
  const raw = typeof slug === 'string' ? slug.trim() : ''
  try {
    const id = parseSkillSlug(raw)
    await uninstallSkill(skillsDirOf(), id)
    return { ok: true, kind: 'skill', id, installed: false, restartHint: true }
  } catch (cause: unknown) {
    return refusalOf('skill', raw, cause)
  }
}

/**
 * One plugin install, over the panel's own executor: registry-resolved exact
 * version, serialized CLI run.
 *
 * The same-name check the panel applies runs here first, and it is STRICTER
 * than the panel's: the panel may replace an existing install once a human
 * confirms, while this tool never replaces anything. A name that is already
 * installed — whatever its origin — is refused with both the installed
 * version and origin named, so the model tells the user "already installed"
 * instead of silently overwriting a local or Git development copy.
 *
 * @param installer - the serialized executor bound to the booted profile.
 * @param profile - the profile whose manifest backs the installed check.
 * @param pkg - the caller's raw package name.
 * @returns the outcome; a refusal is returned, never thrown.
 */
export async function installPluginByName(
  installer: PluginInstaller,
  profile: string,
  pkg: unknown,
): Promise<InstallOutcome> {
  const raw = typeof pkg === 'string' ? pkg.trim() : ''
  try {
    const name = validatePackageName(raw)
    const profileDir = join(resolveDshHome(), 'profiles', profile)
    const current = readInstalled(profileDir, profile).packages.find(pkg => pkg.name === name)
    if (current !== undefined) {
      return {
        ok: false,
        kind: 'plugin',
        id: name,
        installed: false,
        restartHint: false,
        code: 'install.alreadyInstalled',
        reason: `"${name}" is already installed (version ${current.version}, source ${current.source}`
          + `${current.repoKey !== undefined ? `, repo ${current.repoKey}` : ''}); this tool never replaces an `
          + 'existing install — the market panel offers that, with a confirmation',
      }
    }
    const result = await installer.install(name)
    return {
      ok: true,
      kind: 'plugin',
      id: name,
      installed: true,
      restartHint: true,
      output: result.output,
      ...(result.blockedBuilds !== undefined ? { blockedBuilds: [...result.blockedBuilds] } : {}),
    }
  } catch (cause: unknown) {
    return refusalOf('plugin', raw, cause)
  }
}

/** Plain-JSON rendering shared by every install tool. */
function renderOutcome(value: unknown): { type: 'text', text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** The tool output declaration every install tool shares. */
const OUTCOME_OUTPUT = {
  schema: { type: 'json' },
  render: (_args: unknown, value: unknown) => renderOutcome(value),
} satisfies {
  schema: { type: 'json' }
  render(args: unknown, value: unknown): { type: 'text', text: string }[]
}

/** What one install tool needs from its host. */
export interface MarketInstallDeps {
  /** The serialized executor bound to the booted profile. */
  readonly installer: PluginInstaller
  /** Profile name whose manifest backs the already-installed check. */
  readonly profile: string
}

/** The install/uninstall tool names, exported for the roster test. */
export const INSTALL_TOOL_NAMES = ['market_install_skill', 'market_uninstall_skill', 'market_install_plugin'] as const

/**
 * Register the three write tools.
 *
 * The descriptions carry the confirmation rule, because that rule is a
 * PROMPT contract rather than something the code can enforce: an install is
 * the user's decision, and the model is told to place it only after the user
 * has named what to install. The tools still validate every argument as if
 * they were called directly.
 *
 * @param ctx - the host plugin context (must expose `tools`).
 * @param deps - collaborators (the serialized installer).
 * @returns disposer removing every registration.
 */
export function registerMarketInstallTools(ctx: { tools: { register(definition: unknown): () => void } }, deps: MarketInstallDeps): () => void {
  const disposers: Array<() => void> = []

  disposers.push(ctx.tools.register(defineTool({
    name: 'market_install_skill',
    description: 'Install a skill from the skill catalog into this machine, so the agent can use it in later turns. Call this ONLY after the user has chosen a skill — name the exact slug you are about to install in your reply and act on their instruction, never on your own judgement. Pass the slug `market_search` returned. It does not print commands; report the outcome in one short sentence.',
    parameters: {
      slug: {
        type: 'string',
        required: true,
        description: 'The skill slug from market_search results, e.g. "ppt-generator-skill".',
      },
    },
    output: OUTCOME_OUTPUT,
    async execute(args: Record<string, unknown>): Promise<JsonValue> {
      return await installSkillBySlug(args.slug)
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'market_uninstall_skill',
    description: 'Remove a locally installed skill by slug. Call this only when the user asks for a skill to be removed. It deletes that skill\u2019s directory under the skills root; pass the slug exactly as it was installed.',
    parameters: {
      slug: {
        type: 'string',
        required: true,
        description: 'The installed skill slug (as shown in market_search results or the market panel).',
      },
    },
    output: OUTCOME_OUTPUT,
    async execute(args: Record<string, unknown>): Promise<JsonValue> {
      return await uninstallSkillBySlug(args.slug)
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'market_install_plugin',
    description: 'Install a dsh plugin from the plugin catalog into the profile this app boots. Call this ONLY after the user has chosen a plugin — name the exact package you are about to install in your reply and act on their instruction. Pass the npm package name `market_search` returned. It refuses when a plugin of that name is already installed, whatever its origin, instead of replacing it — installing over an existing copy is the market panel\u2019s job, where a confirmation is shown. A successful install needs a restart to take effect; say so in one short sentence.',
    parameters: {
      package: {
        type: 'string',
        required: true,
        description: 'The npm package name from market_search results, e.g. "dsh-remote" or "@scope/dsh-plugin".',
      },
    },
    output: OUTCOME_OUTPUT,
    async execute(args: Record<string, unknown>): Promise<JsonValue> {
      return await installPluginByName(deps.installer, deps.profile, args.package)
    },
  })))

  return () => {
    for (const dispose of disposers) dispose()
  }
}
