/**
 * The market's write half: the three install/uninstall tools, their argument
 * validation, and the refusal shape.
 *
 * What these pin: a bad argument becomes a coded refusal rather than a throw,
 * the skill path resolves `$DSH_HOME` at CALL time (so a test's temp home is
 * honoured), an already-installed plugin name is refused WITHOUT reaching the
 * executor (this tool never replaces — the panel owns that, with a human
 * confirmation), a plugin install refuses rather than throwing when the
 * executor fails, and the registration really puts all three names on the
 * context.
 *
 * The truly destructive paths (the CLI run, the zip download) are not
 * exercised — their own suites cover them; here the point is the decision
 * layer around them.
 *
 * @module plugin-market/tests/bridge-install
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { PluginInstaller } from '../src/installer.ts'
import {
  INSTALL_TOOL_NAMES,
  installPluginByName,
  installSkillBySlug,
  registerMarketInstallTools,
  skillsDirOf,
  uninstallSkillBySlug,
} from '../src/bridge-install.ts'

let home: string
let previousHome: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-market-install-'))
  previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
})
afterEach(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

/** A minimal tool registrar capturing definitions as they register. */
function stubCtx(): { ctx: never, tools: Map<string, unknown> } {
  const tools = new Map<string, unknown>()
  const ctx = {
    tools: {
      register(definition: { name: string }): () => void {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }
  return { ctx: ctx as never, tools }
}

/** An installer stand-in whose install() answers whatever the script says. */
function stubInstaller(behaviour: { result?: unknown, error?: unknown }): PluginInstaller {
  return {
    install: async () => {
      if (behaviour.error !== undefined) throw behaviour.error
      return behaviour.result
    },
  } as unknown as PluginInstaller
}

describe('skillsDirOf', () => {
  it('resolves $DSH_HOME at call time, not at import time', () => {
    assert.equal(skillsDirOf(), join(home, 'skills'))
  })
})

describe('installSkillBySlug', () => {
  it('refuses a malformed slug without touching the filesystem', async () => {
    const result = await installSkillBySlug('../../etc/passwd')
    assert.equal(result.ok, false)
    assert.equal(result.kind, 'skill')
    assert.equal(result.installed, false)
    assert.equal(result.restartHint, false)
    assert.equal(result.code, 'skill.badSlug')
  })

  it('refuses an empty or non-string slug with the same coded shape', async () => {
    for (const value of ['', '   ', undefined, 42, {}]) {
      const result = await installSkillBySlug(value)
      assert.equal(result.ok, false)
      assert.equal(result.code, 'skill.badSlug', `slug ${JSON.stringify(value)}`)
    }
  })
})

describe('uninstallSkillBySlug', () => {
  it('removes a real installed skill directory', async () => {
    const dir = join(home, 'skills', 'demo-skill')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '# demo\n', 'utf8')

    const result = await uninstallSkillBySlug('demo-skill')
    assert.equal(result.ok, true)
    assert.equal(result.installed, false)
    assert.equal(result.restartHint, true)
  })

  it('refuses a traversing slug', async () => {
    const result = await uninstallSkillBySlug('../secrets')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'skill.badSlug')
  })
})

describe('installPluginByName', () => {
  /** A profile manifest declaring these dependencies (empty = nothing installed). */
  function profileWith(dependencies: Record<string, string>): void {
    const dir = join(home, 'profiles', 'dsh-app')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', dependencies }), 'utf8')
  }

  it('reports a clean install with its output and restart hint', async () => {
    profileWith({})
    const installer = stubInstaller({ result: { version: '1.2.3', output: 'Done in 2s\n' } })
    const result = await installPluginByName(installer, 'dsh-app', 'dsh-remote')
    assert.deepEqual(result, {
      ok: true,
      kind: 'plugin',
      id: 'dsh-remote',
      installed: true,
      restartHint: true,
      output: 'Done in 2s\n',
    })
  })

  it('carries blocked build scripts through for the allow-and-retry path', async () => {
    profileWith({})
    const installer = stubInstaller({ result: { version: '1.2.3', output: 'x', blockedBuilds: ['esbuild'] } })
    const result = await installPluginByName(installer, 'dsh-app', 'dsh-remote')
    assert.deepEqual(result.blockedBuilds, ['esbuild'])
  })

  it('refuses an invalid package name before the executor is reached', async () => {
    profileWith({})
    let called = false
    const installer = {
      install: async () => { called = true; return { version: '1.0.0', output: '' } },
    } as unknown as PluginInstaller
    const result = await installPluginByName(installer, 'dsh-app', '../evil')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'pkg.invalid')
    assert.equal(called, false, 'the executor must never see an unvalidated name')
  })

  it('refuses an already-installed name WITHOUT reaching the executor', async () => {
    // The whole point: the panel may replace with a human confirmation, this
    // tool never replaces. A local dev copy is exactly what must not be lost.
    profileWith({ 'dsh-remote': 'file:./local-remote' })
    let called = false
    const installer = {
      install: async () => { called = true; return { version: '1.0.0', output: '' } },
    } as unknown as PluginInstaller
    const result = await installPluginByName(installer, 'dsh-app', 'dsh-remote')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'install.alreadyInstalled')
    assert.equal(result.installed, false)
    assert.equal(called, false, 'an existing install must never be replaced by this tool')
    assert.match(result.reason!, /already installed/)
  })

  it('turns an executor failure into a refusal rather than a throw', async () => {
    profileWith({})
    const installer = stubInstaller({ error: new Error('pnpm exited 1') })
    const result = await installPluginByName(installer, 'dsh-app', 'dsh-remote')
    assert.equal(result.ok, false)
    assert.equal(result.id, 'dsh-remote')
    assert.match(result.reason!, /pnpm exited 1/)
  })
})

describe('registerMarketInstallTools', () => {
  it('registers all three write tools and disposes them', () => {
    const { ctx, tools } = stubCtx()
    const dispose = registerMarketInstallTools(ctx, { installer: stubInstaller({ result: {} }), profile: 'dsh-app' })
    assert.deepEqual([...tools.keys()].sort(), [...INSTALL_TOOL_NAMES].sort())
    dispose()
    assert.equal(tools.size, 0)
  })
})
