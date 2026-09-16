#!/usr/bin/env node
// 内核升级前的插件兼容 dry-run：用给定内核以临时 DSH_HOME 短启动一次 web
// profile，扫描启动输出里的失败信号，提前暴露“插件用旧 API 在新内核上启动
// 即崩”一类的兼容断裂。
//
// 设计约束：
// - 零依赖（仅 Node 内置模块），Windows / macOS / Linux 均可运行
// - 默认使用临时 DSH_HOME（mkdtemp），绝不写用户真实 ~/.dsh；--home 仅用于
//   发布 runtime 前对真实 profile 的检查，指向的目录不会被删除
// - Windows 下内核会留下子进程（插件 worker），收尾必须 taskkill /T /F 整树杀
// - 就绪 / 良性 / 失败信号规则集中在 SCAN_RULES 一个数组里，便于维护
//
// 用法：
//   node scripts/check-plugin-compat.mjs --kernel <内核目录|runtime.tgz>
//       [--home <目录>] [--timeout <秒>] [--port <端口>]
//   --kernel  已解内核目录（含 app/node_modules/.../lib/bin.js），或 runtime
//             tgz（自动解到临时目录，收尾删除）
//   --home    指定 DSH_HOME；缺省用临时目录。指向真实 profile 时会加载真实
//             插件配置，仅建议在发布前检查时使用
//   --timeout 等待就绪信号的超时秒数，默认 20
//   --port    web 监听端口，默认 30000-45000 随机
// 退出码：0 通过（就绪且无失败信号）；1 失败；2 参数错误
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 内核入口相对内核根目录的固定位置，与 runtime 产物布局一致
const KERNEL_BIN = path.join('app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
// 就绪信号：内核 web 服务打印的监听地址行（与 src/main/server.ts 的探测一致）
const READY_PATTERN = /dsh web: http:\/\/127\.0\.0\.1:/
// 出现就绪信号后再观察这段时间，让插件加载期的错误来得及暴露
const READY_GRACE_MS = 2000
// 报告里附带的启动输出尾部行数
const TAIL_LINES = 15

// kind: ready=就绪信号 / benign=已知良性（豁免） / fail=失败信号
// 判定顺序即数组顺序：先就绪、再良性、最后失败信号；新增豁免或信号只改这里。
// 失败信号刻意收窄为可执行错误的具体形态（异常堆栈、Node 错误码、模块解析
// 失败、加载器对 patch 行的拒绝文案），泛词（error/fail/invalid）会把健康
// 内核的正常输出误报成失败。
const SCAN_RULES = [
  { kind: 'ready', pattern: READY_PATTERN },
  { kind: 'benign', pattern: /ExperimentalWarning|trace-warnings/i },
  { kind: 'benign', pattern: /deprecat/i },
  { kind: 'fail', pattern: /ERR_[A-Z_]+|Cannot find module|Cannot resolve|duplicate (?:plugin|entry|definition)|failed to (?:load|register|start)|^\s+at .+:\d+:\d+/ },
]

function usage() {
  console.error(`用法: node scripts/check-plugin-compat.mjs --kernel <内核目录|runtime.tgz> [--home <目录>] [--profile <名字>] [--timeout <秒>] [--port <端口>]`)
}

function parseArgs(argv) {
  const args = {
    timeout: 20,
    port: 30000 + Math.floor(Math.random() * 15001),
    // 默认就是外壳自己的 profile（src/shared/constants.ts SUITE_PROFILE）。
    // 0.1.6 之前的外壳把插件铺在共享的 profiles/node_modules，用那个布局的
    // home 复检时传 --profile web。
    profile: 'dsh-app',
  }
  for (let i = 0; i < argv.length; i++) {
    const eq = argv[i].indexOf('=')
    const key = eq === -1 ? argv[i] : argv[i].slice(0, eq)
    const value = eq === -1 ? argv[++i] : argv[i].slice(eq + 1)
    if (value === undefined || value === '') failUsage(`参数 ${key} 缺少值`)
    switch (key) {
      case '--kernel': args.kernel = value; break
      case '--home': args.home = value; break
      case '--profile': args.profile = value; break
      case '--timeout': args.timeout = Number(value); break
      case '--port': args.port = Number(value); break
      default: failUsage(`未知参数: ${key}`)
    }
  }
  if (!args.kernel) failUsage('缺少 --kernel 参数')
  if (!Number.isFinite(args.timeout) || args.timeout <= 0) failUsage('--timeout 必须是正数')
  if (!Number.isFinite(args.port) || args.port <= 0 || args.port > 65535) failUsage('--port 必须是有效端口')
  return args
}

function failUsage(message) {
  console.error(`参数错误: ${message}`)
  usage()
  process.exit(2)
}

// 在 dir 下定位含 KERNEL_BIN 的内核根目录（tgz 解包后可能多一层 package/）
function findKernelRoot(dir) {
  if (fs.existsSync(path.join(dir, KERNEL_BIN))) return dir
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    throw new Error(`无法读取内核目录: ${dir}`)
  }
  for (const entry of entries) {
    if (entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, KERNEL_BIN))) {
      return path.join(dir, entry.name)
    }
  }
  throw new Error(`内核目录缺少入口 ${KERNEL_BIN}: ${dir}`)
}

// tar 可执行文件：Windows 优先用系统自带 bsdtar（Git Bash 的 GNU tar 会把
// "C:\..." 盘符路径误判为远程主机），不存在时退回 PATH 里的 tar 并加
// --force-local 规避同一问题
function resolveTar() {
  if (process.platform === 'win32') {
    const systemTar = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'tar.exe')
    if (fs.existsSync(systemTar)) return { cmd: systemTar, extraArgs: [] }
    return { cmd: 'tar', extraArgs: ['--force-local'] }
  }
  return { cmd: 'tar', extraArgs: [] }
}

// --kernel 为 tgz 时解到临时目录，否则原样使用；返回 { root, tempDir }
function resolveKernel(kernelArg, tempDirs) {
  const abs = path.resolve(kernelArg)
  const stat = fs.statSync(abs)
  if (stat.isDirectory()) {
    return { root: findKernelRoot(abs), tempDir: null }
  }
  if (!/\.(tgz|tar\.gz)$/i.test(abs)) {
    throw new Error(`--kernel 须为目录或 .tgz 文件: ${abs}`)
  }
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-kernel-'))
  tempDirs.push(extractDir)
  const tar = resolveTar()
  const r = spawnSync(tar.cmd, [...tar.extraArgs, '-xzf', abs, '-C', extractDir], { windowsHide: true })
  if (r.status !== 0) {
    throw new Error(`解压 runtime tgz 失败 (tar exit ${r.status}): ${String(r.stderr || '').slice(0, 300)}`)
  }
  return { root: findKernelRoot(extractDir), tempDir: extractDir }
}

// Windows 下整树杀（内核会留子进程）；POSIX 用 detached 进程组信号
function killTree(pid) {
  if (!pid) return false
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    return r.status === 0
  }
  try {
    process.kill(-pid, 'SIGKILL')
    return true
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
      return true
    } catch {
      return false
    }
  }
}

// 短启动内核：收集 stdout+stderr 全部行，竞速 就绪/超时/退出 三种结局。
// 返回 { result, exited }；流缓冲的半行由调用方在收尾时 flush。
function runKernel(binJs, homeDir, profile, port, timeoutMs, lines, flushers) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [binJs, '--profile', profile, '--host', '127.0.0.1', '--port', String(port), '--no-open'],
      {
        env: { ...process.env, DSH_HOME: homeDir },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      },
    )

    let settled = false
    let readySeen = false
    let readyTimer = null
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (readyTimer) clearTimeout(readyTimer)
      resolve({ child, result })
    }
    const timeoutTimer = setTimeout(() => finish({ type: 'timeout' }), timeoutMs)

    const onLine = (line) => {
      lines.push(line)
      if (!readySeen && READY_PATTERN.test(line)) {
        readySeen = true
        readyTimer = setTimeout(() => finish({ type: 'ready' }), READY_GRACE_MS)
      }
    }
    const attach = (stream) => {
      stream.setEncoding('utf8')
      let buf = ''
      stream.on('data', (chunk) => {
        buf += chunk
        let nl
        while ((nl = buf.indexOf('\n')) !== -1) {
          onLine(buf.slice(0, nl).replace(/\r$/, ''))
          buf = buf.slice(nl + 1)
        }
      })
      flushers.push(() => {
        if (buf) {
          onLine(buf.replace(/\r$/, ''))
          buf = ''
        }
      })
    }
    attach(child.stdout)
    attach(child.stderr)

    child.on('error', (err) => finish({ type: 'spawn-error', message: err?.message ?? String(err) }))
    child.on('close', (code, signal) => {
      if (readySeen) finish({ type: 'ready-exited', code, signal })
      else finish({ type: 'exit', code, signal })
    })
  })
}

function classifyLine(line) {
  for (const rule of SCAN_RULES) {
    if (rule.pattern.test(line)) return rule
  }
  return null
}

function outcomeSummary(result, timeoutSec) {
  switch (result.type) {
    case 'ready': return `已出现（观察 ${READY_GRACE_MS / 1000} 秒后收尾）`
    case 'ready-exited': return `已出现（观察期内进程自行退出，code=${result.code}）`
    case 'exit': return `未出现（进程提前退出，code=${result.code}${result.signal ? ` signal=${result.signal}` : ''}）`
    case 'timeout': return `未出现（${timeoutSec} 秒超时）`
    case 'spawn-error': return `未出现（启动失败：${result.message}）`
    default: return `未出现（${result.type}）`
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const tempDirs = []
  const flushers = []
  const lines = []
  let child = null
  try {
    const kernel = resolveKernel(args.kernel, tempDirs)
    const binJs = path.join(kernel.root, KERNEL_BIN)
    const usingTempHome = !args.home
    const homeDir = args.home ? path.resolve(args.home) : fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-home-'))
    if (usingTempHome) tempDirs.push(homeDir)
    else fs.mkdirSync(homeDir, { recursive: true })

    const startedAt = Date.now()
    const { child: proc, result } = await runKernel(binJs, homeDir, args.profile, args.port, args.timeout * 1000, lines, flushers)
    child = proc
    // 收尾：无论结局先整树杀，再给流一点时间 flush 残留输出
    killTree(child.pid)
    await new Promise((r) => setTimeout(r, 300))
    for (const flush of flushers) flush()

    const hits = []
    for (const line of lines) {
      const rule = classifyLine(line)
      if (rule && rule.kind === 'fail') hits.push(line)
    }
    const readySeen = result.type === 'ready' || result.type === 'ready-exited'
    const exitOk = result.type === 'ready-exited' ? result.code === 0 : true
    const passed = readySeen && exitOk && hits.length === 0

    const tail = lines.slice(-TAIL_LINES)
    console.log('==== 内核插件兼容 dry-run ====')
    console.log(`内核根目录: ${kernel.root}`)
    console.log(`DSH_HOME:   ${homeDir}${usingTempHome ? '（临时目录）' : '（指定目录，未清理）'}`)
    console.log(`端口:       ${args.port}`)
    console.log(`就绪信号:   ${outcomeSummary(result, args.timeout)}，用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
    if (tail.length > 0) {
      console.log('---- 启动输出（尾部）----')
      for (const line of tail) console.log(`  ${line}`)
    }
    console.log('---- 结论 ----')
    if (passed) {
      console.log('结果: 通过 — 内核就绪，未命中失败信号')
    } else {
      console.log('结果: 失败')
      if (!readySeen) console.log('原因: 就绪信号未出现（内核未能在超时前提供 web 服务）')
      if (!exitOk) console.log(`原因: 就绪后进程异常退出 (code=${result.code})`)
      console.log(`失败信号命中 ${hits.length} 行:`)
      for (const line of hits.slice(0, 20)) console.log(`  ✗ ${line.slice(0, 300)}`)
    }
    process.exitCode = passed ? 0 : 1
  } catch (err) {
    console.error(`检查中断: ${err?.message ?? err}`)
    process.exitCode = 1
  } finally {
    if (child && child.pid && child.exitCode === null && child.signalCode === null) killTree(child.pid)
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch (err) {
        console.error(`警告: 临时目录清理失败 ${dir}: ${err?.message ?? err}`)
      }
    }
  }
}

main()
