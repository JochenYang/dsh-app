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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const libEntry = join(pluginRoot, 'lib', 'index.js')

interface FakeExec {
  agent: { session: { header: { id: string, cwd: string } } }
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

/** Mount the built bundle against the fake host surfaces it injects. */
async function mountHost(): Promise<FakeHost> {
  const tools = new Map<string, FakeTool>()
  const routes: FakeRoute[] = []
  const sections: FakeSection[] = []
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {} }),
    effect: (run: () => unknown) => { run() },
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

/** Wait until the fire-and-forget disk writes of the host settle. */
function settle(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 50) })
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
    assert.deepEqual([...host.tools.keys()].sort(), ['pdf_check', 'pdf_read', 'pdf_render', 'pdf_write'])
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
    await settle()
    assert.ok(existsSync(join(home, 'skills', 'dsh-pdf', 'SKILL.md')), 'dsh-pdf skill installed')
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
    assert.equal(
      (JSON.parse(readFileSync(modeFile, 'utf8')) as Record<string, { enabled: boolean }>)[session]?.enabled,
      true,
      'the toggle persisted to the DSH_HOME store',
    )

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
    const exec: FakeExec = { agent: { session: { header: { id: 'session-1', cwd: root } } } }
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
