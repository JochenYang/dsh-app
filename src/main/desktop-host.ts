/**
 * The dsh desktop host: the kernel as a CHILD PROCESS whose web surface travels
 * as framed bytes over pipes instead of a loopback HTTP socket.
 *
 * Why the pipes: a listening socket on 127.0.0.1 is reachable by every process
 * on the machine and by anything that guesses the port, it forces the shell to
 * find a free port, poll a health endpoint and harvest a URL the child prints,
 * and it is a second origin the window has to be fenced against. The upstream
 * desktop host removes all of that — it serves the same routes the `dsh web`
 * server did (`/api/…`, the web frontend's assets, the plugin client bundles,
 * the streaming transport) and exports them over byte pipes, so this process is
 * the only client and no port is ever bound.
 *
 * Wire shape (upstream `@deepseek-ai/dsh-desktop-host`, protocol version 3):
 *
 *   - the child is spawned with `stdio: ['ignore','pipe','pipe','pipe','pipe','ipc']`;
 *     descriptors 3 and 4 are the request and response byte pipes, descriptor 5
 *     is Node's IPC channel. Only two things cross the IPC channel, because
 *     neither carries Fetch payload bytes: the child's `ready` event (protocol
 *     version + dsh version) and the parent's `shutdown` command.
 *   - every frame is a 13-byte header — magic `0x44534833`, one type byte, a
 *     u32 stream id, a u32 payload length — followed by the payload. Data
 *     frames carry at most 64 KiB, control frames at most 1 MiB.
 *   - request stream ids strictly increase, and the response pipe must be read
 *     continuously: the child applies byte backpressure, so a reader that stops
 *     draining stalls the response it is waiting for.
 *   - the child resolves the dsh packages from `runtimeDir` and composes the
 *     profile in `projectDir`. That runtime slot moved inside the 0.1 line:
 *     hosts up to 0.1.5 take the project directory alone, 0.1.6 and later take
 *     the runtime tree as well, so the shape of the child's argv is read off the
 *     host package's own version (see {@link hostArgShape}). A workspace
 *     checkout resolves its packages per app rather than into one tree, so
 *     `allowLinkedProfile` is what lets the dev checkout boot instead of failing
 *     the "packages must live inside this runtime" check.
 *   - the same release moved where the child ANCHORS the profile's kernel
 *     packages: 0.1.6 and later read them out of `runtimeDir` (the profile holds
 *     only its manifest, bundle list and patch file — what `suite-profile.ts`
 *     seeds), while 0.1.5 and earlier read the profile itself as an installed
 *     tree, so `<projectDir>/node_modules/@deepseek-ai/dsh` must be there and
 *     the bundle layers must resolve inside it. See {@link hostProfileAnchor}.
 *
 * The module deliberately holds no Electron state beyond the protocol
 * registration, which is why the whole transport is testable without a window.
 */
import { protocol } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { HOST_READY_TIMEOUT_MS, HOST_SHUTDOWN_GRACE_MS, HOST_SIGNAL_GRACE_MS } from '../shared/constants'
import { redact } from './redact'

/** Custom scheme the renderer loads the harness UI from. */
export const APP_SCHEME = 'dsh-app'
/** Origin of the harness UI: `standard: true` makes the host part of the origin. */
export const APP_ORIGIN = `${APP_SCHEME}://app`
/** Entry point of the harness UI inside the host. */
export const APP_URL = `${APP_ORIGIN}/index.html`

/** Protocol version this shell speaks; the child refuses anything else. */
export const HOST_PROTOCOL_VERSION = 3

/** Package name of the host, as its own manifest spells it. */
const HOST_PACKAGE_NAME = '@deepseek-ai/dsh-desktop-host'

/**
 * How the child takes its two directories, by host package line:
 *
 *   - `runtime-and-project` — `<entry> <runtimeDir> <projectDir> [flag]`, the
 *     shape every host from 0.1.6 on takes;
 *   - `project-only` — `<entry> <projectDir> [flag]`, the earlier one, where the
 *     runtime is implied by the entry script's own location.
 */
export type HostArgShape = 'runtime-and-project' | 'project-only'

/**
 * Where a host line resolves the profile's kernel packages from.
 *
 *   - `runtime` — 0.1.6 and later: the profile is a manifest, a bundle list and
 *     a patch file, and every `@deepseek-ai` package comes from the runtime tree
 *     the child was handed;
 *   - `profile` — 0.1.5 and earlier: the profile IS the installation. Its own
 *     `node_modules/@deepseek-ai/dsh` is the resolution anchor, and both
 *     `installed package "@deepseek-ai/dsh" has no manifest` and `profile bundle
 *     "@deepseek-ai/dsh-base" resolved outside the desktop profile` are that
 *     anchor's guards.
 */
export type HostProfileAnchor = 'runtime' | 'profile'

/** Shape tried first when the host's version cannot be mapped. */
const DEFAULT_HOST_ARG_SHAPE: HostArgShape = 'runtime-and-project'

/**
 * Version at which the 0.1 line began to take the runtime directory, and to
 * anchor the profile on it. Both traits moved in the same release (measured
 * against 0.1.5-rc.2's host and 0.1.6-alpha.1's), which is why one comparison
 * answers both — see {@link hostArgShape} / {@link hostProfileAnchor}.
 */
const RUNTIME_TREE_VERSION = { major: 0, minor: 1, patch: 6 } as const

/**
 * How soon after the spawn a failure still counts as the child refusing the
 * shape. A refused argv is answered in tens of milliseconds, long before any
 * composition work; a profile that failed to compose answers much later.
 */
const HOST_SHAPE_RETRY_WINDOW_MS = 10_000

/** The child's own words when it is handed an argument it does not know. */
const HOST_SHAPE_REJECTION = /unsupported internal option/iu

/** Longest child-failure fragment echoed into the fallback log line. */
const MAX_SHAPE_REASON_CHARS = 200

/** The one optional flag both shapes understand, as the last positional. */
const LINKED_PROFILE_FLAG = '--allow-linked-profile'

/** Child descriptor that receives request frames. */
const REQUEST_PIPE_FD = 3
/** Child descriptor that emits response frames. */
const RESPONSE_PIPE_FD = 4

/** Maximum raw body bytes one data frame may carry. */
const PIPE_CHUNK_BYTES = 64 * 1024

/** How much child stderr to keep for a failure message. */
const MAX_STDERR_TAIL = 4_000

const FRAME_MAGIC = 0x44534833
const FRAME_HEADER_BYTES = 13
const MAX_CONTROL_PAYLOAD_BYTES = 1024 * 1024

const REQUEST_FRAME_START = 1
const REQUEST_FRAME_DATA = 2
const REQUEST_FRAME_END = 3
const REQUEST_FRAME_CANCEL = 4

const RESPONSE_FRAME_START = 1
const RESPONSE_FRAME_DATA = 2
const RESPONSE_FRAME_END = 3
const RESPONSE_FRAME_ERROR = 4

/** The child's half of the protocol: the two messages that are not Fetch bytes. */
type HostEvent = {
  readonly type: 'ready'
  readonly protocolVersion: number
  readonly dshVersion: string
} | {
  readonly type: 'fatal'
  readonly message: string
}

/** One decoded response-pipe frame. */
type ResponseFrame = {
  readonly type: 'start'
  readonly streamId: number
  readonly status: number
  readonly headers: readonly [string, string][]
  readonly hasBody: boolean
} | {
  readonly type: 'data'
  readonly streamId: number
  readonly data: Buffer
} | {
  readonly type: 'end'
  readonly streamId: number
} | {
  readonly type: 'error'
  readonly streamId: number
  readonly message: string
}

interface PendingResponse {
  readonly resolve: (response: Response) => void
  readonly reject: (error: Error) => void
  responseStarted: boolean
  uploadOpen: boolean
  controller?: ReadableStreamDefaultController<Uint8Array>
  requestReader?: ReadableStreamDefaultReader<Uint8Array>
  removeAbort?: () => void
}

/** Anything the `dsh-app://` handler can forward a request to. */
export interface DshAppTarget {
  fetch(request: Request): Promise<Response>
}

/**
 * A route the MAIN process answers inside the app host, before any forward to
 * the kernel (the shell's own action seam — see `shell-actions.ts`).
 *
 * @returns the response, or null when the request is not this route's to answer
 *   (it is then forwarded to the host exactly as any other `dsh-app://app/…`
 *   request is).
 */
export type DshAppRoute = (request: Request) => Promise<Response | null>

export interface DshHostOptions {
  /** Node-compatible executable: this Electron binary, told to behave as node. */
  executable: string
  /** Absolute entry script of `@deepseek-ai/dsh-desktop-host` (see {@link desktopHostEntry}). */
  entry: string
  /**
   * Installed runtime tree holding the dsh packages (`<kernel>/app`), and the
   * place the host package's version is read from. A host up to 0.1.5 takes no
   * runtime argument and ignores it (see {@link hostArgShape}).
   */
  runtimeDir: string
  /** Profile directory the host composes and boots. */
  projectDir: string
  /** Child environment; runtime and package-manager overrides are stripped. */
  env: NodeJS.ProcessEnv
  /**
   * Allow profile bundles resolving outside runtimeDir/projectDir: the dev
   * checkout, and every production host that anchors the profile on its own
   * `node_modules` (see {@link hostProfileAnchor}) — the shell fills that
   * directory with links into the runtime tree, which the host's
   * "resolved outside the desktop profile" check refuses without this flag.
   */
  allowLinkedProfile?: boolean
  /** Ride along {@link hostProxyBootstrap} — set when `env` carries a proxy (see `hasProxyEnv`). */
  proxyBootstrap?: boolean
  /** Raw child output lines (stdout + stderr), one per call. */
  onLog?: (line: string) => void
  /** First exit AFTER readiness; a failure before it reaches start()'s rejection. */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
}

/** Directory of the host package inside an installed runtime tree. */
export function desktopHostDir(runtimeDir: string): string {
  return path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host')
}

/** Entry script of the host inside an installed runtime tree. */
export function desktopHostEntry(runtimeDir: string): string {
  return path.join(desktopHostDir(runtimeDir), 'lib', 'index.js')
}

/** One JSON file, parsed; undefined when it is absent or is not readable JSON. */
function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

/** The `version` field of one manifest, when it is a usable string. */
function manifestVersion(manifest: unknown): string | undefined {
  if (!isRecord(manifest) || typeof manifest.version !== 'string') return undefined
  const version = manifest.version.trim()
  return version === '' ? undefined : version
}

/**
 * Version of the host package the child will run, or undefined when it cannot be
 * read.
 *
 * Two layouts answer this: an installed runtime keeps the package under its own
 * node_modules, while the dev checkout hands over the app directory ITSELF as
 * the runtime — so that manifest answers too, matched by name, which keeps an
 * unrelated package.json from being mistaken for the host's.
 */
export function hostPackageVersion(runtimeDir: string): string | undefined {
  const installed = manifestVersion(readJson(path.join(desktopHostDir(runtimeDir), 'package.json')))
  if (installed !== undefined) return installed
  const local = readJson(path.join(runtimeDir, 'package.json'))
  return isRecord(local) && local.name === HOST_PACKAGE_NAME ? manifestVersion(local) : undefined
}

/**
 * The argv shape a host package version takes, or undefined when this shell has
 * no mapping for it.
 *
 * The runtime slot appeared inside the 0.1 line — `0.1.5-rc.2` takes the project
 * directory alone, `0.1.6-alpha.1` takes the runtime tree too — and a prerelease
 * belongs to its own line's shape, so the tag suffix decides nothing while the
 * patch does. Versions off that line follow the same ordering (older: the old
 * shape, newer: the current one); only a version this shell has never seen needs
 * to be discovered by behaviour, which is what DshHost.start does.
 *
 * @param version - the host package's version, or undefined when unreadable.
 * @returns the shape, or undefined for an unmapped version.
 */
export function hostArgShape(version: string | undefined): HostArgShape | undefined {
  const runtimeTree = takesRuntimeTree(version)
  if (runtimeTree === undefined) return undefined
  return runtimeTree ? 'runtime-and-project' : 'project-only'
}

/**
 * Where one host package version anchors the profile, or undefined when this
 * shell has no mapping for it.
 *
 * Undefined is the "prepare nothing" answer on purpose: an unmapped version
 * starts on the current line's assumptions (no profile-local kernel tree, no
 * `--allow-linked-profile`), and DshHost.start's argv fallback keeps such a host
 * bootable at least as far as it can be — see the module header's note on what
 * the fallback does not cover.
 *
 * @param version - the host package's version, or undefined when unreadable.
 * @returns the anchor, or undefined for an unmapped version.
 */
export function hostProfileAnchor(version: string | undefined): HostProfileAnchor | undefined {
  const runtimeTree = takesRuntimeTree(version)
  if (runtimeTree === undefined) return undefined
  return runtimeTree ? 'runtime' : 'profile'
}

/**
 * Whether a host package version belongs to the line that takes the runtime tree
 * in argv and anchors the profile on it, or undefined when unmapped.
 */
function takesRuntimeTree(version: string | undefined): boolean | undefined {
  if (version === undefined) return undefined
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version)
  if (match === null) return undefined
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const { major: atMajor, minor: atMinor, patch: atPatch } = RUNTIME_TREE_VERSION
  if (major !== atMajor) return major > atMajor
  if (minor !== atMinor) return minor > atMinor
  return patch >= atPatch
}

/**
 * The shape to start with, plus the log line saying why.
 *
 * A mapped version decides outright. An unmapped one starts on the current shape
 * and lets DshHost.start fall back if the child refuses it, so neither an older
 * package nor an unreadable manifest is a hard failure.
 *
 * @param version - the host package's version, or undefined when unreadable.
 * @returns the shape, whether it came from the version, and the echo line.
 */
function decideArgShape(version: string | undefined): { shape: HostArgShape; mapped: boolean; log: string } {
  const shape = hostArgShape(version)
  if (shape !== undefined) {
    return { shape, mapped: true, log: `dsh host: argv shape ${shape} (host package ${String(version)})` }
  }
  const because = version === undefined
    ? 'host package version unreadable'
    : `host package version ${version} unmapped`
  return {
    shape: DEFAULT_HOST_ARG_SHAPE,
    mapped: false,
    log: `dsh host: argv shape ${DEFAULT_HOST_ARG_SHAPE} (${because}; falls back if the host refuses it)`,
  }
}

/** The child's positional arguments for one shape, proxy flags excluded. */
function shapeArgs(shape: HostArgShape, options: DshHostOptions): string[] {
  const linked = options.allowLinkedProfile === true ? [LINKED_PROFILE_FLAG] : []
  return shape === 'runtime-and-project'
    ? [options.entry, options.runtimeDir, options.projectDir, ...linked]
    : [options.entry, options.projectDir, ...linked]
}

/**
 * Source of the `--import` bootstrap that installs the outbound proxy policy in
 * the host child.
 *
 * Why it is needed: the policy is process-wide state inside
 * `@deepseek-ai/dsh-http-proxy`, installed by `installProxyFromEnvironment`, and
 * the ONLY caller in the product is the `dsh` CLI's own profile boot
 * (`apps/cli/src/profile-boot.ts`, via `runProfile`). The desktop host boots its
 * profile through `@deepseek-ai/dsh-app-boot` instead, so nothing installs the
 * policy and the environment variables — which the shell does inject — reach a
 * process that never reads them. `web-fetch-http` then takes its direct branch
 * (`proxyRouteFor` answers `proxied: false` without an installed policy),
 * resolves the hostname, and refuses the result.
 *
 * That refusal is what a Clash/TUN fake-IP setup hits: every name resolves into
 * `198.18.0.0/15`, which the provider rejects as non-public, while the proxied
 * branch exists precisely to skip that check because the proxy does the DNS.
 *
 * The module is resolved through the anchor the host itself uses for profile
 * bundles — `@deepseek-ai/dsh` under the runtime tree — so this import shares the
 * one instance `dsh-web-fetch-http` imports later. Installing on any other copy
 * would set state that provider never reads.
 *
 * Fail-soft by construction: this is a bridge until the host installs the policy
 * itself, so an unreachable runtime, a renamed package, or a policy the package
 * rejects must leave the kernel booting exactly as it does today.
 */
const hostProxyBootstrap = ((): string => {
  const source = `import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
try {
  const runtimeDir = process.argv[2] ?? process.cwd()
  const fromRuntime = createRequire(join(runtimeDir, 'index.js'))
  const fromAnchor = createRequire(fromRuntime.resolve('@deepseek-ai/dsh/package.json'))
  const proxy = await import(pathToFileURL(fromAnchor.resolve('@deepseek-ai/dsh-http-proxy')).href)
  const environment = { get: (name) => (process.env[name] === undefined ? undefined : { value: process.env[name] }) }
  await proxy.installProxyFromEnvironment(environment, (message) => { process.stderr.write('dsh-app: ' + message + '\\n') })
} catch (error) {
  process.stderr.write('dsh-app: proxy bootstrap skipped: ' + (error?.message ?? String(error)) + '\\n')
}
`
  return `data:text/javascript,${encodeURIComponent(source)}`
})()

/**
 * Flags that install the proxy policy in the child before its entry runs.
 *
 * The bootstrap rides ahead of the entry so the policy exists before any plugin
 * mounts — the order the CLI's own profile boot establishes.
 *
 * @param enabled - whether the child's environment carries a proxy.
 * @returns the flags to place before the entry script, or none.
 */
export function hostProxyFlags(enabled: boolean): string[] {
  return enabled ? ['--import', hostProxyBootstrap] : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isHeaders(value: unknown): value is readonly [string, string][] {
  return Array.isArray(value) && value.every((header) => Array.isArray(header) && header.length === 2
    && typeof header[0] === 'string' && typeof header[1] === 'string')
}

function assertStreamId(streamId: number): void {
  if (!Number.isInteger(streamId) || streamId < 1 || streamId > 0xffff_ffff) {
    throw new Error(`dsh host: invalid pipe stream id ${String(streamId)}`)
  }
}

function encodeFrame(type: number, streamId: number, payload: Buffer): Buffer {
  assertStreamId(streamId)
  const limit = type === REQUEST_FRAME_DATA ? PIPE_CHUNK_BYTES : MAX_CONTROL_PAYLOAD_BYTES
  if (payload.byteLength > limit) {
    throw new Error(`dsh host: request frame exceeds the ${String(limit)}-byte limit`)
  }
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.byteLength)
  frame.writeUInt32BE(FRAME_MAGIC, 0)
  frame.writeUInt8(type, 4)
  frame.writeUInt32BE(streamId, 5)
  frame.writeUInt32BE(payload.byteLength, 9)
  payload.copy(frame, FRAME_HEADER_BYTES)
  return frame
}

function encodeRequestStart(streamId: number, request: {
  readonly url: string
  readonly method: string
  readonly headers: readonly [string, string][]
  readonly hasBody: boolean
}): Buffer {
  return encodeFrame(REQUEST_FRAME_START, streamId, Buffer.from(JSON.stringify(request), 'utf8'))
}

function encodeRequestData(streamId: number, data: Uint8Array): Buffer {
  return encodeFrame(REQUEST_FRAME_DATA, streamId, Buffer.from(data))
}

function encodeRequestEnd(streamId: number): Buffer {
  return encodeFrame(REQUEST_FRAME_END, streamId, Buffer.alloc(0))
}

function encodeRequestCancel(streamId: number): Buffer {
  return encodeFrame(REQUEST_FRAME_CANCEL, streamId, Buffer.alloc(0))
}

/** Incremental decoder for the response pipe: frames arrive in arbitrary chunks. */
class ResponseDecoder {
  private buffer: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): ResponseFrame[] {
    this.buffer = this.buffer.byteLength === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const frames: ResponseFrame[] = []
    for (;;) {
      const frame = this.next()
      if (frame === undefined) return frames
      frames.push(frame)
    }
  }

  /** Reject an EOF that landed inside a frame. */
  finish(): void {
    if (this.buffer.byteLength !== 0) throw new Error('dsh host: response pipe ended inside a frame')
  }

  private next(): ResponseFrame | undefined {
    if (this.buffer.byteLength < FRAME_HEADER_BYTES) return undefined
    if (this.buffer.readUInt32BE(0) !== FRAME_MAGIC) throw new Error('dsh host: invalid response frame marker')
    const rawType = this.buffer.readUInt8(4)
    const streamId = this.buffer.readUInt32BE(5)
    const payloadLength = this.buffer.readUInt32BE(9)
    assertStreamId(streamId)
    const limit = rawType === RESPONSE_FRAME_DATA ? PIPE_CHUNK_BYTES : MAX_CONTROL_PAYLOAD_BYTES
    if (payloadLength > limit) {
      throw new Error(`dsh host: response frame exceeds the ${String(limit)}-byte limit`)
    }
    const frameLength = FRAME_HEADER_BYTES + payloadLength
    if (this.buffer.byteLength < frameLength) return undefined
    const payload = this.buffer.subarray(FRAME_HEADER_BYTES, frameLength)
    this.buffer = this.buffer.subarray(frameLength)
    switch (rawType) {
      case RESPONSE_FRAME_START:
        return this.parseStart(streamId, payload)
      case RESPONSE_FRAME_DATA:
        return { type: 'data', streamId, data: payload }
      case RESPONSE_FRAME_END:
        if (payloadLength !== 0) throw new Error('dsh host: response end frame carried a payload')
        return { type: 'end', streamId }
      case RESPONSE_FRAME_ERROR:
        return this.parseError(streamId, payload)
      default:
        throw new Error(`dsh host: unknown response frame type ${String(rawType)}`)
    }
  }

  private parseStart(streamId: number, payload: Buffer): ResponseFrame {
    const value = this.parseJson(payload, 'start')
    if (!isRecord(value) || !Number.isInteger(value.status) || (value.status as number) < 100
      || (value.status as number) > 599 || !isHeaders(value.headers) || typeof value.hasBody !== 'boolean') {
      throw new Error('dsh host: invalid response start payload')
    }
    return { type: 'start', streamId, status: value.status as number, headers: value.headers, hasBody: value.hasBody }
  }

  private parseError(streamId: number, payload: Buffer): ResponseFrame {
    const value = this.parseJson(payload, 'error')
    if (!isRecord(value) || typeof value.message !== 'string') {
      throw new Error('dsh host: invalid response error payload')
    }
    return { type: 'error', streamId, message: value.message }
  }

  private parseJson(payload: Buffer, subject: string): unknown {
    try {
      return JSON.parse(payload.toString('utf8')) as unknown
    } catch (error) {
      throw new Error(`dsh host: response ${subject} payload is not JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function errorOf(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback)
}

/** Race one settlement against a deadline without leaving a timer behind. */
async function exitsWithin(exit: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => { resolve(false) }, milliseconds)
    timer.unref()
  })
  try {
    return await Promise.race([exit.then(() => true), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Wait for a promise, but fail loudly instead of hanging on a wedged child. */
async function withDeadline<T>(work: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error(message)) }, milliseconds)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * One dsh desktop host process.
 *
 * An instance is single-use: `start()` spawns, `fetch()` serves, `stop()`
 * tears down, and a restart is a new instance (the shell's crash-restart path
 * does exactly that). That keeps the two halves of the protocol — the request
 * stream ids, the ready flag — from ever describing a previous process. The one
 * exception is `start()`'s own retry for an argv shape the child refused: it
 * spawns a second child inside the same instance, with every protocol field
 * reset first (see {@link DshHost.resetAttempt}).
 */
export class DshHost implements DshAppTarget {
  private child: ChildProcess | undefined
  private requestPipe: Writable | undefined
  private responsePipe: Readable | undefined
  private decoder = new ResponseDecoder()
  private requestWriteTail: Promise<void> = Promise.resolve()
  private nextStreamId = 1
  private readonly pending = new Map<number, PendingResponse>()
  private readonly blockedResponses = new Set<number>()
  private ready = false
  private stopping = false
  private version: string | undefined
  private stderrTail = ''
  private failureReported = false
  private exitPromise: Promise<void> | undefined
  private settleReady!: () => void
  private failReady!: (error: Error) => void
  private readyPromise = new Promise<void>((resolve, reject) => {
    this.settleReady = resolve
    this.failReady = reject
  })

  constructor(private readonly options: DshHostOptions) {}

  /** Whether a host this instance started is still alive. */
  get isRunning(): boolean {
    return this.child !== undefined && this.child.exitCode === null && !this.child.killed
  }

  /** dsh version the host reported in its `ready` message, once it has. */
  get dshVersion(): string | undefined {
    return this.version
  }

  /**
   * Spawn the host and wait until it reports its composition active.
   *
   * The child's argv shape is read off the host package's own version. A version
   * this shell has no mapping for starts on the current shape and falls back to
   * the other one when the child refuses it — that refusal is the child's own
   * `unsupported internal option`, answered before it composes anything, so a
   * host line the shell has never seen still boots.
   *
   * @returns once the host answers requests.
   */
  async start(): Promise<void> {
    if (this.child !== undefined) {
      await this.readyPromise
      return
    }
    const decision = decideArgShape(hostPackageVersion(this.options.runtimeDir))
    let shape = decision.shape
    this.options.onLog?.(decision.log)
    for (let attempt = 0; ; attempt += 1) {
      const spawnedAt = Date.now()
      try {
        await this.startAttempt(shape)
        return
      } catch (error) {
        const message = errorOf(error, 'dsh host failed to start').message
        if (decision.mapped || attempt > 0 || Date.now() - spawnedAt > HOST_SHAPE_RETRY_WINDOW_MS
          || !HOST_SHAPE_REJECTION.test(message)) {
          throw error
        }
        const refused = shape
        shape = refused === 'project-only' ? 'runtime-and-project' : 'project-only'
        const reason = message.split(/\r?\n/u, 1)[0]?.slice(0, MAX_SHAPE_REASON_CHARS) ?? ''
        this.options.onLog?.(`dsh host: argv shape ${shape} (fallback: the host refused ${refused} — ${reason})`)
        this.resetAttempt()
      }
    }
  }

  /**
   * One spawn attempt in one argv shape, up to readiness or the failure that
   * condemned it. The child is gone by the time this rejects, so the caller may
   * start another.
   *
   * @param shape - how to lay out the child's positional arguments.
   */
  private async startAttempt(shape: HostArgShape): Promise<void> {
    const { executable, projectDir, env, proxyBootstrap } = this.options
    // Runtime and package-manager overrides are removed rather than inherited:
    // NODE_OPTIONS can inject a require hook into the child, NODE_PATH can
    // shadow the runtime's own packages, and the npm/pnpm variables a `npm run`
    // parent leaves behind describe a project this child is not.
    const childEnv: NodeJS.ProcessEnv = {}
    for (const [name, value] of Object.entries(env)) {
      if (name === 'NODE_OPTIONS' || name === 'NODE_PATH' || /^DSH_DESKTOP_/u.test(name) || /^(?:npm|pnpm|corepack)_/iu.test(name)) continue
      childEnv[name] = value
    }
    // Electron's binary has to be told to behave as Node; a real Node ignores
    // the variable, and the shell deliberately ships a real one for the child
    // (see the DshHost note in index.ts about the profile resolver's addon).
    if (/^electron/iu.test(path.basename(executable))) childEnv.ELECTRON_RUN_AS_NODE = '1'
    const child = spawn(executable, [
      ...hostProxyFlags(proxyBootstrap === true),
      ...shapeArgs(shape, this.options),
    ], {
      cwd: projectDir,
      env: childEnv,
      // Index positions ARE the descriptors: 3 request pipe, 4 response pipe,
      // 5 the IPC channel Node wires up itself.
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    })
    const requestPipe = child.stdio[REQUEST_PIPE_FD]
    const responsePipe = child.stdio[RESPONSE_PIPE_FD]
    if (!(requestPipe instanceof Writable) || !(responsePipe instanceof Readable)) {
      child.kill('SIGTERM')
      throw new Error('dsh host did not expose the required byte pipes and IPC channel')
    }
    this.child = child
    this.requestPipe = requestPipe
    this.responsePipe = responsePipe
    // Every handler below belongs to THIS child, and a retried attempt's
    // predecessor can still emit after its replacement is live — a closing pipe
    // or a last log line — which would otherwise fail the new attempt with the
    // old one's death (measured: the refused first attempt's response pipe ends
    // right as the retry is reaching ready). One predicate decides.
    const live = (): boolean => this.child === child

    // Both output streams are drained line by line: a child log line is the only
    // diagnostic a failed composition leaves behind, and an unread pipe would
    // block the child as soon as its buffer filled.
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    const lineBuffers = new Map<NodeJS.ReadableStream, string>()
    const forward = (stream: NodeJS.ReadableStream) => (chunk: string) => {
      if (!live()) return
      const pending = `${lineBuffers.get(stream) ?? ''}${chunk}`
      const parts = pending.split(/\r?\n/)
      lineBuffers.set(stream, parts.pop() ?? '')
      for (const line of parts) {
        if (stream === child.stderr) this.stderrTail = `${this.stderrTail}${line}\n`.slice(-MAX_STDERR_TAIL)
        this.options.onLog?.(line)
      }
    }
    child.stdout?.on('data', forward(child.stdout))
    child.stderr?.on('data', forward(child.stderr))

    responsePipe.on('data', (chunk: Buffer) => { if (live()) this.acceptResponseBytes(chunk) })
    responsePipe.once('end', () => {
      if (!live()) return
      try {
        this.decoder.finish()
        this.fail(new Error('dsh host response pipe ended'))
      } catch (error) {
        this.fail(errorOf(error, 'dsh host response pipe failed'))
      }
    })
    requestPipe.once('error', (error: Error) => { if (live()) this.fail(error) })
    responsePipe.once('error', (error: Error) => { if (live()) this.fail(error) })
    child.on('message', (message: unknown) => {
      if (!live()) return
      if (!isHostEvent(message)) {
        this.fail(new Error('dsh host sent an invalid IPC event'))
        child.kill('SIGTERM')
        return
      }
      this.handleMessage(message)
    })
    child.once('error', (error: Error) => { if (live()) this.fail(error) })
    this.exitPromise = new Promise<void>((resolve) => {
      child.once('exit', (code, signal) => {
        if (!live()) {
          resolve()
          return
        }
        this.child = undefined
        if (this.stopping) {
          resolve()
          return
        }
        // Before readiness the failure belongs to start()'s rejection — firing
        // onExit as well would count one crash twice and skip the backoff retry.
        if (!this.ready) this.fail(this.exitError(code, signal))
        else this.options.onExit?.(code, signal)
        resolve()
      })
    })

    try {
      await withDeadline(
        this.readyPromise,
        HOST_READY_TIMEOUT_MS,
        `dsh host did not become ready within ${String(HOST_READY_TIMEOUT_MS / 1000)}s`,
      )
    } catch (error) {
      await this.stop().catch(() => undefined)
      throw error
    }
  }

  /**
   * Clear everything one attempt wrote, so the next one describes only its own
   * child: the pipes, the frame decoder, the stream-id counter, the ready
   * promise and the child's stderr tail.
   *
   * Only reachable between attempts, before the first `ready` — start() has not
   * resolved, so nothing can have called `fetch()` and the pending-response maps
   * are simply empty.
   */
  private resetAttempt(): void {
    this.child = undefined
    this.requestPipe = undefined
    this.responsePipe = undefined
    this.decoder = new ResponseDecoder()
    this.requestWriteTail = Promise.resolve()
    this.nextStreamId = 1
    this.pending.clear()
    this.blockedResponses.clear()
    this.ready = false
    this.stopping = false
    this.version = undefined
    this.stderrTail = ''
    this.failureReported = false
    this.exitPromise = undefined
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.settleReady = resolve
      this.failReady = reject
    })
  }

  /**
   * Forward one `dsh-app://app/…` request to the host and stream its response
   * back. The request body is uploaded chunk by chunk, so a large export or
   * file upload never has to fit in memory twice.
   * @param request - the protocol request, body included.
   * @returns the host's response; its body streams until the child ends it.
   */
  async fetch(request: Request): Promise<Response> {
    const child = this.child
    if (child === undefined || !child.connected || this.requestPipe === undefined || !this.ready) {
      throw new Error('dsh host is not running')
    }
    if (this.nextStreamId > 0xffff_ffff) throw new Error('dsh host exhausted its request stream ids')
    const streamId = this.nextStreamId++
    const method = request.method.toUpperCase()
    const hasBody = method !== 'GET' && method !== 'HEAD' && request.body !== null
    return new Promise<Response>((resolve, reject) => {
      const pending: PendingResponse = { resolve, reject, responseStarted: false, uploadOpen: hasBody }
      const abort = (): void => {
        if (!this.pending.has(streamId)) return
        const error = errorOf(request.signal.reason, 'request aborted')
        pending.uploadOpen = false
        void pending.requestReader?.cancel(error).catch(() => undefined)
        void this.enqueueRequestFrame(encodeRequestCancel(streamId)).catch((pipeError: unknown) => {
          this.fail(errorOf(pipeError, 'dsh host request pipe failed'))
        })
        if (pending.controller === undefined) pending.reject(error)
        else pending.controller.error(error)
        this.finishPending(streamId, false)
      }
      if (request.signal.aborted) {
        reject(errorOf(request.signal.reason, 'request aborted'))
        return
      }
      request.signal.addEventListener('abort', abort, { once: true })
      pending.removeAbort = () => { request.signal.removeEventListener('abort', abort) }
      this.pending.set(streamId, pending)
      void this.pumpRequest(streamId, request, hasBody).catch((error: unknown) => {
        this.failPending(streamId, errorOf(error, 'dsh host request upload failed'))
      })
    })
  }

  /** Request teardown and wait for the child to be gone. */
  async stop(): Promise<void> {
    const child = this.child
    if (child === undefined) return
    this.stopping = true
    this.blockedResponses.clear()
    this.responsePipe?.resume()
    const exited = this.exitPromise ?? Promise.resolve()
    try {
      if (child.connected) child.send({ type: 'shutdown' })
    } catch {
      // A channel that closed between the check and the send is already teardown.
    }
    // Destroying the parent's write end is what releases the child's pending
    // Windows pipe read: without it a stopped reader keeps it parked on read()
    // and the process never exits.
    this.requestPipe?.destroy()
    if (!await exitsWithin(exited, HOST_SHUTDOWN_GRACE_MS)) {
      child.kill('SIGTERM')
      if (!await exitsWithin(exited, HOST_SIGNAL_GRACE_MS)) {
        await this.killTree(child)
        if (!await exitsWithin(exited, HOST_SIGNAL_GRACE_MS)) {
          throw new Error('dsh host did not exit after being killed')
        }
      }
    }
    this.child = undefined
    this.requestPipe = undefined
    this.responsePipe = undefined
  }

  /**
   * Kill the host and its own children. On Windows `child.kill` terminates one
   * process and leaves anything the host spawned (a shell tool's child, a
   * native helper) behind, so the tree killer is the only way to guarantee the
   * app leaves nothing running after it quits.
   */
  private async killTree(child: ChildProcess): Promise<void> {
    const pid = child.pid
    if (pid === undefined) return
    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
        killer.once('exit', () => { resolve() })
        killer.once('error', () => { resolve() })
      })
      return
    }
    child.kill('SIGKILL')
  }

  /** The failure a dead child leaves behind, with its own last words. */
  private exitError(code: number | null, signal: NodeJS.Signals | null): Error {
    const how = code === null ? `signal ${String(signal)}` : `exit code ${String(code)}`
    const tail = this.stderrTail.trim()
    // The child's stderr can carry credential material (a provider echoing a
    // key), and this message ends up in a user-visible status line.
    return new Error(redact(tail === '' ? `dsh host stopped with ${how}` : `dsh host ${how}: ${tail}`))
  }

  private async pumpRequest(streamId: number, request: Request, hasBody: boolean): Promise<void> {
    const headers: Array<[string, string]> = []
    // `Headers` is iterable in the browser only with DOM.Iterable; forEach is
    // the shape both lib sets agree on.
    request.headers.forEach((value, name) => { headers.push([name, value]) })
    await this.enqueueRequestFrame(encodeRequestStart(streamId, {
      url: request.url,
      method: request.method.toUpperCase(),
      headers,
      hasBody,
    }))
    if (!hasBody) return
    const body = request.body
    if (body === null) throw new Error('dsh host request body disappeared before upload')
    const reader = body.getReader()
    const pending = this.pending.get(streamId)
    if (pending === undefined) {
      await reader.cancel()
      return
    }
    pending.requestReader = reader
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        for (let offset = 0; offset < next.value.byteLength; offset += PIPE_CHUNK_BYTES) {
          if (!this.pending.has(streamId)) return
          await this.enqueueRequestFrame(encodeRequestData(streamId, next.value.subarray(offset, offset + PIPE_CHUNK_BYTES)))
        }
      }
      const live = this.pending.get(streamId)
      if (live !== undefined) {
        await this.enqueueRequestFrame(encodeRequestEnd(streamId))
        live.uploadOpen = false
      }
    } finally {
      reader.releaseLock()
      const live = this.pending.get(streamId)
      if (live?.requestReader === reader) delete live.requestReader
    }
  }

  /** Serialize every request-pipe write, applying the pipe's own backpressure. */
  private enqueueRequestFrame(frame: Buffer): Promise<void> {
    const write = this.requestWriteTail.then(async () => {
      const pipe = this.requestPipe
      if (pipe === undefined || pipe.destroyed) throw new Error('dsh host request pipe is unavailable')
      if (!pipe.write(frame)) await once(pipe, 'drain')
    })
    this.requestWriteTail = write.catch(() => undefined)
    return write
  }

  private acceptResponseBytes(chunk: Buffer): void {
    try {
      for (const frame of this.decoder.push(chunk)) this.handleResponseFrame(frame)
    } catch (error) {
      this.fail(errorOf(error, 'dsh host response pipe failed'))
      this.child?.kill('SIGTERM')
    }
  }

  private handleResponseFrame(frame: ResponseFrame): void {
    const pending = this.pending.get(frame.streamId)
    if (pending === undefined) {
      // A response for a stream this process never opened is a protocol
      // violation, but one for a stream it already finished is not (the
      // renderer can abort a request while the host is still answering it).
      if (frame.streamId >= this.nextStreamId) {
        throw new Error(`dsh host responded for unknown stream ${String(frame.streamId)}`)
      }
      return
    }
    switch (frame.type) {
      case 'start': {
        if (pending.responseStarted) throw new Error(`dsh host started stream ${String(frame.streamId)} twice`)
        pending.responseStarted = true
        let body: ReadableStream<Uint8Array> | null = null
        if (frame.hasBody) {
          body = new ReadableStream<Uint8Array>({
            start: (controller) => { pending.controller = controller },
            // The child pauses its own pipe when a frame does not fit; resuming
            // it is this side's job once the consumer asked for more.
            pull: () => {
              this.blockedResponses.delete(frame.streamId)
              this.resumeResponsePipe()
            },
            cancel: (reason) => { this.cancelResponse(frame.streamId, reason) },
          })
        }
        pending.resolve(new Response(body, {
          status: frame.status,
          headers: new Headers(frame.headers.map(([name, value]) => [name, value] as [string, string])),
        }))
        return
      }
      case 'data': {
        const controller = pending.controller
        if (!pending.responseStarted || controller === undefined) {
          throw new Error(`dsh host sent body data before a body start for stream ${String(frame.streamId)}`)
        }
        controller.enqueue(frame.data)
        if ((controller.desiredSize ?? 0) <= 0) {
          this.blockedResponses.add(frame.streamId)
          this.responsePipe?.pause()
        }
        return
      }
      case 'end':
        if (!pending.responseStarted) {
          throw new Error(`dsh host ended stream ${String(frame.streamId)} before its response start`)
        }
        pending.controller?.close()
        this.finishPending(frame.streamId, true)
        return
      case 'error':
        this.failPending(frame.streamId, new Error(frame.message))
        return
      default:
        frame satisfies never
    }
  }

  private cancelResponse(streamId: number, reason: unknown): void {
    const pending = this.pending.get(streamId)
    if (pending === undefined) return
    pending.uploadOpen = false
    void pending.requestReader?.cancel(reason).catch(() => undefined)
    void this.enqueueRequestFrame(encodeRequestCancel(streamId)).catch((error: unknown) => {
      this.fail(errorOf(error, 'dsh host request pipe failed'))
    })
    this.finishPending(streamId, false)
  }

  /** Fail one response and tell the host to stop working on it. */
  private failPending(streamId: number, error: Error): void {
    const pending = this.pending.get(streamId)
    if (pending === undefined) return
    pending.uploadOpen = false
    void pending.requestReader?.cancel(error).catch(() => undefined)
    if (pending.controller === undefined) pending.reject(error)
    else pending.controller.error(error)
    void this.enqueueRequestFrame(encodeRequestCancel(streamId)).catch((pipeError: unknown) => {
      this.fail(errorOf(pipeError, 'dsh host request pipe failed'))
    })
    this.finishPending(streamId, false)
  }

  private finishPending(streamId: number, cancelOpenUpload: boolean): void {
    const pending = this.pending.get(streamId)
    if (pending === undefined) return
    if (cancelOpenUpload && pending.uploadOpen) {
      pending.uploadOpen = false
      void pending.requestReader?.cancel().catch(() => undefined)
      void this.enqueueRequestFrame(encodeRequestCancel(streamId)).catch((error: unknown) => {
        this.fail(errorOf(error, 'dsh host request pipe failed'))
      })
    }
    pending.removeAbort?.()
    this.pending.delete(streamId)
    this.blockedResponses.delete(streamId)
    this.resumeResponsePipe()
  }

  private resumeResponsePipe(): void {
    if (this.blockedResponses.size === 0) this.responsePipe?.resume()
  }

  private handleMessage(message: HostEvent): void {
    switch (message.type) {
      case 'ready':
        if (message.protocolVersion !== HOST_PROTOCOL_VERSION) {
          this.fail(new Error(`dsh host speaks protocol ${String(message.protocolVersion)}, this shell speaks ${String(HOST_PROTOCOL_VERSION)}`))
          return
        }
        this.ready = true
        this.version = message.dshVersion
        this.settleReady()
        return
      case 'fatal':
        this.fail(new Error(redact(message.message)))
        return
      default:
        message satisfies never
    }
  }

  /** Fail readiness and every in-flight request exactly once. */
  private fail(error: Error): void {
    this.failReady(error)
    if (this.failureReported) return
    this.failureReported = true
    for (const pending of this.pending.values()) {
      void pending.requestReader?.cancel(error).catch(() => undefined)
      if (pending.controller === undefined) pending.reject(error)
      else pending.controller.error(error)
      pending.removeAbort?.()
    }
    this.pending.clear()
    this.blockedResponses.clear()
    this.responsePipe?.resume()
  }
}

function isHostEvent(message: unknown): message is HostEvent {
  if (!isRecord(message) || typeof message.type !== 'string') return false
  switch (message.type) {
    case 'ready':
      return typeof message.protocolVersion === 'number' && typeof message.dshVersion === 'string'
    case 'fatal':
      return typeof message.message === 'string'
    default:
      return false
  }
}

/**
 * Claim the private scheme BEFORE the app is ready, so Electron treats it as
 * standard (a real origin, relative URLs resolve) and secure (the page counts
 * as a trustworthy origin, which the harness UI's APIs need). This must run at
 * module load; a later call is silently ignored by Electron.
 */
export function registerDshAppScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
      stream: true,
      codeCache: true,
    },
  }])
}

/**
 * Serve `dsh-app://app/…` from the host: every path — the UI's assets, the
 * plugin client bundles, `/api/…` and the streaming transport — is one request
 * to the child, which routes it exactly as the web server did. Anything else
 * (another host in this scheme) is a 404 rather than a redirect or a blank
 * page: nothing in the app is allowed to claim a second origin within it.
 *
 * The shell's own routes run FIRST and in this process: a `route` that claims a
 * request answers it without the host being involved, which is what keeps the
 * native action seam working while the kernel is down (the case where a user
 * most needs the log folder). Everything the route declines is forwarded.
 *
 * @param target - the current host, or null while none is running (503).
 * @param route - the shell's own handler for this origin, if it has one.
 */
export function installDshAppProtocol(target: () => DshAppTarget | null, route?: DshAppRoute): void {
  protocol.handle(APP_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response(null, { status: 400 })
    }
    if (url.hostname !== 'app') return new Response(null, { status: 404 })
    if (route !== undefined) {
      const claimed = await route(request)
      if (claimed !== null) return claimed
    }
    const host = target()
    if (host === null) return new Response('backend unavailable', { status: 503 })
    try {
      return await host.fetch(request)
    } catch (error) {
      // A dead host (or a request aborted with the window) is reported as an
      // unavailable backend instead of an unhandled rejection: the page shows
      // its own error state either way, and the crash path is driven by the
      // host's exit event, not by this request.
      return new Response(error instanceof Error ? error.message : 'backend unavailable', { status: 503 })
    }
  })
}
