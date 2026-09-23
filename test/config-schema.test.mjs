// The profile's static composition check, run from the diagnostics page.
//
// Two things are worth a test here, and they are different in kind:
//
//   1. ATTRIBUTION. The kernel's checker reports diagnostics for rows it did not
//      write, and on 0.1.7 a completely stock profile already reports four
//      errors and one warning of its own (measured: a fresh profile under a
//      throwaway $DSH_HOME, no suite rows, no user patch, same five lines). So
//      the raw error count says nothing about THIS app; the report has to say
//      which findings sit on a row the suite owns. Getting that backwards is
//      the failure that matters — it sends a reader hunting through our plugins
//      for a defect the kernel ships with.
//   2. THE SHAPE OF A FAILED RUN. An empty report renders as "all clear", so a
//      run that produced no document must be an ERROR, never a green result.
//      The stub spawns below produce exactly that: no output, output that is
//      not JSON, and a document that is JSON but not a dump.
//
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { attributeDiagnostics, checkConfigSchema, parseDump } = require('../dist/main/config-schema.js')

/** A dump shaped like the kernel's, with the rows the diagnostics point at. */
function dumpWith(diagnostics, entries = []) {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    'x-cordis': { profile: 'dsh-app', complete: false, entries, diagnostics, patchSchema: '#/$defs/patch' },
  }
}

/** The stock rows the kernel's own checker complains about, plus one of ours. */
const STOCK_ROWS = [
  { path: '/173', id: 'preset-standard', name: '@deepseek-ai/dsh-agent-preset', status: 'schema' },
  { path: '/174', id: 'preset-ptc', name: '@deepseek-ai/dsh-agent-preset', status: 'schema' },
  { path: '/182', id: 'dsh-context', name: 'dsh-context', status: 'unsupported' },
  { path: '/190', id: 'dsh-app-brand', name: '@dsh-app/plugin-brand', status: 'unsupported' },
]

test('a diagnostic is attributed to the row it points at, and ours is marked ours', () => {
  const dump = dumpWith([
    { level: 'error', path: '/173', message: 'unrecognized Loader tree carrier; use cordis:group or cordis:include for native child collection' },
    { level: 'error', path: '/182', message: 'Config is not a native Schemastery schema' },
    { level: 'error', path: '/190', message: 'Config is not a native Schemastery schema' },
    { level: 'warning', path: '/108', message: 'config/contactFormUrl: regular-expression syntax or Unicode semantics require native validation' },
  ], STOCK_ROWS)
  const report = attributeDiagnostics(dump, ['@dsh-app/'])
  assert.equal(report.profile, 'dsh-app')
  assert.equal(report.complete, false)
  assert.equal(report.entries, 4)
  // The kernel's own rows and a third-party row are reported, not hidden: they
  // are real findings about the running app, they are just not ours to fix.
  assert.deepEqual(report.diagnostics.map(item => item.ours), [false, false, true, false])
  assert.equal(report.ours, 1)
  assert.equal(report.others, 3)
  assert.equal(report.diagnostics[2].entryId, 'dsh-app-brand')
  assert.equal(report.diagnostics[2].entryName, '@dsh-app/plugin-brand')
  assert.equal(report.diagnostics[2].status, 'unsupported')
  assert.equal(report.diagnostics[3].level, 'warning')
})

test('a pointer with no row behind it is still reported, with no id', () => {
  // The pointer index and the entry list are separate fields; a dump whose
  // entries were trimmed must not lose the finding.
  const report = attributeDiagnostics(dumpWith([{ level: 'error', path: '/999', message: 'orphan' }]), ['@dsh-app/'])
  assert.equal(report.diagnostics.length, 1)
  assert.equal(report.diagnostics[0].entryId, undefined)
  assert.equal(report.diagnostics[0].ours, false)
  assert.equal(report.others, 1)
})

test('a document that is not a dump is refused rather than read as empty', () => {
  // Each of these would render as a green page if the reader were lenient.
  for (const value of [null, 42, 'text', {}, { 'x-cordis': {} }, { 'x-cordis': { entries: [], diagnostics: 'no' } }]) {
    assert.equal(attributeDiagnostics(value, ['@dsh-app/']), null, JSON.stringify(value))
  }
})

test('parseDump finds the document after the diagnostic lines the kernel prints first', () => {
  const output = [
    'dsh: warning: [/108] config/contactFormUrl: needs native validation',
    'dsh: error: [/173] unrecognized Loader tree carrier',
    '{"$schema":"x","x-cordis":{"profile":"dsh-app","complete":false,"entries":[],"diagnostics":[]}}',
  ].join('\n')
  assert.deepEqual(parseDump(output), { $schema: 'x', 'x-cordis': { profile: 'dsh-app', complete: false, entries: [], diagnostics: [] } })
  // No document at all, and a truncated one: both are null, so the caller
  // reports the run's failure instead of inventing an empty report.
  assert.equal(parseDump('dsh: error: something went wrong'), null)
  assert.equal(parseDump('{"x-cordis":'), null)
})

/** A stub child process: the shape `spawn` returns, driven by the test. */
function stubChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => {}
  return child
}

/** A spawn stub that emits `stdout`, `stderr` then closes with `code`. */
function spawnStub({ stdout = '', stderr = '', code = 1 }) {
  const seen = { argv: null, options: null }
  const spawnImpl = (node, argv, options) => {
    seen.argv = argv
    seen.options = options
    const child = stubChild()
    queueMicrotask(() => {
      if (stdout !== '') child.stdout.emit('data', Buffer.from(stdout, 'utf8'))
      if (stderr !== '') child.stderr.emit('data', Buffer.from(stderr, 'utf8'))
      child.emit('close', code)
    })
    return child
  }
  return { spawnImpl, seen }
}

const BASE = {
  bin: 'C:/kernel/app/node_modules/@deepseek-ai/dsh/lib/bin.js',
  node: 'C:/kernel/node/node.exe',
  profileName: 'dsh-app',
  dshHome: 'C:/home',
  suitePrefixes: ['@dsh-app/'],
}

test('the checker runs the kernel CLI for the profile, with DSH_HOME pinned', async () => {
  const { spawnImpl, seen } = spawnStub({
    stdout: JSON.stringify(dumpWith([{ level: 'error', path: '/190', message: 'x' }], STOCK_ROWS)),
    code: 1,
  })
  const report = await checkConfigSchema({ ...BASE, spawnImpl })
  assert.deepEqual(seen.argv, [BASE.bin, '--profile', 'dsh-app', '--dump-config-schema'])
  // The CLI resolves --profile through $DSH_HOME, so an inherited value could
  // check a different profile and report its verdict as this one's.
  assert.equal(seen.options.env.DSH_HOME, BASE.dshHome)
  // The shell has no console: without this a terminal flashes over the user's
  // work on Windows (the repository rule about probes inside Electron).
  assert.equal(seen.options.windowsHide, true)
  assert.equal(report.ours, 1)
  // A non-zero exit with a usable document is still a report: the checker
  // signals "there were errors" through its exit code, which is not a failure
  // of the RUN.
  assert.equal(report.diagnostics.length, 1)
})

test('the diagnostics on stderr do not corrupt the document on stdout', async () => {
  // The regression this locks: stdout and stderr used to be concatenated before
  // parsing, so the moment the kernel printed one diagnostic the document was
  // followed by text and JSON.parse failed with "Unexpected non-whitespace
  // character after JSON". Measured against the real CLI on 0.1.7, which always
  // prints at least the stock warning — a stub with empty stderr never saw it.
  const { spawnImpl } = spawnStub({
    stdout: JSON.stringify(dumpWith([{ level: 'error', path: '/190', message: 'x' }], STOCK_ROWS)),
    stderr: 'dsh: warning: [/108] config/contactFormUrl: needs native validation\ndsh: error: [/173] unrecognized Loader tree carrier\n',
    code: 1,
  })
  const report = await checkConfigSchema({ ...BASE, spawnImpl })
  assert.equal(report.diagnostics.length, 1, 'the document parsed despite the diagnostic lines')
  assert.equal(report.ours, 1)
})

test('a run that produced no usable document is an error, never an empty report', async () => {
  const cases = [
    { label: 'no output', stdout: '', stderr: '', code: 1 },
    { label: 'diagnostics only', stdout: '', stderr: 'dsh: error: [/173] nope', code: 1 },
    { label: 'truncated document', stdout: '{"x-cordis":', stderr: '', code: 0 },
    { label: 'a document that is not a dump', stdout: '{"hello":"world"}', stderr: '', code: 0 },
  ]
  for (const item of cases) {
    const { spawnImpl } = spawnStub(item)
    await assert.rejects(checkConfigSchema({ ...BASE, spawnImpl }), /config check/u, item.label)
  }
})

test('a checker that cannot start, and one that never finishes, both fail loudly', async () => {
  const failing = () => { throw new Error('spawn ENOENT') }
  await assert.rejects(checkConfigSchema({ ...BASE, spawnImpl: failing }), /could not start/u)

  // The timeout path: the child never closes, so the cap has to settle it.
  const spawnImpl = () => stubChild()
  await assert.rejects(checkConfigSchema({ ...BASE, spawnImpl, timeoutMs: 20 }), /timed out/u)
})
