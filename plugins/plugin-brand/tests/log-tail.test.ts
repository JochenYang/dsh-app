/**
 * Wire-level suite for plugin-brand's diagnostics log-tail route.
 *
 * The route under test is served by a real `node:http` server (see
 * `./host-harness.ts`) and reads real files from a temp directory, so the
 * listing, the backward read and the fences are all exercised end to end.
 *
 * The load-bearing assertion is not the returned text but what it COST: the
 * reader is handed a filesystem seam that counts bytes, and a log far larger
 * than the requested tail must be read as a tail (one chunk) rather than
 * slurped. That is the difference between a diagnostics page and a page that
 * freezes the host process on a 100 MB log.
 *
 * Tests in one file run sequentially, so the shared `process.env` variables are
 * safe; each test restores them.
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { BRIDGE_TOKEN_ENV, BRIDGE_URL_ENV } from '../src/bridge-client.ts'
import { DEFAULT_TAIL_LINES, LOG_DIR_ENV, MAX_TAIL_LINES, parseTailLines, readLogTail, type LogFileHandle, type LogFileIo } from '../src/log-tail.ts'
import { ROUTE_PREFIX, UNSUPPORTED_HOST } from '../src/routes.ts'
import { parseRaw, rawRequest, startHost, type JsonAnswer } from './host-harness.ts'

/**
 * The unsupported answer's body, in the coded shape: the client renders
 * `route.unsupported` in its own language, and `error` repeats the host's
 * English diagnostic for a reader that does not know the code.
 */
const UNSUPPORTED_BODY = { ok: false, unsupported: true, error: UNSUPPORTED_HOST.text, host: UNSUPPORTED_HOST }

/**
 * The coded `host` message of one failure body — asserted to exist, because a
 * failure without one would leave the page with nothing to render.
 * @param body - the route's JSON answer.
 * @returns the host message.
 */
function hostOf(body: Record<string, unknown>): Record<string, unknown> {
  const host = body.host
  assert.equal(typeof host, 'object', 'every failure body carries a coded host message')
  return host as Record<string, unknown>
}

/** How `src/main/server.ts` names its log files (the name sorts chronologically). */
const logName = (stamp: string): string => `dsh-server-${stamp}.log`

const tempDirs: string[] = []

after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true })
  tempDirs.length = 0
})

/** A fresh temp directory, removed when the suite ends. */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-brand-log-tail-'))
  tempDirs.push(dir)
  return dir
}

const savedLogDir = process.env[LOG_DIR_ENV]
const savedBridgeToken = process.env[BRIDGE_TOKEN_ENV]

after(() => {
  if (savedLogDir === undefined) delete process.env[LOG_DIR_ENV]
  else process.env[LOG_DIR_ENV] = savedLogDir
  if (savedBridgeToken === undefined) delete process.env[BRIDGE_TOKEN_ENV]
  else process.env[BRIDGE_TOKEN_ENV] = savedBridgeToken
})

/**
 * A filesystem seam that counts bytes, so "reads only the tail" is measurable
 * rather than asserted from the outside.
 */
function countingIo(): { io: LogFileIo, bytesRead(): number } {
  let total = 0
  // `await import` keeps the real module out of the way of the wrapper below.
  const realOpen = async (file: string): Promise<LogFileHandle> => {
    const { open } = await import('node:fs/promises')
    const handle = await open(file, 'r')
    return {
      stat: async () => ({ size: (await handle.stat()).size }),
      read: async (buffer, offset, length, position) => {
        const result = await handle.read(buffer, offset, length, position)
        total += result.bytesRead
        return { bytesRead: result.bytesRead }
      },
      close: async () => { await handle.close() },
    }
  }
  return { io: { open: realOpen }, bytesRead: () => total }
}

/** GET one path against the real host server. */
async function get(host: { url: string }, pathname: string, headers: Record<string, string> = {}): Promise<JsonAnswer> {
  const response = await fetch(`${host.url}${ROUTE_PREFIX}${pathname}`, { headers })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

/** The `/diagnostics/log-tail` answer, with `lines` optional. */
function tail(host: { url: string }, lines?: string): Promise<JsonAnswer> {
  return get(host, `/diagnostics/log-tail${lines === undefined ? '' : `?lines=${lines}`}`)
}

test('log-tail returns the last N lines of the NEWEST log, reading only the tail', async () => {
  const dir = await tempDir()
  // An older, smaller log that must lose the "newest" comparison.
  await writeFile(path.join(dir, logName('2020-01-01T00-00-00-000Z')), 'stale line\n')
  const newest = path.join(dir, logName('2030-01-01T00-00-00-000Z'))
  // One fluff log file the route must ignore, plus a big leading line that
  // proves the reader enters the file from the end instead of the start.
  await writeFile(path.join(dir, 'other.log'), 'not a server log\n')
  const leading = 'X'.repeat(1_000_000)
  const filler = Array.from({ length: 20_000 }, (_unused, index) => `filler line ${String(index)}`).join('\n')
  await writeFile(newest, `${leading}\n${filler}\n尾行一\n尾行二\n尾行三\n`)

  process.env[LOG_DIR_ENV] = dir
  const host = await startHost()
  try {
    const answer = await tail(host, '3')
    assert.equal(answer.status, 200)
    assert.equal(answer.body.ok, true)
    assert.equal(answer.body.path, newest, 'the newest dsh-server-*.log, not the stale one')
    assert.deepEqual(answer.body.lines, ['尾行一', '尾行二', '尾行三'])
  } finally {
    await host.close()
  }

  // The same read through the seam, which is where the cost is visible.
  const { io, bytesRead } = countingIo()
  const direct = await readLogTail(dir, 3, io)
  assert.deepEqual(direct, { ok: true, file: newest, lines: ['尾行一', '尾行二', '尾行三'] })
  const size = 1_000_000 + filler.length + 40
  // Both bounds matter: > 0 proves the seam was really on the read path (a
  // whole-file read through `readFile` would bypass it and count zero), and the
  // ceiling is what a slurp of the 1.4 MB file could never satisfy.
  assert.ok(bytesRead() > 0, 'the reader must go through the injected seam')
  assert.ok(bytesRead() < 128 * 1024, `expected a tail read, read ${String(bytesRead())} bytes`)
  assert.ok(bytesRead() < size / 4, 'a tail read must not scale with the file size')
})

test('log-tail returns every line when the file is shorter than the request', async () => {
  const dir = await tempDir()
  await writeFile(path.join(dir, logName('2030-01-01T00-00-00-000Z')), 'a\nb\nc\n')
  process.env[LOG_DIR_ENV] = dir
  const host = await startHost()
  try {
    const answer = await tail(host, '500')
    assert.deepEqual(answer.body.lines, ['a', 'b', 'c'])
  } finally {
    await host.close()
  }
})

test('log-tail reads a file smaller than one chunk from its start', async () => {
  const dir = await tempDir()
  // No trailing newline: the last line is still a line.
  await writeFile(path.join(dir, logName('2030-01-01T00-00-00-000Z')), 'first\nsecond')
  const { io, bytesRead } = countingIo()
  assert.deepEqual(await readLogTail(dir, 10, io), {
    ok: true,
    file: path.join(dir, logName('2030-01-01T00-00-00-000Z')),
    lines: ['first', 'second'],
  })
  assert.ok(bytesRead() > 0)
})

test('log-tail treats an empty log file as no lines', async () => {
  const dir = await tempDir()
  await writeFile(path.join(dir, logName('2030-01-01T00-00-00-000Z')), '')
  assert.deepEqual(await readLogTail(dir, 5), {
    ok: true,
    file: path.join(dir, logName('2030-01-01T00-00-00-000Z')),
    lines: [],
  })
})

test('log-tail reports a directory without server logs as a failure, not as unsupported', async () => {
  const dir = await tempDir()
  await writeFile(path.join(dir, 'notes.txt'), 'not a log\n')
  process.env[LOG_DIR_ENV] = dir
  const host = await startHost()
  try {
    const answer = await tail(host, '5')
    assert.equal(answer.status, 404, 'the environment supports it; there is simply nothing to read')
    assert.equal(answer.body.ok, false)
    assert.equal(answer.body.unsupported, false)
    // The page renders this line itself, so the code IS the assertion: a
    // message that changed wording would still have to keep its code.
    assert.deepEqual(hostOf(answer.body), {
      code: 'log.fileMissing',
      text: 'the log directory holds no kernel log file',
    })
  } finally {
    await host.close()
  }
})

test('no log directory in the environment degrades to unsupported, never an error', async () => {
  const dir = await tempDir()
  const host = await startHost()
  try {
    delete process.env[LOG_DIR_ENV]
    const unset = await tail(host, '5')
    assert.equal(unset.status, 200, 'unsupported is not a failure status')
    assert.deepEqual(unset.body, UNSUPPORTED_BODY)

    process.env[LOG_DIR_ENV] = path.join(dir, 'missing')
    const absent = await tail(host, '5')
    assert.equal(absent.status, 200)
    assert.deepEqual(absent.body, UNSUPPORTED_BODY)

    // A path that exists but is a file, not a directory: same story.
    const notADir = path.join(dir, 'file.txt')
    await writeFile(notADir, 'x\n')
    process.env[LOG_DIR_ENV] = notADir
    assert.deepEqual((await tail(host, '5')).body, UNSUPPORTED_BODY)
  } finally {
    delete process.env[LOG_DIR_ENV]
    await host.close()
  }
})

test('log-tail refuses a lines value that is not a positive integer', async () => {
  const dir = await tempDir()
  await writeFile(path.join(dir, logName('2030-01-01T00-00-00-000Z')), 'a\nb\n')
  process.env[LOG_DIR_ENV] = dir
  const host = await startHost()
  try {
    for (const value of ['abc', '0', '-3', '1.5']) {
      const answer = await tail(host, value)
      assert.equal(answer.status, 400, `lines=${value} must be refused`)
      assert.equal(answer.body.unsupported, false)
      assert.equal(hostOf(answer.body).code, 'log.linesInvalid', `lines=${value} must carry the stable code`)
    }
    // The ceiling clamps instead of refusing: asking for more than MAX is a
    // legitimate request from a page with a "show everything" control.
    const capped = await tail(host, '5000')
    assert.equal(capped.status, 200)
    assert.deepEqual(capped.body.lines, ['a', 'b'])
  } finally {
    delete process.env[LOG_DIR_ENV]
    await host.close()
  }
})

test('parseTailLines defaults, clamps and refuses', () => {
  assert.equal(parseTailLines(null), DEFAULT_TAIL_LINES)
  assert.equal(parseTailLines(''), DEFAULT_TAIL_LINES)
  assert.equal(parseTailLines('7'), 7)
  assert.equal(parseTailLines(' 42 '), 42)
  assert.equal(parseTailLines(String(MAX_TAIL_LINES + 1)), MAX_TAIL_LINES)
  assert.equal(parseTailLines('abc'), undefined)
  assert.equal(parseTailLines('0'), undefined)
})

test('log-tail is not a token leak: the bridge secret never reaches the answer', async () => {
  const dir = await tempDir()
  await writeFile(path.join(dir, logName('2030-01-01T00-00-00-000Z')), 'line\n')
  process.env[LOG_DIR_ENV] = dir
  process.env[BRIDGE_TOKEN_ENV] = 'probe-token-that-must-not-surface'
  const host = await startHost()
  try {
    const answer = await tail(host, '5')
    assert.equal(answer.body.ok, true)
    assert.equal(JSON.stringify(answer.body).includes('probe-token-that-must-not-surface'), false)
  } finally {
    delete process.env[BRIDGE_TOKEN_ENV]
    delete process.env[LOG_DIR_ENV]
    await host.close()
  }
})

test('log-tail refuses a cross-site Origin', async () => {
  const dir = await tempDir()
  await writeFile(path.join(dir, logName('2030-01-01T00-00-00-000Z')), 'line\n')
  process.env[LOG_DIR_ENV] = dir
  const host = await startHost()
  try {
    const answer = await get(host, '/diagnostics/log-tail', { origin: 'https://evil.example' })
    assert.equal(answer.status, 403)
    assert.equal(answer.body.ok, false)
    assert.equal('lines' in answer.body, false, 'a refused request reads nothing')
  } finally {
    delete process.env[LOG_DIR_ENV]
    await host.close()
  }
})

test('log-tail admits the app own page and refuses a non-loopback Host', async () => {
  const dir = await tempDir()
  await writeFile(path.join(dir, logName('2030-01-01T00-00-00-000Z')), 'line\n')
  process.env[LOG_DIR_ENV] = dir
  const host = await startHost()
  try {
    const sameOrigin = await get(host, '/diagnostics/log-tail', { origin: host.url })
    assert.equal(sameOrigin.status, 200)

    const request = `GET ${ROUTE_PREFIX}/diagnostics/log-tail HTTP/1.1`
    const foreign = parseRaw(await rawRequest(host.port, [
      request,
      'Host: dsh.example',
      'Connection: close',
      '',
      '',
    ].join('\r\n')))
    assert.equal(foreign.status, 403)
    assert.equal(foreign.body.ok, false)

    const loopback = parseRaw(await rawRequest(host.port, [
      request,
      `Host: 127.0.0.1:${String(host.port)}`,
      'Connection: close',
      '',
      '',
    ].join('\r\n')))
    assert.equal(loopback.status, 200)
    assert.equal(loopback.body.ok, true)
  } finally {
    delete process.env[LOG_DIR_ENV]
    await host.close()
  }
})

test('log-tail answers 405 for a POST and names the method that works', async () => {
  const dir = await tempDir()
  await writeFile(path.join(dir, logName('2030-01-01T00-00-00-000Z')), 'line\n')
  process.env[LOG_DIR_ENV] = dir
  const host = await startHost()
  try {
    const response = await fetch(`${host.url}${ROUTE_PREFIX}/diagnostics/log-tail`, { method: 'POST' })
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), 'GET')
  } finally {
    delete process.env[LOG_DIR_ENV]
    await host.close()
  }
})

test('readLogTail reports unsupported without an environment, and never throws for one', async () => {
  assert.deepEqual(await readLogTail(undefined, 5), { ok: false, reason: 'unsupported' })
  assert.deepEqual(await readLogTail('', 5), { ok: false, reason: 'unsupported' })
  const dir = await tempDir()
  await mkdir(path.join(dir, 'empty'))
  assert.deepEqual(await readLogTail(path.join(dir, 'empty'), 5), { ok: false, reason: 'missing' })
})
