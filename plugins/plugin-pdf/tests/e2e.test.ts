/**
 * End-to-end host chain: the built bundle's `apply` is mounted against a fake
 * host context (tools registry, prompt sections, Connection exact-Fetch routes,
 * logger), the PDF-mode route and the prompt provider are exercised for real,
 * and the full pdf_write → pdf_check → pdf_render → pdf_read chain runs against
 * a real workspace. The rendered PDF is fed back through the read tool, so the
 * export is proven to be readable selectable text rather than assumed from a
 * byte count.
 *
 * The bundle under test is `lib/index.js` (the artifact the kernel loads), so
 * this also pins the ESM require handoff the bundled dependencies need and the
 * runtime resolution of the sibling font asset.
 *
 * @module @dsh-app/plugin-pdf/tests/e2e
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const libEntry = join(pluginRoot, 'lib', 'index.js')

interface FakeExec {
  agent: { session: { header: { id: string, cwd: string } } }
  /** The registry always hands a tool a cancellation signal. */
  signal: AbortSignal
}

interface FakeTool {
  name: string
  execute(args: Record<string, unknown>, exec: FakeExec): Promise<Record<string, unknown>>
}

interface FakeRoute {
  path: string
  methods: readonly string[]
  requestBody: string
  fetch(request: Request): Promise<Response>
}

interface FakeSection {
  name: string
  order: number
  text: string | ((context: unknown) => string)
}

interface FakeHost {
  tools: Map<string, FakeTool>
  routes: FakeRoute[]
  sections: FakeSection[]
}

/** One `officeToPdf.render` call, captured for assertions. */
interface FakeRenderCall {
  scope: { sessionId: string, workspaceRoot: string }
  path: string
  priority: string
  aborted: boolean
}

/**
 * The host's office-conversion service as a tool sees it: `render` hands back a
 * base64 PDF, or rejects with the code the caller maps to a message.
 */
interface FakeOfficeService {
  calls: FakeRenderCall[]
  pdf: Uint8Array
  missingFonts?: string[]
  fail?: { reason: string }
}

/** Mount the built bundle against the fake host surfaces it injects. */
async function mountHost(office?: FakeOfficeService): Promise<FakeHost> {
  const tools = new Map<string, FakeTool>()
  const routes: FakeRoute[] = []
  const sections: FakeSection[] = []
  const services = new Map<string, unknown>()
  if (office !== undefined) {
    services.set('officeToPdf', {
      async render(
        scope: FakeRenderCall['scope'], path: string, priority: string, signal: AbortSignal,
      ): Promise<{ data: Uint8Array, missingFonts: string[] }> {
        office.calls.push({ scope, path, priority, aborted: signal.aborted })
        if (office.fail !== undefined) {
          // The provider's own shape: one remote code plus the engine reason.
          throw Object.assign(new Error('Office conversion failed.'), {
            code: 'document-render/failed',
            details: { reason: office.fail.reason },
          })
        }
        // 0.1.7 hands the converted document back as BYTES
        // (`RenderedDocumentBytes extends WorkspaceFileBytes`, part of the
        // workspace-file unification on `readBytes`). This stub returned the
        // previous line's base64 string, which the tool would now copy into the
        // output file verbatim — the test caught exactly that.
        return { data: office.pdf, missingFonts: office.missingFonts ?? [] }
      },
    })
  }
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {} }),
    effect: (run: () => unknown) => { run() },
    get: (name: string) => services.get(name),
    tools: {
      register(tool: FakeTool) {
        tools.set(tool.name, tool)
        return () => {}
      },
    },
    systemPrompt: {
      section(descriptor: FakeSection) {
        sections.push(descriptor)
        return () => {}
      },
    },
    connection: {
      fetch: {
        register(route: FakeRoute) {
          routes.push(route)
          return Promise.resolve()
        },
      },
    },
  }
  const mod = await import(pathToFileURL(libEntry).href) as { apply(context: unknown): void }
  mod.apply(ctx)
  return { tools, routes, sections }
}

/**
 * One request against a captured route, through the carrier's own contract: the
 * handler receives a Fetch `Request` and answers a `Response`.
 */
async function callRoute(
  route: FakeRoute,
  init?: RequestInit,
): Promise<{ status: number, body: Record<string, unknown> }> {
  const response = await route.fetch(new Request(`dsh-app://app${route.path}`, init))
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

/** A prompt section's text for one assembly context ('' when it is a string). */
function sectionText(section: FakeSection | undefined, context: unknown): string {
  if (section === undefined) return ''
  return typeof section.text === 'function' ? section.text(context) : section.text
}

/**
 * Let in-memory fire-and-forget work settle. NOT for disk state — 50 ms loses
 * that race under load; use `waitForFile` / `readModeFile` there.
 */
function settle(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 50) })
}

/**
 * The mode store persists on a promise tail, so a read right after a POST
 * races the write. Poll until the file on disk reaches the expected state
 * instead of trusting a fixed sleep (a fast Linux runner loses that race —
 * measured: plugin-doc's e2e failed on CI and passed on Windows).
 */
async function readModeFile(
  file: string,
  predicate: (value: Record<string, unknown>) => boolean,
  timeoutMs = 2_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (existsSync(file)) {
      const value = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      if (predicate(value)) return value
    }
    if (Date.now() > deadline) throw new Error(`mode.json never reached the expected state: ${file}`)
    await new Promise(resolve => { setTimeout(resolve, 10) })
  }
}

/**
 * Poll until a file the host writes fire-and-forget exists. Measured: the skill
 * install outlasts a fixed 50 ms sleep on a loaded machine, and this assertion
 * failed once in 34 runs here for exactly that reason. The installer writes
 * atomically (`writeFileAtomic`), so existence means the content is complete.
 */
async function waitForFile(file: string, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (existsSync(file)) return true
    if (Date.now() > deadline) return false
    await new Promise(resolve => { setTimeout(resolve, 10) })
  }
}

/** Whitespace-insensitive containment: wrapped lines join without spaces. */
function compact(text: string): string {
  return text.replace(/\s+/gu, '')
}

const PROJECT = {
  title: '二〇二六年第一季度评审',
  author: '增长组',
  size: 'a4',
  blocks: [
    { heading: { level: 1, text: '核心结论' } },
    { paragraph: { text: '本季度核心指标全面达标。' } },
    { bullets: ['营收同比增长 22%', '毛利率提升 3.3 个百分点'] },
    { heading: { level: 2, text: '关键指标' } },
    { table: { headers: ['指标', '本期'], rows: [['营收', '1,280 万'], ['毛利率', '34.5%']] } },
    { pageBreak: true },
    { heading: { level: 1, text: '附录' } },
    { paragraph: { text: '数据来源：财务系统。' } },
  ],
}

test('e2e: apply registers the PDF tools, prompt sections and mode route', async () => {
  assert.ok(existsSync(libEntry), 'lib/index.js must be built (npm run build) before the e2e test')
  const home = mkdtempSync(join(tmpdir(), 'pdfd-e2e-home-'))
  const savedHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = home
    const host = await mountHost()
    assert.deepEqual([...host.tools.keys()].sort(), ['office_to_pdf', 'pdf_check', 'pdf_read', 'pdf_render', 'pdf_write'])
    const names = host.sections.map(section => section.name)
    assert.ok(names.includes('tool:pdf-entry'), 'unconditional entry rule registered')
    assert.ok(names.includes('tool:pdf-mode'), 'conditional mode section registered')
    const entry = host.sections.find(section => section.name === 'tool:pdf-entry')
    assert.equal(typeof entry?.text, 'string')
    assert.match(String(entry?.text), /pdf_read/u)
    const mode = host.sections.find(section => section.name === 'tool:pdf-mode')
    // No agent / no session / mode off all read as "nothing to inject".
    assert.equal(sectionText(mode, {}), '')
    assert.equal(sectionText(mode, { agent: { session: { header: { id: 'nobody' } } } }), '')
    assert.deepEqual(host.routes.map(route => route.path), [
      '/api/plugins/dsh-app/plugin-pdf/mode',
      '/api/plugins/dsh-app/plugin-pdf/office-active',
      '/api/plugins/dsh-app/plugin-pdf/font-status',
    ])
    // The registry scopes methods per route: the mode write is the only verb
    // beyond a read, and the route carries no path parameter.
    assert.deepEqual(host.routes.map(route => route.methods), [['GET', 'POST'], ['GET'], ['GET']])
    assert.deepEqual(host.routes.map(route => route.requestBody), ['buffered', 'buffered', 'buffered'])
    // The skill installer ran against the temp DSH_HOME.
    assert.ok(await waitForFile(join(home, 'skills', 'dsh-pdf', 'SKILL.md')), 'dsh-pdf skill installed')
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('e2e: PDF mode round-trips through the route and drives the prompt section', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pdfd-e2e-mode-home-'))
  const savedHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = home
    const host = await mountHost()
    const route = host.routes[0]
    assert.ok(route !== undefined)
    const modeSection = host.sections.find(section => section.name === 'tool:pdf-mode')
    const readPrompt = (sessionId: string): string =>
      sectionText(modeSection, { agent: { session: { header: { id: sessionId } } } })
    const session = 'session-1'
    const modeFile = join(home, 'storages', 'dsh-app-plugin-pdf', 'mode.json')

    assert.equal(readPrompt(session), '', 'mode starts off')

    const enabled = await callRoute(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session, enabled: true }),
    })
    await settle()
    assert.equal(enabled.status, 200)
    assert.equal((enabled.body as { value: { enabled: boolean } }).value.enabled, true)
    assert.match(readPrompt(session), /pdf_write/u, 'enabled session gets the workflow directive')
    await readModeFile(modeFile, (value) => (value[session] as { enabled?: boolean } | undefined)?.enabled === true)

    const read = await callRoute(route, { method: 'GET' })
    assert.equal(read.body.ok, false, 'the read requires a session id')

    const queried = await callRoute({ ...route, path: `${route.path}?sessionId=${session}` })
    assert.equal((queried.body as { value: { enabled: boolean } }).value.enabled, true)

    // A bad payload is refused and leaves the state alone.
    const bad = await callRoute(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session, enabled: 'yes' }),
    })
    assert.equal(bad.status, 400)
    assert.match(readPrompt(session), /pdf_write/u)

    const off = await callRoute(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session, enabled: false }),
    })
    await settle()
    assert.equal(off.status, 200)
    assert.equal(readPrompt(session), '', 'turning the mode off stops the directive')
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('e2e: font-status route reports the bundled CJK asset as readable', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pdfd-e2e-font-home-'))
  const savedHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = home
    const host = await mountHost()
    const route = host.routes.find(candidate => candidate.path.endsWith('/font-status'))
    assert.ok(route !== undefined, 'font-status route registered')

    const get = await callRoute(route, { method: 'GET' })
    await settle()
    assert.equal(get.status, 200)
    const value = get.body as { ok: boolean, value: { available: boolean, bytes: number } }
    assert.equal(value.ok, true)
    assert.equal(value.value.available, true, 'the bundled font asset must ship beside lib/')
    assert.ok(value.value.bytes > 0, 'the bundled font asset must be non-empty')

    // The diagnostic is read-only, so the registry owns GET alone; any other
    // verb never reaches this handler (the shared channel answers its own 404).
    assert.deepEqual(route.methods, ['GET'])
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('e2e: write, check, render and read back a real PDF', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pdfd-e2e-chain-'))
  const home = mkdtempSync(join(tmpdir(), 'pdfd-e2e-chain-home-'))
  const savedHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = home
    const host = await mountHost()
    const exec: FakeExec = { agent: { session: { header: { id: 'session-1', cwd: root } } }, signal: new AbortController().signal }
    const write = host.tools.get('pdf_write')
    const check = host.tools.get('pdf_check')
    const render = host.tools.get('pdf_render')
    const read = host.tools.get('pdf_read')
    assert.ok(write !== undefined && check !== undefined && render !== undefined && read !== undefined)

    const relative = 'docs/report.pdf.json'

    // 1. A malformed table is refused before the filesystem is touched.
    const rejected = await write.execute({
      file_path: relative,
      content: JSON.stringify({
        title: '坏文档',
        blocks: [{ table: { headers: ['A', 'B'], rows: [['只有一个']] } }],
      }),
    }, exec)
    assert.equal(rejected.status, 'needs_revision')
    assert.ok((rejected.errorCount as number) > 0)
    assert.match(rejected.issuesText as string, /table-row-shape/u)
    assert.equal(existsSync(join(root, 'docs', 'report.pdf.json')), false, 'nothing written on error')

    // 2. The real project is written and its revision is returned.
    const content = JSON.stringify(PROJECT, null, 2)
    const written = await write.execute({ file_path: relative, content }, exec)
    assert.equal(written.status, 'written')
    assert.equal(written.operation, 'create')
    const sha = written.sha256 as string
    assert.match(sha, /^[0-9a-f]{64}$/u)
    assert.equal(readFileSync(join(root, 'docs', 'report.pdf.json'), 'utf8'), content)

    // 3. Overwriting without the revision is refused; with it, it replaces.
    const noRevision = await write.execute({ file_path: relative, content }, exec)
    assert.equal(noRevision.status, 'needs_revision')
    assert.match(noRevision.issuesText as string, /expected_sha256/u)
    const replaced = await write.execute({ file_path: relative, content, expected_sha256: sha }, exec)
    assert.equal(replaced.status, 'written')
    assert.equal(replaced.operation, 'replace')

    // 4. The read-only check agrees the project is clean.
    const checked = await check.execute({ file_path: relative }, exec)
    assert.equal(checked.status, 'ok')
    assert.equal(checked.errorCount, 0)
    assert.equal(checked.blockCount, 8)
    assert.match(checked.issuesText as string, /校验通过/u)

    // 5. Rendering exports a real PDF.
    const rendered = await render.execute({ file_path: relative, output_file: 'docs/report.pdf' }, exec)
    assert.equal(rendered.status, 'exported', `render must export: ${String(rendered.issuesText)}`)
    assert.equal(rendered.blockCount, 8)
    // The built bundle must find the sibling font asset at runtime; a fallback
    // to a system font would make the export machine-dependent.
    assert.equal(rendered.fontSource, 'built-in', `unexpected font: ${String(rendered.fontSource)}`)
    const pdfPath = join(root, 'docs', 'report.pdf')
    assert.ok(existsSync(pdfPath), 'output PDF exists')
    const bytes = readFileSync(pdfPath)
    assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-')
    assert.equal(bytes.byteLength, rendered.sizeBytes)

    // 6. The read leg round-trips the rendered file: pagination, text, footer
    //    and metadata all come back as real selectable text.
    const summary = await read.execute({ file_path: 'docs/report.pdf' }, exec)
    assert.equal(summary.status, 'ok', `read must succeed: ${String(summary.issuesText)}`)
    assert.equal(summary.pageCount, 2)
    assert.equal(summary.title, PROJECT.title)
    assert.equal(summary.author, '增长组')
    const body = compact((summary.pages as string[]).join('\n'))
    for (const fragment of ['核心结论', '营收同比增长22%', '1,280万', '34.5%', '数据来源：财务系统', '第1页/共2页', '第2页/共2页']) {
      assert.ok(body.includes(compact(fragment)), `missing ${fragment} in ${body}`)
    }

    // 7. The render gate refuses a broken project and writes no output.
    const broken = JSON.stringify({
      title: '坏文档',
      blocks: [{ heading: { level: 1, text: 'A' }, paragraph: { text: 'B' } }],
    })
    // Written directly: pdf_write refuses this project, which is the point of
    // the gate that pdf_render must also enforce.
    writeFileSync(join(root, 'broken.pdf.json'), broken, 'utf8')
    const gated = await render.execute({ file_path: 'broken.pdf.json', output_file: 'broken.pdf' }, exec)
    assert.equal(gated.status, 'needs_revision')
    assert.match(gated.issuesText as string, /multiple-content/u)
    assert.equal(existsSync(join(root, 'broken.pdf')), false, 'no output on a failed gate')

    // 8. Missing inputs, unsafe paths and wrong extensions are actionable.
    const missing = await check.execute({ file_path: 'nope.pdf.json' }, exec)
    assert.equal(missing.status, 'needs_revision')
    assert.match(String((missing.issues as { message: string }[])[0]?.message), /不存在/u)
    const escaping = await write.execute({ file_path: '../escape.pdf.json', content }, exec)
    assert.equal(escaping.status, 'needs_revision')
    assert.match(String((escaping.issues as { message: string }[])[0]?.message), /越出工作区/u)
    const wrongExtension = await check.execute({ file_path: 'report.pdf' }, exec)
    assert.equal(wrongExtension.status, 'needs_revision')
    assert.match(String((wrongExtension.issues as { message: string }[])[0]?.message), /pdf\.json/u)
    const unreadable = await read.execute({ file_path: 'docs/missing.pdf' }, exec)
    assert.equal(unreadable.status, 'failed')
    assert.match(String((unreadable.issues as { message: string }[])[0]?.message), /不存在/u)
    const wrongReadExtension = await read.execute({ file_path: 'docs/report.pdf.json' }, exec)
    assert.equal(wrongReadExtension.status, 'failed')
    assert.match(String((wrongReadExtension.issues as { message: string }[])[0]?.message), /\.pdf/u)
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('e2e: office_to_pdf converts through the host service and reports honestly', async () => {
  assert.ok(existsSync(libEntry), 'lib/index.js must be built (npm run build) before the e2e test')
  const home = mkdtempSync(join(tmpdir(), 'pdfd-e2e-office-home-'))
  const root = mkdtempSync(join(tmpdir(), 'pdfd-e2e-office-root-'))
  const savedHome = process.env.DSH_HOME
  // A minimal but real PDF header: the tool copies bytes, it does not parse.
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1')
  const office: FakeOfficeService = { calls: [], pdf, missingFonts: ['Noto Sans CJK SC'] }
  try {
    process.env.DSH_HOME = home
    const host = await mountHost(office)
    const exec: FakeExec = { agent: { session: { header: { id: 'session-9', cwd: root } } }, signal: new AbortController().signal }
    const convert = host.tools.get('office_to_pdf')
    assert.ok(convert !== undefined, 'office_to_pdf is registered')
    writeFileSync(join(root, 'deck.pptx'), 'pptx-bytes', 'utf8')

    // 1. A normal conversion: the provider is asked for exactly the session's
    //    own workspace, the output lands where the caller asked, and the result
    //    carries the identity of what was written.
    const exported = await convert.execute({ file_path: 'deck.pptx', output_file: 'out/deck.pdf' }, exec)
    assert.equal(exported.status, 'exported', `convert must export: ${String(exported.issuesText)}`)
    assert.deepEqual(office.calls.map(call => [call.scope, call.path, call.priority]), [
      [{ sessionId: 'session-9', workspaceRoot: root }, 'deck.pptx', 'foreground'],
    ])
    const written = readFileSync(join(root, 'out', 'deck.pdf'))
    assert.equal(written.toString('latin1'), pdf.toString('latin1'))
    assert.equal(exported.sizeBytes, pdf.byteLength)
    assert.equal(exported.sha256, createHash('sha256').update(pdf).digest('hex'))
    assert.deepEqual(exported.missingFonts, ['Noto Sans CJK SC'])

    // 2. An existing target is replaced rather than refused (re-converting the
    //    same deck is the ordinary case).
    writeFileSync(join(root, 'out', 'deck.pdf'), 'old', 'utf8')
    const again = await convert.execute({ file_path: 'deck.pptx', output_file: 'out/deck.pdf' }, exec)
    assert.equal(again.status, 'exported')
    assert.equal(readFileSync(join(root, 'out', 'deck.pdf')).toString('latin1'), pdf.toString('latin1'))

    // 3. The engine being absent is the one failure a user can fix, so it must
    //    name the fix instead of the provider's preview wording — but only when
    //    this kernel declares an office component at all: a development run
    //    boots a checkout with no engine, and sending it to a download button
    //    that the 诊断 row does not offer would be a dead end.
    office.fail = { reason: 'unavailable' }
    process.env.DSH_APP_OFFICE_PAYLOAD = 'C:/payload/0.0.1'
    const noEngine = await convert.execute({ file_path: 'deck.pptx', output_file: 'out/missing.pdf' }, exec)
    assert.equal(noEngine.status, 'failed')
    const noEngineText = String((noEngine.issues as { message: string }[])[0]?.message)
    assert.match(noEngineText, /办公文档转换引擎尚未安装/u)
    assert.match(noEngineText, /办公组件/u)
    assert.equal(existsSync(join(root, 'out', 'missing.pdf')), false, 'no output when the engine refuses')

    // 3b. The same code without a declared component reads as what it is.
    process.env.DSH_APP_OFFICE_PAYLOAD = ''
    try {
      const undeclared = await convert.execute({ file_path: 'deck.pptx', output_file: 'out/missing.pdf' }, exec)
      const undeclaredText = String((undeclared.issues as { message: string }[])[0]?.message)
      assert.match(undeclaredText, /未声明办公组件/u)
      assert.doesNotMatch(undeclaredText, /诊断/u, 'no download button to send a development run to')
    } finally {
      delete process.env.DSH_APP_OFFICE_PAYLOAD
    }

    // 4. Every other engine reason still reads as its own sentence.
    office.fail = { reason: 'invalid-document' }
    const corrupt = await convert.execute({ file_path: 'deck.pptx', output_file: 'out/x.pdf' }, exec)
    assert.match(String((corrupt.issues as { message: string }[])[0]?.message), /受密码保护/u)

    // 5. Without the host service the tool says so; it never pretends to have
    //    converted anything.
    office.fail = undefined
    process.env.DSH_APP_OFFICE_PAYLOAD = 'C:/payload/0.0.1'
    const bare = await mountHost()
    const orphan = await bare.tools.get('office_to_pdf')?.execute({ file_path: 'deck.pptx', output_file: 'out/y.pdf' }, exec)
    assert.equal(orphan?.status, 'failed')
    assert.match(String((orphan?.issues as { message: string }[])[0]?.message), /内核没有办公文档转换服务/u)
    delete process.env.DSH_APP_OFFICE_PAYLOAD

    // 6. Path discipline matches the other tools: only Office extensions, only
    //    contained relative paths, only a .pdf target.
    const refusals: [Record<string, unknown>, RegExp][] = [
      [{ file_path: 'notes.txt', output_file: 'out/a.pdf' }, /\.doc \/ \.docx/u],
      [{ file_path: 'absent.pptx', output_file: 'out/b.pdf' }, /不存在/u],
      [{ file_path: '../escape.pptx', output_file: 'out/c.pdf' }, /越出工作区/u],
      [{ file_path: 'deck.pptx', output_file: 'out/d.pptx' }, /\.pdf 结尾/u],
    ]
    for (const [args, expected] of refusals) {
      const refused = await convert.execute(args, exec)
      assert.equal(refused.status, 'failed', `${String(args.file_path)} must be refused`)
      assert.match(String((refused.issues as { message: string }[])[0]?.message), expected)
    }
    assert.equal(existsSync(join(root, 'out', 'a.pdf')), false, 'refusals write nothing')
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})
