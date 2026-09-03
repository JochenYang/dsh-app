#!/usr/bin/env node
/**
 * Probe for the fff plugin's three LLM tools (fffind / ffgrep / fff-glob).
 *
 * This probe exercises the REAL tool implementations (plugins/plugin-fff/src)
 * — not a mock — by bundling them on the fly with esbuild (framework + fff
 * externals stay external, so the native binding loads from node_modules),
 * then running each tool's `execute`/`render` against a minimal context stub
 * and a real small workspace index (plugins/plugin-fff).
 *
 * Success path semantics + failure branches are asserted; exits non-zero on
 * any failure. Run from the dsh-app root after `npm install` (needs esbuild +
 * the @ff-labs/fff-node binary in node_modules):
 *   node scripts/probe-fff.mjs
 */
import { build } from 'esbuild'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const WALK_BASE = join(root, 'plugins', 'plugin-fff') // small, fast-to-index workspace

// --- tiny test harness --------------------------------------------------------

let passed = 0
let failed = 0
function check(label, cond) {
  if (cond) { passed++; console.log(`  ok   ${label}`) }
  else { failed++; console.log(`  FAIL ${label}`) }
}

// Minimal dsh host context: only what registerFffTools touches.
function makeCtx() {
  const registered = new Map()
  return {
    registered,
    tools: {
      register(def) {
        const name = String(def.name)
        registered.set(name, def)
        return () => { registered.delete(name) }
      },
    },
  }
}

// Minimal ToolRunContext: only exec.agent.session.header.cwd is consumed.
function makeExec(cwd) {
  return { agent: { session: { header: { cwd } } } }
}

// --- build the real sources into a temp bundle ---------------------------------

const entrySource = `
import { PickerManager } from './src/picker.ts'
import { registerFffTools } from './src/tools.ts'
export { PickerManager, registerFffTools }
`

// The real dsh-tools module drags in peer packages (dsh-scope, ...) that only
// exist in a full dsh runtime — out of scope for this probe. `defineTool` is a
// pass-through wrapper over the tool definition, so the probe stubs it and
// keeps the OTHER @deepseek-ai imports external; every other import runs the
// real implementation (tools.ts / picker.ts / @ff-labs/fff-node).
const dshToolsStub = join(root, 'scratch', 'fff-dsh-tools-stub.mjs')
await fs.writeFile(
  dshToolsStub,
  "// Probe stub: mirrors defineTool's pass-through contract (see scripts/probe-fff.mjs).\n"
  + 'export function defineTool(options) { return options }\n',
  'utf8',
)

const externalFramework = {
  name: 'external-framework',
  setup(b) {
    b.onResolve({ filter: /^@deepseek-ai\/dsh-tools$/ }, (a) => ({ path: dshToolsStub }))
    b.onResolve({ filter: /^@deepseek-ai\// }, (a) => ({ path: a.path, external: true }))
    b.onResolve({ filter: /^@cordisjs\// }, (a) => ({ path: a.path, external: true }))
    b.onResolve({ filter: /^@ff-labs\// }, (a) => ({ path: a.path, external: true }))
  },
}

// Written under scratch/ (not tmpdir): the bundle's external imports resolve
// via the normal parent-walk, which reaches dsh-app/node_modules from there.
const bundleFile = join(root, 'scratch', 'fff-probe-bundle.mjs')
try {
  await build({
    stdin: { contents: entrySource, resolveDir: WALK_BASE, sourcefile: 'fff-probe-entry.mjs' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    plugins: [externalFramework],
    outfile: bundleFile,
    logLevel: 'silent',
  })
  const { PickerManager, registerFffTools } = await import(pathToFileURL(bundleFile).href)

  // --- run ----------------------------------------------------------------------

  const log = { info() {}, warn(msg) { console.log(`  warn ${msg}`) } }
  const picker = new PickerManager({
    storeDir: join(root, 'scratch', 'fff-probe-store'),
    enableFrecency: false, // probe stays deterministic / location-independent
    maxInstances: 2,
    log,
  })

  const ctx = makeCtx()
  const disposed = registerFffTools(ctx, picker, 30_000)

  console.log('registered tools:', [...ctx.registered.keys()].join(', '))
  const find = ctx.registered.get('fffind')
  const grep = ctx.registered.get('ffgrep')
  const glob = ctx.registered.get('fff-glob')
  check('all three tools registered', !!find && !!grep && !!glob)

  const exec = makeExec(WALK_BASE)

  // fffind — happy path: fuzzy search for picker sources in the plugin dir.
  const findHit = await find.execute({ query: 'picker' }, exec)
  check('fffind: ok result', findHit.ok === true)
  const findItems = findHit.items ?? []
  check('fffind: matched src/picker.ts', findItems.some((it) => it.relativePath === 'src/picker.ts'))
  const findText = find.output.render({ query: 'picker' }, findHit)[0].text
  check('fffind: render is text', typeof findText === 'string' && findText.includes('src/picker.ts'))
  const findBad = await find.execute({ query: '' }, exec)
  check('fffind: empty query -> stable error', findBad.ok === false && /查询词不能为空/.test(findBad.reason))
  const findFence = await find.execute({ query: 'node_modules' }, makeExec(join(root, 'does-not-exist-fff')))
  check('fffind: missing cwd -> stable error', findFence.ok === false && /工作区目录|不存在/.test(findFence.reason))
  const findNoCwd = await find.execute({ query: 'x' }, makeExec(''))
  check('fffind: no cwd -> actionable error', findNoCwd.ok === false && /没有可搜索的工作区/.test(findNoCwd.reason))

  // ffgrep — happy path: literal content search (plain mode, no regex).
  const grepHit = await grep.execute({ query: 'PickerManager', mode: 'plain' }, exec)
  check('ffgrep: ok result', grepHit.ok === true)
  const grepItems = grepHit.items ?? []
  check('ffgrep: matched src/picker.ts', grepItems.some((it) => it.relativePath === 'src/picker.ts'))
  const grepText = grep.output.render({ query: 'PickerManager', mode: 'plain' }, grepHit)[0].text
  check('ffgrep: render includes path:line', typeof grepText === 'string' && /src\/picker\.ts:\d+/.test(grepText))
  const grepBad = await grep.execute({ query: '' }, exec)
  check('ffgrep: empty query -> stable error', grepBad.ok === false && /查询词不能为空/.test(grepBad.reason))
  const grepMode = await grep.execute({ query: 'PickerManager', mode: 'bogus-mode' }, exec)
  check('ffgrep: invalid mode falls back to plain (does not throw)', grepMode.ok === true)
  const grepNoMatch = await grep.execute({ query: 'zzz_no_such_symbol_fff' }, exec)
  check('ffgrep: no match -> ok with empty items', grepNoMatch.ok === true && (grepNoMatch.items ?? []).length === 0)

  // fff-glob — happy path: exact positional pattern match.
  const globHit = await glob.execute({ pattern: 'src/**/*.ts' }, exec)
  check('fff-glob: ok result', globHit.ok === true)
  const globItems = globHit.items ?? []
  check('fff-glob: matched src/index.ts and src/tools.ts', globItems.some((it) => it.relativePath === 'src/index.ts') && globItems.some((it) => it.relativePath === 'src/tools.ts'))
  const globText = glob.output.render({ pattern: 'src/**/*.ts' }, globHit)[0].text
  check('fff-glob: render lists entries', typeof globText === 'string' && globText.includes('src/picker.ts'))
  const globBad = await glob.execute({ pattern: '' }, exec)
  check('fff-glob: empty pattern -> stable error', globBad.ok === false && /pattern 不能为空/.test(globBad.reason))
  const globNoMatch = await glob.execute({ pattern: '**/*.nothing-fff' }, exec)
  check('fff-glob: no match -> ok with empty items', globNoMatch.ok === true && (globNoMatch.items ?? []).length === 0)

  // disposer removes everything again
  disposed()
  check('disposer unregisters all tools', ctx.registered.size === 0)
  picker.destroyAll()

  // also verify the picker reuses one instance for the same workspace key
  const p2 = new PickerManager({ storeDir: join(root, 'scratch', 'fff-probe-store'), enableFrecency: false, maxInstances: 1, log })
  const held1 = await p2.acquire(WALK_BASE, 30_000)
  const held2 = await p2.acquire(WALK_BASE, 30_000)
  check('same-key acquire reuses one instance', held1.ok && held2.ok && held1.held.key === held2.held.key)
  if (held1.ok) held1.held.done()
  if (held2.ok) held2.held.done()
  p2.destroyAll()
} finally {
  await fs.rm(bundleFile, { force: true }).catch(() => {})
  await fs.rm(dshToolsStub, { force: true }).catch(() => {})
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0 || passed === 0) process.exit(1)