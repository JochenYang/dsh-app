/**
 * Write path of the usage plugin's config: the one-time import of the retired
 * JSON store, the validation it applies, and the projection that keeps a write
 * complete. Run via `npm test` (esbuild bundles TS → .test-dist, node --test
 * runs it).
 *
 * The last case drives the real `apply` over a fake host, so the projection is
 * exercised where it is used — under the kernel config editor's change
 * callback, with the plugin's live values in hand.
 *
 * @module @dsh-app/plugin-usage/tests/user-config
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import { apply, type Config } from '../src/index.ts'
import {
  projectUsageConfig,
  readRetiredUsageConfig,
  retireUsageConfigFile,
  USAGE_CONFIG_FIELDS,
  type UsageConfigValues,
} from '../src/user-config.ts'
import type { UsagePrice } from '../src/types.ts'

/** One price row, as a personal gateway user would write it. */
const ROW: UsagePrice = { provider: 'my-gateway', model: 'gpt-x', input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 }

/** A temporary directory of this test's own. */
function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

// --- projectUsageConfig (the projection every write goes through) --------------

/**
 * Values a composing layer sets — a profile row the kernel's editor appended,
 * or a future settings write. The shipped overlay row carries no config for
 * this plugin today, so these stand for every tier that does set one; the
 * projection has to preserve such a value wherever it came from.
 */
const LAYER: UsageConfigValues = { enabled: true, backfillOnStart: false, rescanMinutes: 30, pricing: [ROW] }

/** The effective values here: the layer's, with one knob already customized. */
const EFFECTIVE: UsageConfigValues = { ...LAYER, rescanMinutes: 15 }

test('projectUsageConfig: a one-field write carries every editable field and leaks no schema default', () => {
  const next = projectUsageConfig({}, LAYER, { enabled: false }, EFFECTIVE)
  assert.equal(next.enabled, false, 'the named field takes the written value')
  assert.equal(next.backfillOnStart, false, 'an unnamed field keeps the effective value, not the schema default true')
  assert.equal(next.rescanMinutes, 15, 'nor the schema default 5')
  assert.deepEqual(next.pricing, [ROW], 'nor the schema default [] — a write must not drop the price table')
  for (const field of USAGE_CONFIG_FIELDS) assert.ok(field in next, `${field} must travel with every write`)
})

test('projectUsageConfig: a cleared field returns to the layer value, or to the schema default when no layer sets it', () => {
  const cleared = projectUsageConfig({}, LAYER, { rescanMinutes: null }, EFFECTIVE)
  assert.equal(cleared.rescanMinutes, 30, 'null means "back to the layer value", not "keep the customization"')
  const dropped = projectUsageConfig({}, {}, { enabled: null }, EFFECTIVE)
  assert.ok(!Object.hasOwn(dropped, 'enabled'), 'with no layer value to return to, the schema default is the deployment value')
})

// --- the retired JSON store ----------------------------------------------------

test('readRetiredUsageConfig: a missing, malformed, or partial store degrades to what it can import', () => {
  const dir = tempDir('dshu-read-')
  const warnings: string[] = []
  const log = (message: string): void => { warnings.push(message) }

  assert.equal(readRetiredUsageConfig(join(dir, 'absent.json'), log), undefined, 'no store: nothing to import')

  writeFileSync(join(dir, 'bad.json'), '{not json')
  assert.equal(readRetiredUsageConfig(join(dir, 'bad.json'), log), undefined)
  assert.ok(warnings.some(w => w.includes('unreadable JSON')))

  writeFileSync(join(dir, 'list.json'), '[1, 2]')
  assert.equal(readRetiredUsageConfig(join(dir, 'list.json'), log), undefined)
  assert.ok(warnings.some(w => w.includes('expected a JSON object')))

  writeFileSync(join(dir, 'mixed.json'), JSON.stringify({
    enabled: 'yes',
    pricing: [ROW, { provider: 'no-rates' }],
    // Never read from this file before the migration either (the loader entry
    // carried them), so a value written here is not promoted into the config.
    rescanMinutes: 30,
  }))
  const imported = readRetiredUsageConfig(join(dir, 'mixed.json'), log)
  assert.deepEqual(imported, { pricing: [{ ...ROW, peakFactor: undefined }] }, 'only the retired file\'s own fields, and only its usable rows')
  assert.ok(warnings.some(w => w.includes('"enabled"')), 'a non-boolean exit valve is reported, not imported')
  assert.ok(warnings.some(w => w.includes('malformed pricing row')), 'a row without rates is reported, not imported')

  writeFileSync(join(dir, 'off.json'), JSON.stringify({ enabled: false, pricing: {} }))
  assert.deepEqual(readRetiredUsageConfig(join(dir, 'off.json'), log), { enabled: false })
  assert.ok(warnings.some(w => w.includes('"pricing" must be an array')))
})

test('retireUsageConfigFile: the retired store is renamed aside and kept verbatim', () => {
  const dir = tempDir('dshu-retire-')
  const file = join(dir, 'config.json')
  const raw = '{"enabled": false, "pricing": []}'
  writeFileSync(file, raw, 'utf8')

  const movedTo = retireUsageConfigFile(file)
  assert.ok(movedTo !== undefined, 'the file must be moved aside, never deleted')
  assert.equal(existsSync(file), false, 'the old path is free, so the import cannot run twice')
  assert.equal(readFileSync(movedTo, 'utf8'), raw, "the user's own file survives verbatim")
  assert.equal(retireUsageConfigFile(join(dir, 'gone.json')), undefined, 'a missing file is not an error')
})

// --- the import path, over a fake host -----------------------------------------

/** The loader entry the kernel's config editor addresses for this plugin's row. */
const ENTRY = { id: 'usage', name: '@dsh-app/plugin-usage' }

/** A volatile reference over a fixed value: what a parsed config hands a plugin. */
function fakeRef<T>(value: T): Volatile<T> {
  return { get: () => value } as unknown as Volatile<T>
}

/** What one fake host observed: what `apply` registered, logged and stored. */
interface FakeHost {
  /** What the fake editor's change callback derived, in call order. */
  readonly writes: Record<string, unknown>[]
  /** Registered route paths, in registration order. */
  readonly routePaths: string[]
  readonly infos: string[]
  readonly warnings: string[]
  /** Run every disposer the plugin registered (the rescan timer, the store). */
  dispose(): void
}

/**
 * Run the real `apply` over a fake host.
 *
 * The editor fake mirrors the kernel's: it hands the change callback the raw
 * config the entry carries and the config the layers alone yield, and records
 * what the callback derived — which is what would land in the profile patch.
 */
function applyOverFakeHost(
  storeDir: string,
  values: { enabled: boolean, backfillOnStart: boolean, rescanMinutes: number, pricing: readonly UsagePrice[] },
  options: { editorless?: boolean } = {},
): FakeHost {
  const writes: Record<string, unknown>[] = []
  const routePaths: string[] = []
  const infos: string[] = []
  const warnings: string[] = []
  const disposers: (() => void)[] = []
  const ctx = {
    logger: () => ({
      info: (message: string) => { infos.push(message) },
      warn: (message: string) => { warnings.push(message) },
    }),
    // cordis runs the callback now and keeps its return value as the disposer.
    effect: (callback: () => unknown) => {
      const disposer: unknown = callback()
      disposers.push(typeof disposer === 'function' ? disposer as () => void : () => {})
    },
    on: () => () => {},
    sessionPersistence: {},
    fiber: { entry: ENTRY },
    get: (name: string) => (name === 'configEditor' && options.editorless !== true
      ? {
        edit: async (
          entry: unknown,
          change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
        ) => {
          assert.equal(entry, ENTRY, 'the write must address this plugin\'s own loader entry')
          writes.push(change({}, {}))
        },
      }
      : undefined),
    connection: {
      fetch: {
        // The registry returns its disposer synchronously (its call returns a
        // promise) — the shape `registerUsageRoutes` relies on.
        register: (route: { path: string }) => {
          routePaths.push(route.path)
          return async () => {}
        },
      },
    },
  }
  const baseConfig: Config = {
    storePath: storeDir,
    enabled: fakeRef(values.enabled),
    backfillOnStart: fakeRef(values.backfillOnStart),
    rescanMinutes: fakeRef(values.rescanMinutes),
    pricing: fakeRef([...values.pricing]),
  }
  apply(ctx as unknown as Context, baseConfig)
  return {
    writes,
    routePaths,
    infos,
    warnings,
    dispose: () => { for (const dispose of disposers.splice(0)) dispose() },
  }
}

test('apply: the retired store is imported into a COMPLETE config, then moved aside', async () => {
  const dir = tempDir('dshu-import-')
  const retired = join(dir, 'config.json')
  const raw = JSON.stringify({ enabled: false, pricing: [ROW] })
  writeFileSync(retired, raw, 'utf8')

  // Live values that differ from the schema defaults (backfillOnStart true,
  // rescanMinutes 5, pricing []): a write carrying only what the file fed would
  // fall back to those and silently retune the collector.
  const host = applyOverFakeHost(dir, { enabled: true, backfillOnStart: false, rescanMinutes: 30, pricing: [] })
  // The rescan interval is a real timer: an assertion failure must not leave it
  // running, or the failing run would hang instead of reporting.
  try {
    assert.equal(host.routePaths.length, 4, 'an enabled plugin mounts its four data routes')
    // The import is deferred past activation; its last step frees the old path.
    for (let i = 0; i < 400 && existsSync(retired); i++) await new Promise(resolve => setTimeout(resolve, 5))

    assert.equal(host.writes.length, 1, 'the retired store must be imported exactly once')
    const written = host.writes[0]
    assert.deepEqual(written, {
      enabled: false,
      backfillOnStart: false,
      rescanMinutes: 30,
      pricing: [{ ...ROW, peakFactor: undefined }],
    }, 'the write must carry the imported values AND every field the file did not name')
    for (const field of USAGE_CONFIG_FIELDS) assert.ok(field in written, `${field} must travel with the write`)
    assert.equal(written.enabled, false, 'the imported exit valve wins over the live value')
    assert.equal(written.backfillOnStart, false, 'an unnamed field keeps the effective value, not the schema default true')
    assert.equal(written.rescanMinutes, 30, 'nor the schema default 5')
    assert.deepEqual(host.warnings, [], 'a clean import warns about nothing')

    // The imported file is evidence, not debris: renamed, byte-identical, gone
    // from its old path so the import cannot run twice.
    const kept = readdirSync(dir).filter(name => name.startsWith('config.json.imported-'))
    assert.equal(kept.length, 1, 'the retired file is moved aside under a timestamped name')
    assert.equal(readFileSync(join(dir, kept[0]), 'utf8'), raw, "the user's own file survives verbatim")
    assert.ok(host.infos.some(line => line.includes('kept as')), 'the import reports where the old file went')
  } finally {
    host.dispose()
  }
})

test('apply: a host with no config editor leaves the retired store in place and still starts', async () => {
  const dir = tempDir('dshu-editorless-')
  const retired = join(dir, 'config.json')
  writeFileSync(retired, JSON.stringify({ enabled: false }), 'utf8')
  const host = applyOverFakeHost(dir, { enabled: true, backfillOnStart: false, rescanMinutes: 0, pricing: [] }, { editorless: true })
  try {
    // Wait for the deferred import to have RUN and refused — otherwise the case
    // would pass merely by being too early.
    for (let i = 0; i < 400 && !host.warnings.some(w => w.includes('no configuration editor')); i++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.ok(host.warnings.some(w => w.includes('no configuration editor')), 'the refusal is reported, not silent')
    assert.ok(existsSync(retired), 'an unimportable file is left exactly where it was')
    assert.equal(host.routePaths.length, 4, 'the collector still mounts — a stale file must not fail a start')
  } finally {
    host.dispose()
  }
})
