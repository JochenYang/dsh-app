/**
 * End-to-end host chain: the built bundle's `apply` is mounted against a fake
 * host context (tools registry, prompt sections, Connection Fetch routes,
 * logger), the Word-mode route and the prompt provider are exercised for real,
 * and the full doc_write → doc_check → doc_render chain runs against a real
 * workspace. The
 * produced .docx is unzipped and asserted to be a valid OOXML package holding
 * the document's Chinese text.
 *
 * The bundle under test is `lib/index.js` (the artifact the kernel loads), so
 * this also pins the ESM require handoff the bundled docx dependency needs.
 *
 * @module @dsh-app/plugin-doc/tests/e2e
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isZip, readZipEntries } from './zip.ts'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const libEntry = join(pluginRoot, 'lib', 'index.js')

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

interface FakeExec {
  agent: { session: { header: { id: string, cwd: string } } }
}

interface FakeTool {
  name: string
  execute(args: Record<string, unknown>, exec: FakeExec): Promise<Record<string, unknown>>
}

/** One captured Connection exact-Fetch route. */
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
          return Promise.resolve(async () => undefined)
        },
      },
    },
  }
  const mod = await import(pathToFileURL(libEntry).href) as { apply(context: unknown): void }
  mod.apply(ctx)
  return { tools, routes, sections }
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

/**
 * The mode store persists on a promise tail, so a synchronous read right after
 * a POST races the write (it loses that race deterministically on a fast
 * Linux runner and won on Windows — a green local run proves nothing here).
 * Poll until the file on disk reaches the expected state instead of sleeping.
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

test('e2e: apply registers the Word tools, prompt sections and mode route', async () => {
  assert.ok(existsSync(libEntry), 'lib/index.js must be built (npm run build) before the e2e test')
  const root = mkdtempSync(join(tmpdir(), 'docd-e2e-mount-'))
  const home = mkdtempSync(join(tmpdir(), 'docd-e2e-home-'))
  const savedHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = home
    const host = await mountHost()
    assert.deepEqual([...host.tools.keys()].sort(), ['doc_check', 'doc_render', 'doc_write'])
    const names = host.sections.map(section => section.name)
    assert.ok(names.includes('tool:doc-entry'), 'unconditional entry rule registered')
    assert.ok(names.includes('tool:doc-mode'), 'conditional mode section registered')
    const entry = host.sections.find(section => section.name === 'tool:doc-entry')
    assert.equal(typeof entry?.text, 'string')
    assert.match(String(entry?.text), /\.docx/u)
    const mode = host.sections.find(section => section.name === 'tool:doc-mode')
    // No agent / no session / mode off all read as "nothing to inject".
    assert.equal(sectionText(mode, {}), '')
    assert.equal(sectionText(mode, { agent: { session: { header: { id: 'nobody' } } } }), '')
    assert.deepEqual(host.routes.map(route => route.path), [
      '/api/plugins/dsh-app/plugin-doc/mode',
      '/api/plugins/dsh-app/plugin-doc/office-active',
    ])
    // GET/HEAD/POST only: the registry admits no PUT, so the toggle is a POST.
    assert.deepEqual(host.routes.map(route => [...route.methods]), [['GET', 'POST'], ['GET']])
    // The skill installer ran against the temp DSH_HOME.
    await settle()
    assert.ok(existsSync(join(home, 'skills', 'dsh-word', 'SKILL.md')), 'dsh-word skill installed')
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('e2e: Word mode round-trips through the route and drives the prompt section', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docd-e2e-mode-'))
  const home = mkdtempSync(join(tmpdir(), 'docd-e2e-mode-home-'))
  const savedHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = home
    const host = await mountHost()
    const route = host.routes[0]
    assert.ok(route !== undefined)
    const modeSection = host.sections.find(section => section.name === 'tool:doc-mode')
    const readPrompt = (sessionId: string): string =>
      sectionText(modeSection, { agent: { session: { header: { id: sessionId } } } })
    const session = 'session-1'
    const modeFile = join(home, 'storages', 'dsh-app-plugin-doc', 'mode.json')

    assert.equal(readPrompt(session), '', 'mode starts off')

    const post = (body: unknown): Promise<Response> => route.fetch(new Request(`http://dsh-app.local${route.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }))
    const toggle = await post({ sessionId: session, enabled: true })
    assert.equal(toggle.status, 200)
    assert.equal((await toggle.json() as { value: { enabled: boolean } }).value.enabled, true)
    assert.match(readPrompt(session), /doc_write/u, 'enabled session gets the workflow directive')
    await settle()
    const stored = await readModeFile(modeFile, (value) => (value[session] as { enabled?: boolean } | undefined)?.enabled === true)
    assert.equal(
      (stored[session] as { enabled: boolean }).enabled,
      true,
      'the toggle persisted to the DSH_HOME store',
    )

    const read = await route.fetch(new Request(`http://dsh-app.local${route.path}?sessionId=${session}`))
    assert.equal(read.status, 200)
    assert.equal((await read.json() as { value: { enabled: boolean } }).value.enabled, true)

    // A bad payload is refused and leaves the state alone.
    const bad = await post({ sessionId: session, enabled: 'yes' })
    assert.equal(bad.status, 400)
    assert.match(readPrompt(session), /doc_write/u)

    const off = await post({ sessionId: session, enabled: false })
    assert.equal(off.status, 200)
    assert.equal(readPrompt(session), '', 'turning the mode off stops the directive')
    const cleared = await readModeFile(modeFile, (value) => value[session] === undefined)
    assert.equal(
      cleared[session],
      undefined,
      'the cleared toggle left the store',
    )
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('e2e: doc_write refuses a broken project, then check and render deliver a real .docx', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docd-e2e-chain-'))
  const home = mkdtempSync(join(tmpdir(), 'docd-e2e-chain-home-'))
  const savedHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = home
    mkdirSync(join(root, 'assets'), { recursive: true })
    writeFileSync(join(root, 'assets', 'pixel.png'), ONE_PIXEL_PNG)

    const host = await mountHost()
    const exec: FakeExec = { agent: { session: { header: { id: 'session-1', cwd: root } } } }
    const docWrite = host.tools.get('doc_write')
    const docCheck = host.tools.get('doc_check')
    const docRender = host.tools.get('doc_render')
    assert.ok(docWrite !== undefined && docCheck !== undefined && docRender !== undefined)

    const relative = 'docs/report.doc.json'

    // 1. A malformed table is refused before the filesystem is touched.
    const rejected = await docWrite.execute({
      file_path: relative,
      content: JSON.stringify({
        title: '坏文档',
        sections: [{ table: { headers: ['A', 'B'], rows: [['只有一个']] } }],
      }),
    }, exec)
    assert.equal(rejected.status, 'needs_revision')
    assert.ok((rejected.errorCount as number) > 0)
    assert.match(rejected.issuesText as string, /table-row-shape/u)
    assert.equal(existsSync(join(root, 'docs', 'report.doc.json')), false, 'nothing written on error')

    // 2. The real project is written and its revision is returned.
    const project = {
      title: '二〇二六年第一季度评审',
      author: '增长组',
      sections: [
        { heading: { level: 1, text: '核心结论' } },
        { paragraph: { text: '本季度核心指标全面达标。', bold: true } },
        { bullets: ['营收同比增长 22%', '毛利率提升 3.3 个百分点'] },
        { heading: { level: 2, text: '关键指标' } },
        { table: { headers: ['指标', '本期'], rows: [['营收', '1,280 万'], ['毛利率', '34.5%']] } },
        { image: { path: 'assets/pixel.png' } },
      ],
    }
    const content = JSON.stringify(project, null, 2)
    const written = await docWrite.execute({ file_path: relative, content }, exec)
    assert.equal(written.status, 'written')
    assert.equal(written.operation, 'create')
    const sha = written.sha256 as string
    assert.match(sha, /^[0-9a-f]{64}$/u)
    assert.equal(readFileSync(join(root, 'docs', 'report.doc.json'), 'utf8'), content)

    // 3. Overwriting without the revision is refused; with it, it replaces.
    const noRevision = await docWrite.execute({ file_path: relative, content }, exec)
    assert.equal(noRevision.status, 'needs_revision')
    assert.match(noRevision.issuesText as string, /expected_sha256/u)
    const replaced = await docWrite.execute({ file_path: relative, content, expected_sha256: sha }, exec)
    assert.equal(replaced.status, 'written')
    assert.equal(replaced.operation, 'replace')

    // 4. The read-only check agrees the project is clean.
    const checked = await docCheck.execute({ file_path: relative }, exec)
    assert.equal(checked.status, 'ok')
    assert.equal(checked.errorCount, 0)
    assert.equal(checked.blockCount, 6)
    assert.match(checked.issuesText as string, /校验通过/u)

    // 5. Rendering exports a real .docx that holds the document text.
    const rendered = await docRender.execute({ file_path: relative, output_file: 'docs/report.docx' }, exec)
    assert.equal(rendered.status, 'exported', `render must export: ${String(rendered.issuesText)}`)
    assert.equal(rendered.blockCount, 6)
    const docxPath = join(root, 'docs', 'report.docx')
    assert.ok(existsSync(docxPath), 'output .docx exists')
    const bytes = readFileSync(docxPath)
    assert.ok(isZip(bytes), 'output is a zip container')
    assert.equal(bytes.byteLength, rendered.sizeBytes)
    const entries = readZipEntries(bytes)
    const document = entries.get('word/document.xml')
    assert.ok(document !== undefined && document.length > 0, 'word/document.xml present')
    assert.ok(document.includes('二〇二六年第一季度评审'), 'title text present in the body')
    assert.ok(document.includes('营收同比增长 22%'), 'list text present in the body')
    assert.ok(document.includes('1,280 万'), 'table cell text present in the body')
    // docx names embedded media parts by content hash; the picture must be in
    // the package, not inlined as base64 or dropped.
    const media = [...entries.keys()].filter(name => /^word\/media\/.+\.png$/u.test(name))
    assert.equal(media.length, 1, `one embedded png part (got ${media.join(', ')})`)

    // 6. The render gate refuses a broken project and writes no output.
    writeFileSync(join(root, 'broken.doc.json'), JSON.stringify({
      title: '坏文档',
      sections: [{ heading: { level: 1, text: 'A' }, paragraph: { text: 'B' } }],
    }), 'utf8')
    const gated = await docRender.execute({ file_path: 'broken.doc.json', output_file: 'broken.docx' }, exec)
    assert.equal(gated.status, 'needs_revision')
    assert.match(gated.issuesText as string, /multiple-content/u)
    assert.equal(existsSync(join(root, 'broken.docx')), false, 'no output on a failed gate')

    // 7. Missing inputs and unsafe paths come back as actionable failures.
    const missing = await docCheck.execute({ file_path: 'nope.doc.json' }, exec)
    assert.equal(missing.status, 'needs_revision')
    assert.match(String((missing.issues as { message: string }[])[0]?.message), /不存在/u)
    const escaping = await docWrite.execute({ file_path: '../escape.doc.json', content }, exec)
    assert.equal(escaping.status, 'needs_revision')
    assert.match(String((escaping.issues as { message: string }[])[0]?.message), /越出工作区/u)

    // 8. The wrong extension is refused with the expected one named.
    const wrongExtension = await docCheck.execute({ file_path: 'report.docx' }, exec)
    assert.equal(wrongExtension.status, 'needs_revision')
    assert.match(String((wrongExtension.issues as { message: string }[])[0]?.message), /doc\.json/u)
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})
