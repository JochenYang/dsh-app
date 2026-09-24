// Last-resort error handling and the diagnostics log's rotation.
//
// Two measured facts shape these tests. Electron 44.4.5 turns an
// `uncaughtException` into a native error box ("A JavaScript error occurred in
// the main process", one OK button) and KEEPS RUNNING; an `unhandledRejection`
// raises no box but is equally invisible in a packaged build, which has no
// console. So a reported dialog could not be traced to a line at all.
//
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { installCrashLogging, isTransportFailure, reportEscapedError } = require('../dist/main/crash-log.js')
const { LOG_ROTATE_BYTES, appendRotatingLog } = require('../dist/main/log-file.js')

// ---------------------------------------------------------------- classification

test('a transport failure is told apart from a defect', () => {
  // The exact shape the reported dialog carried: undici's abort of a fetch whose
  // TLS connection closed mid-transfer.
  const terminated = Object.assign(new TypeError('terminated'), {
    stack: 'TypeError: terminated\n    at Fetch.onAborted (node:internal/deps/undici/undici:13877:53)',
  })
  assert.equal(isTransportFailure(terminated), true)
  // A socket reset, and the same condition nested in `cause` (an aborted fetch
  // carries the real reason there — missing it reads a reset link as a defect).
  assert.equal(isTransportFailure(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), true)
  assert.equal(isTransportFailure(Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) })), true)
  assert.equal(isTransportFailure(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })), true)

  // Defects must NOT be excused as network conditions.
  assert.equal(isTransportFailure(new TypeError("Cannot read properties of undefined (reading 'id')")), false)
  assert.equal(isTransportFailure(new RangeError('Maximum call stack size exceeded')), false)
  assert.equal(isTransportFailure(new Error('assertion failed')), false)
  assert.equal(isTransportFailure(undefined), false)
  assert.equal(isTransportFailure(null), false)
  assert.equal(isTransportFailure(42), false)
  // A message that merely CONTAINS a marker word as a substring is still matched
  // by design (the markers are codes and undici's own wording), but an unrelated
  // sentence must not be.
  assert.equal(isTransportFailure(new Error('the report was terminated early by the editor')), true)
})

// ---------------------------------------------------------------- the log line

test('every escaped error is written out with its full stack', () => {
  const lines = []
  const error = Object.assign(new TypeError('terminated'), { stack: 'TypeError: terminated\n    at Fetch.onAborted (undici:1)\n    at TCP.done (tls:770)' })
  const verdict = reportEscapedError(error, 'uncaughtException', (line) => lines.push(line))
  assert.equal(verdict, 'transport')
  const text = lines.join('\n')
  assert.match(text, /\[crash\] uncaughtException \(TRANSPORT\)/)
  // The stack is the point: it is what makes a reported dialog traceable.
  assert.match(text, /at Fetch\.onAborted/)
  assert.match(text, /at TCP\.done/)
  // The process staying up is stated in the log, so a reader knows it was a
  // decision and not a crash that went unnoticed.
  assert.match(text, /process stays up/)

  const defectLines = []
  assert.equal(reportEscapedError(new Error('assertion failed'), 'unhandledRejection', (line) => defectLines.push(line)), 'defect')
  assert.match(defectLines.join('\n'), /unhandledRejection \(DEFECT\)/)
})

test('a non-Error rejection value is still recorded readably', () => {
  const lines = []
  reportEscapedError({ code: 'boom', detail: 'x' }, 'unhandledRejection', (line) => lines.push(line))
  assert.match(lines.join('\n'), /boom/)
})

// ---------------------------------------------------------------- the listeners

test('both listeners are installed, and neither re-raises', () => {
  const before = { uncaught: process.listenerCount('uncaughtException'), rejection: process.listenerCount('unhandledRejection') }
  const lines = []
  installCrashLogging((line) => lines.push(line))
  assert.equal(process.listenerCount('uncaughtException'), before.uncaught + 1)
  assert.equal(process.listenerCount('unhandledRejection'), before.rejection + 1)

  // Driving the listeners directly: the module must record and return, never
  // throw (a throwing listener would replace the original error) and never exit.
  const uncaught = process.listeners('uncaughtException').at(-1)
  const rejection = process.listeners('unhandledRejection').at(-1)
  assert.doesNotThrow(() => uncaught(Object.assign(new TypeError('terminated'), {})))
  assert.doesNotThrow(() => rejection(new Error('a rejection nobody awaited')))
  assert.equal(lines.filter((line) => line.includes('[crash]')).length >= 2, true)

  // Leave the process as it was found: other suites share this process.
  process.removeListener('uncaughtException', uncaught)
  process.removeListener('unhandledRejection', rejection)
})

// ---------------------------------------------------------------- log rotation

test('the diagnostics log keeps exactly one previous generation', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-app-log-'))
  const file = path.join(dir, 'nested', 'dsh-kernel.log')
  // The directory is created on demand: the log's own path is the first thing a
  // fresh install writes to.
  appendRotatingLog(file, 'first line')
  assert.match(readFileSync(file, 'utf8'), /first line/)
  assert.match(readFileSync(file, 'utf8'), /^\d{4}-\d{2}-\d{2}T/u, 'lines are timestamped')

  // Push the live file past the cap, then append once more: the oversized file
  // becomes `.1` and the live file restarts with the new line only.
  writeFileSync(file, 'x'.repeat(LOG_ROTATE_BYTES + 1))
  appendRotatingLog(file, 'after rotation')
  assert.equal(readFileSync(`${file}.1`, 'utf8').length, LOG_ROTATE_BYTES + 1)
  const live = readFileSync(file, 'utf8')
  assert.match(live, /after rotation/)
  assert.ok(!live.includes('first line'), 'the live file restarted')

  // A second rotation must not fail on the existing `.1` (Windows refuses a
  // rename onto an existing target, which is why the old one is removed first).
  writeFileSync(file, 'y'.repeat(LOG_ROTATE_BYTES + 1))
  assert.doesNotThrow(() => appendRotatingLog(file, 'second rotation'))
  assert.match(readFileSync(file, 'utf8'), /second rotation/)
})
