/**
 * Client entry contract: the PPT capsule lives in exactly one place — the
 * shared office bar injected after the composer card — and the two retired
 * occurrences (the session-header utilities seat and the injected hero row)
 * leave no residue in the source tree or in a built client artifact.
 *
 * The client half imports react/react-dom, which are browser-provided
 * externals (peer dependencies, not installed here), so these assertions read
 * the sources and the bundle instead of importing them; the DOM-free bar rules
 * have their own suite (office-bar), and the capsule's two-state contract and
 * toggle semantics have theirs (capsule-state).
 *
 * @module @dsh-app/plugin-ppt/tests/client-entry
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Every file under src/, as absolute paths. */
function sourceFiles(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const entry = join(dir, name)
      return statSync(entry).isDirectory() ? walk(entry) : [entry]
    })
  return walk(join(pluginRoot, 'src'))
}

test('client entry: the office bar is mounted from the session selection and no retired occurrence is claimed', () => {
  const client = readFileSync(join(pluginRoot, 'src', 'client.ts'), 'utf8')
  assert.match(client, /mountPptOfficeBar\(ctx\.uiSession\.adapter\.current\)/)
  assert.match(client, /export const inject = \['uiSession'\]/)
  assert.doesNotMatch(client, /slots\.register|slots\.inject/)
  assert.doesNotMatch(client, /conversation\.session\.header/)
  assert.doesNotMatch(client, /conversation\.composer\.dock/)
  assert.doesNotMatch(client, /conversation\.hero\.agentPreset/)

  // The only DOM landmark left is the composer card, and the bar carries the
  // suite-wide class the other format plugins look for.
  const bar = readFileSync(join(pluginRoot, 'src', 'client', 'office-bar.ts'), 'utf8')
  assert.match(bar, /COMPOSER_CARD_SELECTOR = 'div\[data-composer-card\]'/)
  assert.match(bar, /OFFICE_BAR_CLASS = 'dshOfficeBar'/)
  assert.match(bar, /new MutationObserver/)

  for (const file of sourceFiles()) {
    const source = readFileSync(file, 'utf8')
    assert.doesNotMatch(source, /conversation\.composer\.dock/, `${file} still names the retired seat`)
    assert.doesNotMatch(source, /conversation\.session\.header/, `${file} still names the retired seat`)
    assert.doesNotMatch(source, /heroWorkspaceRow/, `${file} still points at the retired landmark`)
    assert.doesNotMatch(source, /dshPptHero/, `${file} still names the retired container`)
    // The hero seats are singles the shipped UI already fills: registering one
    // would be permanently shadowed, so no source may claim it.
    assert.doesNotMatch(source, /conversation\.hero\.agentPreset/, `${file} still claims a taken hero seat`)
  }
  assert.doesNotMatch(
    readFileSync(join(pluginRoot, 'package.json'), 'utf8'),
    /conversation header|hero workspace row|composer-dock/,
    'package.json still describes the retired placement',
  )
})

test('client entry: the capsule is one toggle with a dropdown and no launcher path', () => {
  const entry = readFileSync(join(pluginRoot, 'src', 'client', 'ppt-entry.tsx'), 'utf8')
  // Two states: the label expression and the caret both key off the mode.
  assert.match(entry, /state\.label/)
  assert.match(entry, /state\.caret &&/)
  assert.match(entry, /toggle\.enabled/)
  // Unbound decisions park; bound ones persist through the host route.
  assert.match(entry, /pendingTemplate\.set\(/)
  assert.match(entry, /pendingTemplate\.clear\(\)/)
  assert.match(entry, /pptModeApi\.setMode\(sessionId, update\)/)
  assert.match(entry, /pendingTemplate\.consume\(\)/)
  // The suite is mutually exclusive: the capsule stands down when superseded.
  assert.match(entry, /useOfficeSupersede\(/)
  assert.match(entry, /removeSkillReference\(bindingRef\.current\)/)
  // No template is ever seeded by the turn-on itself.
  assert.doesNotMatch(entry, /DEFAULT_PICK|dsh-blue-professional/)
  // The panel keeps the explicit way out.
  assert.match(entry, /关闭 PPT 模式/)
})

test('client entry: the built client artifact mounts into the office bar and carries no retired landing site', () => {
  const artifact = join(pluginRoot, 'lib', 'client.js')
  // lib/ is generated output and absent in a fresh checkout; assert on it
  // only when it exists, so a stale pre-change build still fails loudly.
  if (!existsSync(artifact)) return
  const bundle = readFileSync(artifact, 'utf8')
  assert.match(bundle, /data-composer-card/)
  assert.match(bundle, /dshOfficeBar/)
  assert.match(bundle, /data-office-format/)
  assert.doesNotMatch(bundle, /heroWorkspaceRow/)
  assert.doesNotMatch(bundle, /dshPptHero/)
  assert.doesNotMatch(bundle, /conversation\.session\.header/)
  assert.doesNotMatch(bundle, /conversation\.hero\.agentPreset/)
  assert.doesNotMatch(bundle, /conversation\.composer\.dock/)
})
