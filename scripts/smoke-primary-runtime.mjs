#!/usr/bin/env node
/**
 * Verifies a staged primary runtime with the desktop host's OWN code.
 *
 * Usage:
 *   node scripts/smoke-primary-runtime.mjs [stagedDir]
 *
 * Default staged directory: `runtime-dist/primary-runtime-<platform>-<arch>` —
 * what `scripts/build-primary-runtime.mjs <platform> <arch>` writes.
 *
 * Why it re-runs itself under the harness's tsx: the only authority on what this
 * tree must contain is the host's primary-runtime module — a TypeScript source
 * file in the harness checkout (see {@link primaryRuntimeModules} for where the
 * two kernel lines keep it) — and importing it needs a TypeScript loader. This
 * script therefore starts a child process
 * (`node --import tsx/esm`, cwd = the checkout, which has tsx from its own pnpm
 * install) rather than restating the layout — a copy would agree with itself
 * while disagreeing with the host, which is exactly the failure this checks for.
 *
 * The child:
 *   1. reads `runtime.json` with `readPrimaryRuntime` (every validation rule);
 *   2. asks `workspaceDependencyPaths` for the paths and requires each of them
 *      to exist in the staged tree;
 *   3. calls `installPrimaryRuntime(staged, <scratch root>)` — the call the tool
 *      makes on its first invocation — and requires the installed tree to answer
 *      the same paths, plus a second call to exercise its reuse branch;
 *   4. runs the installed Python on every library the tool promises, the
 *      installed Node, and pnpm through that Node, checking the reported versions
 *      against the manifest (the `components` block of older files is normalized
 *      on read, so the assertions use the top-level fields).
 *
 * The checkout is found through DSH_APP_HARNESS_CHECKOUT, else the same two
 * sibling paths `scripts/build-runtime.mjs` looks in.
 *
 * @module dsh-app/scripts/smoke-primary-runtime
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Where the child installs the tree; inside the ignored runtime-dist tree. */
const SMOKE_ROOT = path.join(root, 'runtime-dist', '.primary-runtime-smoke')

/** Settle marker for the re-exec, so both modes share one file. */
const CHILD_MARKER = 'DSH_APP_PRIMARY_RUNTIME_SMOKE_CHILD'

/** Libraries the tool's description promises, imported by the installed Python. */
const PYTHON_IMPORTS = 'import decimal, lxml, numpy, pandas, docx, pptx, openpyxl, PIL, xlsxwriter; print(\'py ok\')'

/**
 * The host modules this smoke imports, for the checkout it was handed.
 *
 * The 0.1.7 line moved the payload logic and the `load_workspace_dependencies`
 * tool out of `apps/desktop-host` into `@deepseek-ai/dsh-tool-workspace-dependencies`
 * (harness commit `6e49ccad18`), so the helpers and `apply` are now ONE module
 * where 0.1.6 and older had two. Both layouts are answered here because the
 * checkout is whatever `DSH_APP_HARNESS_CHECKOUT` names — this script has no
 * kernel line of its own to assume.
 *
 * @param harness - resolved harness checkout.
 * @returns the module holding the payload helpers, and the one holding `apply`.
 */
function primaryRuntimeModules(harness) {
  const moved = path.join(harness, 'packages', 'skill', 'tool-workspace-dependencies', 'src', 'index.ts')
  if (existsSync(moved)) return { runtime: moved, tool: moved }
  return {
    runtime: path.join(harness, 'apps', 'desktop-host', 'src', 'primary-runtime.ts'),
    tool: path.join(harness, 'apps', 'desktop-host', 'src', 'workspace-dependencies.ts'),
  }
}

/** First candidate directory that holds the host's primary-runtime module. */
function harnessCheckout() {
  const candidates = [
    (process.env.DSH_APP_HARNESS_CHECKOUT ?? '').trim(),
    path.resolve(root, '..', 'deepseek-harness'),
    path.resolve(root, '..', '..', 'deepseek-harness'),
  ].filter((candidate) => candidate !== '')
  for (const candidate of candidates) {
    // Resolved to an absolute path: the env value may be relative to the
    // CALLER's cwd, and the child re-exec runs with the harness as its own
    // cwd — a relative value it inherits would resolve against the wrong tree
    // (measured on the release workflow's macOS cell: "no harness checkout
    // found" while the clone sat right there).
    const resolved = path.resolve(candidate)
    const { runtime, tool } = primaryRuntimeModules(resolved)
    if (existsSync(runtime) && existsSync(tool)) return resolved
  }
  throw new Error(`no harness checkout with the host's primary-runtime module found (looked in ${candidates.join(', ')}); `
    + 'set DSH_APP_HARNESS_CHECKOUT to one')
}

/** One check, logged with its observed value so a failure names what it saw. */
function report(label, value) {
  console.log(`[smoke-primary-runtime] ${label}: ${value}`)
}

/** Run a command and return its trimmed stdout, failing with the command named. */
function capture(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
}

/**
 * Ask the host's module for this tree's layout, install it, and exercise the
 * installed interpreters.
 * @param staged - absolute path of the staged primary runtime.
 * @param installRoot - absolute path the host would install it to.
 */
async function verify(staged, installRoot) {
  const modules = primaryRuntimeModules(harnessCheckout())
  const { installPrimaryRuntime, readPrimaryRuntime, workspaceDependencyPaths } = await import(
    pathToFileURL(modules.runtime).href
  )
  const manifest = await readPrimaryRuntime(staged)
  report('manifest', `desktopVersion ${manifest.desktopVersion}, ${manifest.platform}-${manifest.arch}, payloadDigest ${manifest.payloadDigest ?? 'absent'}`)
  report('python distributions', `${String(Object.keys(manifest.pythonPackages ?? {}).length)} locked, python ${manifest.python}, node ${manifest.node}, pnpm ${manifest.pnpm}`)

  const stagedPaths = workspaceDependencyPaths(staged, manifest)
  report('workspaceDependencyPaths(staged)', JSON.stringify(stagedPaths, undefined, 2).replace(/\n\s*/gu, ' '))
  for (const [name, target] of Object.entries(stagedPaths)) {
    if (name === 'pythonDistributions') continue
    if (!existsSync(target)) throw new Error(`the staged tree does not hold ${name}: ${target}`)
  }

  await mkdir(path.dirname(installRoot), { recursive: true })
  const installed = await installPrimaryRuntime(staged, installRoot)
  for (const [name, target] of Object.entries(installed)) {
    if (name === 'pythonDistributions') continue
    if (!existsSync(target)) throw new Error(`installPrimaryRuntime did not produce ${name}: ${target}`)
  }
  const again = await installPrimaryRuntime(staged, installRoot)
  if (JSON.stringify(again) !== JSON.stringify(installed)) throw new Error('the second install returned different paths')
  report('installPrimaryRuntime', `installed to ${installRoot}, all five paths present, a second call reuses it unchanged`)
  report('pythonDistributions', JSON.stringify(installed.pythonDistributions))

  const pythonOutput = capture(installed.python, ['-I', '-c', PYTHON_IMPORTS])
  if (pythonOutput !== 'py ok') throw new Error(`the installed Python answered ${JSON.stringify(pythonOutput)}, expected "py ok"`)
  report(`python -I -c "<imports>"`, pythonOutput)

  const nodeVersion = capture(installed.node, ['--version'])
  if (nodeVersion !== `v${manifest.node}`) throw new Error(`the installed Node answered ${nodeVersion}, manifest says ${manifest.node}`)
  report('node --version', nodeVersion)

  const pnpmVersion = capture(installed.node, [installed.pnpm, '--version'])
  if (pnpmVersion !== manifest.pnpm) throw new Error(`pnpm answered ${pnpmVersion}, manifest says ${manifest.pnpm}`)
  report('node <pnpm.mjs> --version', pnpmVersion)

  // The tool itself, through its own module: `apply` registers
  // `load_workspace_dependencies`, and `execute` is what the agent's call runs.
  // A minimal context is enough because the plugin only registers one tool and
  // settles one effect — no loader, no other service participates.
  const toolRoot = path.join(path.dirname(installRoot), 'tool-root')
  const { apply } = await import(pathToFileURL(modules.tool).href)
  let registered
  apply({ tools: { register: (tool) => { registered = tool; return () => undefined } }, effect: () => undefined }, { source: staged, root: toolRoot })
  if (registered?.name !== 'load_workspace_dependencies') throw new Error(`the plugin registered ${String(registered?.name)}, not load_workspace_dependencies`)
  const answer = await registered.execute({})
  const value = typeof answer === 'string' ? JSON.parse(answer) : answer
  const expected = workspaceDependencyPaths(toolRoot, manifest)
  for (const key of ['python', 'node', 'pnpm', 'pythonPackages', 'nodePackages']) {
    if (value[key] !== expected[key]) throw new Error(`load_workspace_dependencies answered ${key}=${String(value[key])}, expected ${expected[key]}`)
  }
  report('load_workspace_dependencies', `answered ${value.python} (${String(Object.keys(value.pythonDistributions).length)} distributions)`)
}

if (process.env[CHILD_MARKER] === '1') {
  const [staged, installRoot] = process.argv.slice(2)
  await verify(path.resolve(staged), path.resolve(installRoot))
  report('result', 'ok')
} else {
  try {
    const staged = path.resolve(process.argv[2] ?? path.join(root, 'runtime-dist', `primary-runtime-${process.platform}-${process.arch}`))
    if (!existsSync(path.join(staged, 'runtime.json'))) {
      throw new Error(`${staged} holds no runtime.json — build it first with scripts/build-primary-runtime.mjs ${process.platform} ${process.arch}`)
    }
    const harness = harnessCheckout()
    if (!existsSync(path.join(harness, 'node_modules', 'tsx'))) {
      throw new Error(`${harness} has no tsx installed; run pnpm install there (the host's own module needs a TypeScript loader)`)
    }
    report('harness', harness)
    report('staged', staged)
    execFileSync(process.execPath, ['--import', 'tsx/esm', fileURLToPath(import.meta.url), staged, path.join(SMOKE_ROOT, 'dsh-primary-runtime')], {
      cwd: harness,
      stdio: 'inherit',
      // The child runs with the harness as its cwd, so it gets the RESOLVED
      // absolute path rather than whatever the caller's environment held.
      env: { ...process.env, [CHILD_MARKER]: '1', DSH_APP_HARNESS_CHECKOUT: harness },
    })
  } catch (error) {
    console.error(`[smoke-primary-runtime] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
