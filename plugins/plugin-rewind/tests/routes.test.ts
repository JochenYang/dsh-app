/**
 * Tests for the quarantine routes.
 *
 * The route layer is where a purge request becomes a filesystem delete, so these
 * check the shape of the contract rather than the deletion itself (that lives in
 * `quarantine.test.ts`):
 *
 *   - the paths and methods are the ones the client calls;
 *   - a malformed body is refused with a coded message, never treated as "purge
 *     nothing" (a silent no-op reads as success);
 *   - the request carries NAMES. A body with a path is not a thing this route
 *     accepts, which is what keeps the delete inside the quarantine root — the
 *     same reason `isSafeSegment` refuses a separator.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROUTE_PREFIX, registerQuarantineRoutes } from '../src/routes.ts'
import { quarantineRoot } from '../src/snapshots.ts'

/** One registration, as the fake carrier captured it. */
interface Row {
  readonly path: string
  readonly methods: readonly string[]
  readonly fetch: (request: Request) => Promise<Response>
}

/** Register the routes against a capturing stand-in for the Connection carrier. */
function mount(): { readonly rows: readonly Row[], readonly dispose: () => Promise<void> } {
  const rows: Row[] = []
  const dispose = registerQuarantineRoutes({
    register(options: Row) {
      rows.push(options)
      return async () => {}
    },
  } as never)
  return { rows, dispose }
}

/** One row by its path suffix. */
function row(rows: readonly Row[], suffix: string): Row {
  const found = rows.find((entry) => entry.path.endsWith(suffix))
  assert.ok(found !== undefined, `no route for ${suffix}`)
  return found
}

test('the routes are the ones the client calls', async () => {
  const { rows, dispose } = mount()
  assert.equal(rows.length, 2)
  assert.deepEqual(
    rows.map((entry) => `${entry.methods.join(',')} ${entry.path}`).sort(),
    [
      `GET ${ROUTE_PREFIX}/quarantine`,
      `POST ${ROUTE_PREFIX}/quarantine/purge`,
    ].sort(),
  )
  await dispose()
})

test('a body that is not a target list is refused, never a silent no-op', async () => {
  const { rows, dispose } = mount()
  const purge = row(rows, '/quarantine/purge')
  // Two distinct refusals, both correct: a body that is not JSON at all is a
  // transport-level `badBody`, while well-formed JSON that names no usable target
  // list is `targetsRequired`. Asserting ONE code for both would have let either
  // path silently accept the other's input.
  const cases: readonly { readonly body: string, readonly code: string }[] = [
    { body: 'not json', code: 'rewind.route.badBody' },
    { body: '{}', code: 'rewind.route.targetsRequired' },
    { body: '{"targets":"x"}', code: 'rewind.route.targetsRequired' },
    { body: '{"targets":[{"sessionId":"a"}]}', code: 'rewind.route.targetsRequired' },
    { body: '{"targets":[1]}', code: 'rewind.route.targetsRequired' },
  ]
  for (const { body, code } of cases) {
    const response = await purge.fetch(new Request('http://x/purge', { method: 'POST', body }))
    assert.equal(response.status, 400, `must refuse ${body}`)
    const parsed = await response.json() as { ok: boolean, error?: { host?: { code?: string } } }
    assert.equal(parsed.ok, false)
    assert.equal(parsed.error?.host?.code, code, `wrong refusal code for ${body}`)
  }
  await dispose()
})

test('an empty targets array is a valid no-op, not an error', async () => {
  // The page sends `[]` when nothing is selected; that is a request that is
  // already satisfied, not a malformed one.
  const { rows, dispose } = mount()
  const purge = row(rows, '/quarantine/purge')
  const response = await purge.fetch(new Request('http://x/purge', { method: 'POST', body: '{"targets":[]}' }))
  assert.equal(response.status, 200)
  const parsed = await response.json() as { ok: boolean, value?: { removed: number, requested: number } }
  assert.deepEqual(parsed.value, { removed: 0, failed: [], requested: 0 })
  await dispose()
})

test('the list route answers a real quarantine structure', async () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'rewind-routes-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  try {
    const { rows, dispose } = mount()
    const list = row(rows, '/quarantine')
    // Empty first: the page renders this before anything was ever quarantined.
    const empty = await list.fetch(new Request('http://x/quarantine'))
    assert.equal(empty.status, 200)
    const parsed = await empty.json() as { ok: boolean, value?: { entries: number } }
    assert.equal(parsed.ok, true)
    assert.equal(parsed.value?.entries, 0)

    // Then one slot, placed at the path the host derives.
    const root = quarantineRoot(dshHome, 'session-r')
    mkdirSync(join(root, 'slot-1'), { recursive: true })
    writeFileSync(join(root, 'slot-1', 'replaced'), 'x')
    const after = await list.fetch(new Request('http://x/quarantine'))
    const parsedAfter = await after.json() as { value?: { entries: number } }
    assert.equal(parsedAfter.value?.entries, 1)
    await dispose()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(dshHome, { recursive: true, force: true })
  }
})

test('a purge names a slot and leaves the quarantine root itself', async () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'rewind-routes-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  try {
    const root = quarantineRoot(dshHome, 'session-p')
    mkdirSync(join(root, 'slot-a'), { recursive: true })
    mkdirSync(join(root, 'slot-b'), { recursive: true })
    const { rows, dispose } = mount()
    const purge = row(rows, '/quarantine/purge')
    const response = await purge.fetch(new Request('http://x/purge', {
      method: 'POST',
      body: JSON.stringify({ targets: [{ sessionId: 'session-p', slot: 'slot-a' }] }),
    }))
    assert.equal(response.status, 200)
    const parsed = await response.json() as { value?: { removed: number } }
    assert.equal(parsed.value?.removed, 1)
    assert.deepEqual(readdirSync(root), ['slot-b'], 'only the named slot went')
    await dispose()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(dshHome, { recursive: true, force: true })
  }
})
