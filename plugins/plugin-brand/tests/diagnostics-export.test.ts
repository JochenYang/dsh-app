/**
 * Wire-level suite for plugin-brand's diagnostics FACT route.
 *
 * The route is dispatched through the Connection exact-Fetch harness (see
 * `./host-harness.ts`) and reads a real log file from a temp directory, so the
 * allowlist and the log-section shapes are exercised on the request objects a
 * route sees rather than by calling a builder directly.
 *
 * The host no longer assembles the package: it publishes the FACTS and the page
 * renders them in the UI's own language (`plugin-client-ui/src/client/diagnostics/report.ts`).
 * The SAVE path therefore left this route — it is `/desktop/save-text-as`, whose
 * forwarding, cancelled dialog, unsupported shell, coded failures and input
 * validation are covered by `desktop-routes.test.ts`. What is asserted here is
 * what this route alone decides: which facts travel, and that an absent value
 * travels as an ABSENT value rather than as a word the host invented (the page
 * owns "unknown" too).
 *
 * Tests in one file run sequentially, so the shared `process.env` variables are
 * safe; each test sets what it needs and the module restores everything at the
 * end. No assertion ever prints the token value.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { SHELL_ACTIONS_ENV } from '../src/shell-actions.ts'
import {
  exportFileName,
  KERNEL_CHANNEL_ENV,
  KERNEL_VERSION_ENV,
  SHELL_VERSION_ENV,
} from '../src/diagnostics-facts.ts'
import { LOG_DIR_ENV } from '../src/log-tail.ts'
import { ROUTE_PREFIX, UNSUPPORTED_HOST } from '../src/routes.ts'
import { startHost, type Host, type JsonAnswer } from './host-harness.ts'

/**
 * The unsupported answer's body, in the coded shape: the client renders
 * `route.unsupported` in its own language, and `error` repeats the host's
 * English diagnostic for a reader that does not know the code.
 */
const UNSUPPORTED_BODY = { ok: false, unsupported: true, error: UNSUPPORTED_HOST.text, host: UNSUPPORTED_HOST }

/** How `src/main/server.ts` names its log files (the name sorts chronologically). */
const LOG_NAME = 'dsh-server-2030-01-01T00-00-00-000Z.log'

/** Distinctive tail lines, so "the payload carried the log" is not a guess. */
const TAIL_MARKERS = ['日志尾标记一', '日志尾标记二']

/** Every variable this suite writes; the original values come back in `after`. */
const WATCHED_ENV = [
  SHELL_ACTIONS_ENV,
  LOG_DIR_ENV,
  SHELL_VERSION_ENV,
  KERNEL_VERSION_ENV,
  KERNEL_CHANNEL_ENV,
] as const

const savedEnv = new Map<string, string | undefined>(
  WATCHED_ENV.map((name): [string, string | undefined] => [name, process.env[name]]),
)

const tempDirs: string[] = []

after(async () => {
  for (const name of WATCHED_ENV) {
    const value = savedEnv.get(name)
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true })
  tempDirs.length = 0
})

/** A fresh temp directory, removed when the suite ends. */
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/**
 * Publish the shell's action route the way the shell does.
 *
 * The route only asks WHETHER such a route exists on this path (the write
 * happens in the page, through `/desktop/save-text-as` and then the shell), so
 * a base URL that is never dialled is enough — and this value is exactly what
 * must never appear in a payload.
 */
function publishBridge(): void {
  process.env[SHELL_ACTIONS_ENV] = 'dsh-app://app/__dsh-app/action'
}

/** Simulate a run with no such route (a bare `dsh`, or an older shell). */
function unsetBridge(): void {
  delete process.env[SHELL_ACTIONS_ENV]
}

/** A log directory holding one server log, plus the versions the shell publishes. */
async function publishEnv(logDir: string | null): Promise<void> {
  if (logDir === null) {
    delete process.env[LOG_DIR_ENV]
  } else {
    await writeFile(path.join(logDir, LOG_NAME), `${TAIL_MARKERS.join('\n')}\n`)
    process.env[LOG_DIR_ENV] = logDir
  }
  process.env[SHELL_VERSION_ENV] = '0.11.10'
  process.env[KERNEL_VERSION_ENV] = '0.1.5-rc.2'
  process.env[KERNEL_CHANNEL_ENV] = 'beta'
}

/** POST /diagnostics/export through the Connection Fetch harness. */
async function exportFacts(host: Host, headers: Record<string, string> = {}): Promise<JsonAnswer> {
  return host.call(`${ROUTE_PREFIX}/diagnostics/export`, { method: 'POST', headers })
}

test('export publishes the facts the page writes the package from', async () => {
  const logDir = await tempDir('dsh-brand-facts-')
  await publishEnv(logDir)
  publishBridge()
  const host = await startHost()
  try {
    const answer = await exportFacts(host)
    assert.equal(answer.status, 200)
    assert.equal(answer.body.ok, true)
    assert.match(String(answer.body.name), /^dsh-app-diagnostics-\d{8}-\d{4}\.txt$/u)
    assert.equal(Number.isNaN(Date.parse(String(answer.body.generatedAt))), false, 'a parseable stamp travels')
    assert.equal(answer.body.shellVersion, '0.11.10')
    assert.equal(answer.body.kernelVersion, '0.1.5-rc.2')
    assert.equal(answer.body.kernelChannel, 'beta')
    assert.equal(answer.body.logDir, logDir)

    const log = answer.body.log as Record<string, unknown>
    assert.equal(log.kind, 'ok')
    assert.equal(log.file, path.join(logDir, LOG_NAME))
    assert.deepEqual(log.lines, TAIL_MARKERS, 'the tail travels verbatim, in order')

    // The load-bearing privacy claim: nothing on this path reads anything but
    // the allowlist, so the serialized payload cannot contain another
    // environment value (the shell's own action URL included). Asserted rather
    // than argued, and the message never prints the value.
    assert.equal(JSON.stringify(answer.body).includes(process.env[SHELL_ACTIONS_ENV] ?? '\u0000'), false,
      'an unallowlisted environment value is not exportable')
  } finally {
    unsetBridge()
    await host.close()
  }
})

test('exportFileName is a chronological, timestamped name', () => {
  assert.equal(exportFileName(new Date(2026, 1, 5, 14, 3, 9)), 'dsh-app-diagnostics-20260205-1403.txt')
  assert.equal(exportFileName(new Date(2026, 11, 31, 23, 59, 0)), 'dsh-app-diagnostics-20261231-2359.txt')
})

test('a run without the shell variables publishes empty values, not an invented word', async () => {
  await publishEnv(null)
  delete process.env[SHELL_VERSION_ENV]
  delete process.env[KERNEL_VERSION_ENV]
  delete process.env[KERNEL_CHANNEL_ENV]
  publishBridge()
  const host = await startHost()
  try {
    const answer = await exportFacts(host)
    // No log directory is not a failure either: the export is most valuable
    // exactly when the environment is broken.
    assert.equal(answer.status, 200)
    assert.equal(answer.body.ok, true)
    assert.equal(answer.body.shellVersion, '', 'the page renders its own "unknown"')
    assert.equal(answer.body.kernelVersion, '')
    assert.equal(answer.body.kernelChannel, '')
    assert.equal(answer.body.logDir, '')
    assert.equal((answer.body.log as Record<string, unknown>).kind, 'unavailable')
    assert.equal((answer.body.log as Record<string, unknown>).reason, 'unsupported')
  } finally {
    unsetBridge()
    await host.close()
  }
})

test('a log directory holding no kernel log reports the reason, not an error', async () => {
  // An empty directory: no write, just the path the shell published.
  process.env[LOG_DIR_ENV] = await tempDir('dsh-brand-facts-empty-')
  process.env[SHELL_VERSION_ENV] = '0.11.10'
  process.env[KERNEL_VERSION_ENV] = '0.1.5-rc.2'
  process.env[KERNEL_CHANNEL_ENV] = 'beta'
  publishBridge()
  const host = await startHost()
  try {
    const answer = await exportFacts(host)
    assert.equal(answer.status, 200)
    assert.equal((answer.body.log as Record<string, unknown>).kind, 'unavailable')
    assert.equal((answer.body.log as Record<string, unknown>).reason, 'missing')
  } finally {
    unsetBridge()
    await host.close()
  }
})

test('no shell action route answers unsupported, never an error', async () => {
  await publishEnv(await tempDir('dsh-brand-facts-'))
  const host = await startHost()
  unsetBridge()
  try {
    const answer = await exportFacts(host)
    assert.equal(answer.status, 200, 'unsupported is not a failure status')
    assert.deepEqual(answer.body, UNSUPPORTED_BODY)
  } finally {
    await host.close()
  }
})

test('trust is the carrier\'s: a foreign Origin reaches the route unfenced', async () => {
  await publishEnv(await tempDir('dsh-brand-facts-'))
  publishBridge()
  const host = await startHost()
  try {
    // The Connection carrier applies its Host/Origin fence and browser
    // authentication BEFORE a handler runs. A route must not re-check them: on
    // the desktop pipe the URL scheme is `dsh-app://app` and there is no Host
    // header to inspect, so a second fence here would 403 every real request.
    const answer = await exportFacts(host, { origin: 'https://evil.example' })
    assert.equal(answer.status, 200)
    assert.equal(answer.body.ok, true)
  } finally {
    unsetBridge()
    await host.close()
  }
})

test('export answers the channel 404 for a GET (the route is POST only)', async () => {
  await publishEnv(await tempDir('dsh-brand-facts-'))
  const host = await startHost()
  try {
    const answer = await host.call(`${ROUTE_PREFIX}/diagnostics/export`)
    assert.equal(answer.status, 404)
  } finally {
    await host.close()
  }
})
