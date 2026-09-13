#!/usr/bin/env node
// 把 GitHub Release 资产镜像到 ModelScope（model 仓库类型），布局：
//   releases/latest/<asset>             稳定版最新（稳定 tag 才写）
//   releases/archive/<version>/<asset>  稳定版归档
//   releases/prerelease/<tag>/<asset>   预发布（版本号含 “-” 即视为预发布）
//   releases/versions.json              索引：版本号 → {tag, channel, assets, uploadedAt}
//
// 选 model 而非 dataset：发布产物是通用二进制安装包，model 仓库的文件列表与
// 直链下载最完整，LFS 后缀白名单已覆盖 .gz/.zip/.7z 一类格式；dataset 面向
// 结构化数据、API 形态不同（repo/tree），无额外收益。
//
// 上传与官方客户端同款三步（阈值也与其默认一致：>1 MiB 走 LFS）：
//   1) POST /api/v1/repos/models/{id}/info/lfs/objects/batch → 预签名 PUT URL
//      只对超过阈值的对象发起；更小的对象以 base64 内联进 commit，对它们
//      batch 只会换来无意义的预签名与幽灵 blob
//   2) PUT blob（服务端按 sha256 去重，重跑只补缺，天然断点安全）
//   3) POST /api/v1/repos/models/{id}/commit/master（含 versions.json，原子提交）
//
// 不变式（改动前先读这三条）：
// - 预签名 PUT 绝不携带仓库凭据。uploadHeaders() 是白名单（Content-Type、
//   Content-Length、X-Request-ID，外加 batch 响应显式要求的上传头）；
//   putBlob() 连 token 参数都没有，从签名上就发不出凭据。把 Authorization /
//   Cookie 发往对象存储域，既让仓库 token 外泄给 ModelScope 之外的第三方，
//   也常因预签名把请求头纳入签名而破坏校验、直接 403。
//   rawRequest() 的跨 host 重定向剥离在此之上再做一层兜底。
// - versions.json 是读-改-写且非原子：404 视为“首次发布”（空索引），其他任何
//   读取失败都 exit 1 —— 从空重建会静默丢掉全部历史条目，资产可以补发、历史
//   不可补。不同 tag 必须串行发布；同一 tag 重跑幂等（blob 按 sha256 去重，
//   索引条目被同值覆盖）。
// - 绝不打印 token 与预签名 URL；远端错误体先经 redactSecrets() 再输出。
//
// 设计约束：
// - Node 20+，零依赖（仅内置模块）；CI Linux runner 与本地 Windows 均可运行
// - MODELSCOPE_TOKEN 未设置时在任何网络调用之前打印 skip 说明并 exit 0；
//   workflow 侧保持绿色，并把 skip 写进 step summary
// - 单文件下载/上传失败重试 1 次；任一文件最终失败则放弃提交，exit 1
// - 临时目录在任何路径下必删；设置了 GITHUB_STEP_SUMMARY 时写入
//   成功/跳过/失败原因与补发命令
// - ModelScope 目标仓库需预先存在（一次性手动创建），缺失时报可行动错误；
//   目标仓库 id 可用 MODELSCOPE_REPO 覆盖，默认按 GitHub owner/name 小写推导
//
// 用法：
//   node scripts/publish-modelscope.mjs --tag v0.11.6 --repo owner/name [--dry-run]
//       [--modelscope-repo namespace/name] [--assets-file <gh assets json 路径>]
//   --dry-run     只拉资产清单并打印上传计划，不下载、不上传、不需要 token
//   --assets-file 离线提供 gh release view --json assets 的输出，替代 gh 调用
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const ENDPOINT = (process.env.MODELSCOPE_ENDPOINT || 'https://www.modelscope.cn').replace(/\/+$/, '')
const REPO_TYPE_SEGMENT = 'models' // 固定 model 类型
const REVISION = 'master'
const VERSIONS_PATH = 'releases/versions.json'
// 超过该大小走 LFS blob，否则 base64 内联进 commit（与官方客户端默认一致）
const LFS_FORCE_THRESHOLD = 1024 * 1024
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000
const RETRY_ATTEMPTS = 2 // 首次 + 重试 1 次

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') {
      args.dryRun = true
      continue
    }
    if (arg === '--help') {
      usage()
      process.exit(0)
    }
    const eq = arg.indexOf('=')
    const key = eq === -1 ? arg : arg.slice(0, eq)
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1)
    if (value === undefined || value === '') fail(`参数 ${key} 缺少值`)
    switch (key) {
      case '--tag': args.tag = value; break
      case '--repo': args.repo = value; break
      case '--modelscope-repo': args.modelscopeRepo = value; break
      case '--assets-file': args.assetsFile = value; break
      default: fail(`未知参数: ${key}`)
    }
  }
  args.tag = args.tag || process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME || ''
  args.repo = args.repo || process.env.GITHUB_REPOSITORY || ''
  if (!args.tag || !/^v/i.test(args.tag)) fail('缺少 --tag（须以 v 开头）')
  if (!args.repo || !args.repo.includes('/')) fail('缺少 --repo（GitHub owner/name）')
  return args
}

function usage() {
  console.log('用法: node scripts/publish-modelscope.mjs --tag v0.11.6 --repo owner/name [--dry-run] [--modelscope-repo ns/name] [--assets-file <path>]')
}

function fail(message) {
  console.error(`[modelscope] ${message}`)
  writeSummary([
    '### ModelScope mirror: FAILED',
    '',
    `- Reason: ${message}`,
    `- Backfill (requires \`MODELSCOPE_TOKEN\`): \`${backfillCommand()}\``,
  ])
  process.exit(1)
}

function log(message) {
  console.log(`[modelscope] ${message}`)
}

function truncate(text, max = 300) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, max)
}

// 远端错误体可能回显预签名 URL 的查询签名或 Authorization 值（如 S3
// SignatureDoesNotMatch 会附 StringToSign），输出前统一脱敏。
function redactSecrets(text) {
  return String(text)
    .replace(/https?:\/\/[^\s"'<>]+/gi, (u) => {
      try {
        const parsed = new URL(u)
        return `${parsed.origin}${parsed.pathname}`
      } catch {
        return '<redacted-url>'
      }
    })
    .replace(/\b(Bearer\s+)[\w.~+/=-]+/gi, '$1<redacted>')
    .replace(/(m_session_id=)[^;&\s"']+/gi, '$1<redacted>')
    .replace(/(x-amz-(?:signature|credential|security-token)=)[^&\s"']+/gi, '$1<redacted>')
}

// 发版时人工核对用的 step summary（对应 AGENTS.md §10）。只在 CI 生效；
// 写失败绝不影响发布结果。
function writeSummary(lines) {
  const target = process.env.GITHUB_STEP_SUMMARY
  if (!target) return
  try {
    fs.appendFileSync(target, lines.join('\n') + '\n', 'utf8')
  } catch {
    // bookkeeping 不应掩盖真正的失败
  }
}

const summaryContext = { tag: '', repo: '' }

function backfillCommand() {
  return `node scripts/publish-modelscope.mjs --tag ${summaryContext.tag || '<tag>'} --repo ${summaryContext.repo || '<owner/name>'}`
}

function gh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) {
    throw new Error(`gh ${args.join(' ')} 失败 (exit ${r.status}): ${truncate(r.stderr || r.stdout || '', 300)}`)
  }
  return r.stdout
}

// 拉取 release 资产清单 → [{name, size}]
async function fetchAssets(args) {
  if (args.assetsFile) {
    const raw = fs.readFileSync(args.assetsFile, 'utf8')
    return parseAssetsJson(raw)
  }
  const out = gh(['release', 'view', args.tag, '--repo', args.repo, '--json', 'assets'])
  return parseAssetsJson(out)
}

function parseAssetsJson(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('资产清单不是合法 JSON（预期 gh release view --json assets 的输出）')
  }
  const assets = Array.isArray(parsed) ? parsed : parsed.assets
  if (!Array.isArray(assets)) throw new Error('资产清单缺少 assets 数组')
  return assets
    .map((a) => ({ name: String(a.name || ''), size: Number(a.size ?? 0) }))
    .filter((a) => a.name)
}

// 通用请求：返回 {status, body(Buffer), headers}；GET 遇 3xx 跟随，
// 跨 host 重定向时丢弃 Authorization/Cookie，避免把凭据带给第三方域
function rawRequest(method, urlStr, { headers = {}, body = null, bodyStream = null, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr)
    const mod = url.protocol === 'http:' ? http : https
    const req = mod.request(
      url,
      { method, headers, timeout: REQUEST_TIMEOUT_MS },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode || 0) && res.headers.location) {
          res.resume()
          if (redirects >= 3) return reject(new Error(`重定向次数过多: ${method} ${url.host}`))
          const next = new URL(res.headers.location, url)
          const crossHost = next.host !== url.host
          const nextHeaders = { ...headers }
          if (crossHost) {
            delete nextHeaders.Authorization
            delete nextHeaders.Cookie
          }
          return resolve(rawRequest('GET', String(next), { headers: nextHeaders, redirects: redirects + 1 }))
        }
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }))
      },
    )
    req.on('timeout', () => req.destroy(new Error(`请求超时: ${method} ${url.host}`)))
    req.on('error', (err) => reject(new Error(`${method} ${url.host}${url.pathname} 网络失败: ${truncate(err.message, 200)}`)))
    if (bodyStream) bodyStream.pipe(req)
    else req.end(body)
  })
}

function authHeaders(token, extra = {}) {
  return {
    // 双凭据与官方客户端一致：老端点看 cookie，新端点看 Bearer
    Authorization: `Bearer ${token}`,
    Cookie: `m_session_id=${token}`,
    'X-Request-ID': crypto.randomUUID(),
    ...extra,
  }
}

// ModelScope API 调用（/api/v1 前缀 + {Code,Message,Data} 信封）
async function api(method, apiPath, token, payload) {
  const headers = authHeaders(token, { 'Content-Type': 'application/json' })
  const body = payload === undefined ? undefined : JSON.stringify(payload)
  const resp = await rawRequest(method, `${ENDPOINT}/api/v1${apiPath}`, { headers, body })
  let parsed = null
  try {
    parsed = JSON.parse(resp.body.toString('utf8'))
  } catch {
    // 空响应体视为成功占位
  }
  const code = parsed ? parsed.Code ?? parsed.code : undefined
  const ok = resp.status >= 200 && resp.status < 300 && (code === undefined || code === 200 || code === '200')
  if (!ok) {
    const msg = parsed ? parsed.Message ?? parsed.message ?? '' : truncate(resp.body.toString('utf8'), 200)
    throw new Error(`API ${method} ${apiPath} 失败: HTTP ${resp.status}${code !== undefined ? ` Code ${code}` : ''} ${truncate(msg, 300)}`)
  }
  return { data: parsed ? parsed.Data ?? parsed.data : null, raw: parsed }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    fs.createReadStream(filePath)
      .on('data', (c) => hash.update(c))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

async function withRetry(fn, what) {
  let lastErr
  for (let i = 0; i < RETRY_ATTEMPTS; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (i < RETRY_ATTEMPTS - 1) log(`重试 1 次: ${what}（${truncate(err.message, 200)}）`)
    }
  }
  throw lastErr
}

// 下载单资产（精确匹配文件名），校验大小与清单一致
async function downloadAsset(args, asset, dir) {
  // 必须把 withRetry 的结果透传出去：漏掉 return 会让调用方拿到 undefined，
  // 随后 fs.statSync(undefined) 直接 TypeError，整条镜像通道永远发不出去。
  return await withRetry(async () => {
    gh(['release', 'download', args.tag, '--repo', args.repo, '--pattern', asset.name, '--dir', dir, '--clobber'])
    const local = path.join(dir, asset.name)
    if (!fs.existsSync(local)) throw new Error(`下载后未找到文件: ${asset.name}`)
    if (asset.size > 0) {
      const actual = fs.statSync(local).size
      if (actual !== asset.size) throw new Error(`大小不一致: ${asset.name} 清单 ${asset.size} vs 实际 ${actual}`)
    }
    return local
  }, `下载 ${asset.name}`)
}

// LFS batch：返回 oid → {href, headers}（无 href = blob 已存在，可复用）。
// 只对超过阈值的对象调用 —— 内联对象不经过 blob 存储，batch 它们只会产生
// 无意义的预签名与永远不被引用的幽灵 blob。
async function validateBlobs(token, repoId, objects) {
  const { data } = await withRetry(
    () => api('POST', `/repos/${REPO_TYPE_SEGMENT}/${repoId}/info/lfs/objects/batch`, token, {
      operation: 'upload',
      objects,
    }),
    'LFS batch 校验',
  )
  const result = {}
  // 响应必须逐对象回执；缺失视为协议异常而非“blob 已存在”，避免静默
  // 提交指向未上传 blob 的 LFS 指针
  if (!Array.isArray(data?.objects) || data.objects.length !== objects.length) {
    throw new Error(`LFS batch 响应异常: 预期 ${objects.length} 个对象回执，实际 ${data?.objects?.length ?? 0}`)
  }
  for (const obj of data.objects) {
    result[obj.oid] = {
      href: obj.actions?.upload?.href ?? null,
      // 服务端显式要求的上传头（LFS 协议的 actions.upload.header）
      headers: obj.actions?.upload?.header ?? {},
    }
  }
  return result
}

// 预签名 PUT 的请求头白名单：只带对象存储校验签名所需的 Content-Type /
// Content-Length、非凭据的关联头 X-Request-ID，以及 batch 响应点名要求的上传头。
// 显式剔除任何 credential 形状的头：发出去就是 token 外泄 + 签名校验失败。
const CREDENTIAL_HEADER_PATTERN = /^(authorization|cookie|proxy-authorization)$|token|session/i

function uploadHeaders(serverHeaders, size) {
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Length': size,
    'X-Request-ID': crypto.randomUUID(),
  }
  for (const [name, value] of Object.entries(serverHeaders || {})) {
    if (value == null || CREDENTIAL_HEADER_PATTERN.test(name)) continue
    headers[name] = value
  }
  return headers
}

// 预签名 PUT 上传 blob（流式，带 Content-Length）。
// 刻意不接收 token 参数：不带凭据是这一层的结构性不变式，而不是靠过滤。
async function putBlob(uploadUrl, filePath, size, serverHeaders) {
  const stream = fs.createReadStream(filePath)
  try {
    const resp = await rawRequest('PUT', uploadUrl, {
      headers: uploadHeaders(serverHeaders, size),
      bodyStream: stream,
    })
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`blob PUT 失败: HTTP ${resp.status} ${truncate(redactSecrets(resp.body.toString('utf8')), 200)}`)
    }
  } finally {
    stream.destroy()
  }
}

// 兼容 ModelScope 的 {Code,Message,Data} 信封与裸文档两种形态；Data 若被序列
// 化成 JSON 字符串（文件类端点会把文件内容塞进 Data）再解析一次。
function unwrapEnvelope(parsed) {
  const inner =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.Data !== undefined && parsed.Data !== null
      ? parsed.Data
      : parsed
  if (typeof inner === 'string') {
    try {
      return JSON.parse(inner)
    } catch {
      return inner
    }
  }
  return inner
}

// 读远端 versions.json：404 = 首次发布（空索引）；其他任何失败（HTTP 非 2xx、
// 传输异常、非 JSON 响应）都抛错让上层 exit 1。索引是读-改-写，从空重建会
// 静默丢掉全部历史，而资产可以补发、历史不可补。不同 tag 必须串行发布。
async function readRemoteVersions(token, repoId) {
  const url = `${ENDPOINT}/api/v1/${REPO_TYPE_SEGMENT}/${repoId}/repo?Revision=${REVISION}&FilePath=${encodeURIComponent(VERSIONS_PATH)}`
  let resp
  try {
    resp = await rawRequest('GET', url, { headers: authHeaders(token) })
  } catch (err) {
    throw new Error(`读取 ${VERSIONS_PATH} 失败: ${truncate(err.message, 200)}（不从空重建，避免丢历史；请重试）`)
  }
  if (resp.status === 404) return {}
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`读取 ${VERSIONS_PATH} 失败: HTTP ${resp.status}（不从空重建，避免丢历史；请重试或先修复该文件）`)
  }
  let parsed
  try {
    parsed = JSON.parse(resp.body.toString('utf8'))
  } catch {
    throw new Error(`读取 ${VERSIONS_PATH} 失败: 响应不是合法 JSON（不从空重建，避免丢历史）`)
  }
  // HTTP 200 但信封带非 200 的 Code：文件其实不可用，同样拒绝从空重建
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const code = parsed.Code ?? parsed.code
    if (code !== undefined && code !== 200 && code !== '200') {
      throw new Error(
        `读取 ${VERSIONS_PATH} 失败: Code ${code} ${truncate(String(parsed.Message ?? parsed.message ?? ''), 200)}（不从空重建，避免丢历史）`,
      )
    }
  }
  const index = unwrapEnvelope(parsed)
  if (!index || typeof index !== 'object' || Array.isArray(index)) {
    throw new Error(`读取 ${VERSIONS_PATH} 失败: 响应不是索引对象（不从空重建，避免丢历史）`)
  }
  return index
}

function buildCommitAction(remotePath, file) {
  const lfs = file.size > LFS_FORCE_THRESHOLD
  const action = {
    action: 'create',
    path: remotePath,
    type: lfs ? 'lfs' : 'normal',
    size: file.size,
  }
  if (lfs) {
    action.sha256 = file.sha256
    action.content = ''
    action.encoding = ''
  } else {
    action.sha256 = ''
    action.content = fs.readFileSync(file.localPath).toString('base64')
    action.encoding = 'base64'
  }
  return action
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  summaryContext.tag = args.tag
  summaryContext.repo = args.repo
  const token = process.env.MODELSCOPE_TOKEN || ''
  const version = args.tag.replace(/^v/i, '')
  const prerelease = version.includes('-')
  const channel = prerelease ? 'prerelease' : 'stable'

  // 无 token 且非 dry-run：优雅跳过（在触碰网络之前），CI 侧不阻塞主发布
  if (!args.dryRun && !token) {
    log('MODELSCOPE_TOKEN 未设置，跳过 ModelScope 镜像（如需启用请配置仓库 secret MODELSCOPE_TOKEN）')
    writeSummary([
      '### ModelScope mirror: SKIPPED',
      '',
      '- `MODELSCOPE_TOKEN` is not configured; mirroring is disabled by design and this run is a success.',
      '- Backfill once the secret exists:',
      `  \`${backfillCommand()}\``,
    ])
    return
  }

  const assets = await fetchAssets(args)
  if (assets.length === 0) fail(`release ${args.tag} 没有资产，无需镜像`)

  // 目标仓库：显式指定 > 环境变量 > 按 GitHub owner/name 小写推导
  const [ghOwner, ghName] = args.repo.split('/')
  const repoId = (args.modelscopeRepo || process.env.MODELSCOPE_REPO || `${ghOwner}/${ghName}`).replace(/^\/+|\/+$/g, '')

  // 布局计划：每个资产 → 远端路径列表
  const plan = assets.map((asset) => ({
    ...asset,
    remotePaths: prerelease
      ? [`releases/prerelease/${args.tag}/${asset.name}`]
      : [`releases/latest/${asset.name}`, `releases/archive/${version}/${asset.name}`],
  }))

  if (args.dryRun) {
    log(`dry-run: tag=${args.tag} repo=${args.repo} → ModelScope ${repoId}（${channel}）`)
    for (const item of plan) {
      log(`  ${item.name} (${item.size} bytes) → ${item.remotePaths.join(', ')}`)
    }
    log(`  ${VERSIONS_PATH} → versions["${version}"] = {tag: ${args.tag}, channel: ${channel}, assets: [${assets.map((a) => a.name).join(', ')}]}`)
    log('dry-run 完成，未做任何下载或上传')
    return
  }

  if (!repoId.includes('/')) fail(`ModelScope 仓库 id 不合法: ${repoId}（预期 namespace/name，可用 --modelscope-repo 或 MODELSCOPE_REPO 指定）`)

  // 远端索引必须在任何下载/上传之前读：按上面的失败语义，读取失败要立刻
  // exit 1，而不是先跑完昂贵的上传再发现历史保不住。
  const remote = await readRemoteVersions(token, repoId)
  const remoteVersions = remote.versions && typeof remote.versions === 'object' && !Array.isArray(remote.versions) ? remote.versions : {}
  const previousCount = Object.keys(remoteVersions).length

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-mirror-'))
  try {
    // 1) 下载全部资产（单文件失败重试 1 次）
    const files = []
    for (const item of plan) {
      try {
        const localPath = await downloadAsset(args, item, tempDir)
        const size = fs.statSync(localPath).size
        files.push({ ...item, localPath, size, sha256: await sha256File(localPath) })
        log(`已下载: ${item.name} (${size} bytes)`)
      } catch (err) {
        throw new Error(`下载 ${item.name} 失败（已重试 1 次）: ${truncate(err.message, 300)}`)
      }
    }

    // 2) 只有超过 LFS 阈值的对象才 batch 取预签名 URL；其余走 base64 内联，
    //    对它们 batch 只会产生不被引用的幽灵 blob。判定阈值必须与
    //    buildCommitAction() 里的 type 判定保持一致。
    const lfsFiles = files.filter((f) => f.size > LFS_FORCE_THRESHOLD)
    const inlineFiles = files.filter((f) => f.size <= LFS_FORCE_THRESHOLD)
    const hrefs = lfsFiles.length
      ? await validateBlobs(token, repoId, lfsFiles.map((f) => ({ oid: f.sha256, size: f.size })))
      : {}
    for (const file of lfsFiles) {
      const action = hrefs[file.sha256]
      if (!action || action.href == null) {
        log(`blob 已存在，跳过上传: ${file.name}`)
        continue
      }
      await withRetry(() => putBlob(action.href, file.localPath, file.size, action.headers), `上传 ${file.name}`)
      log(`已上传: ${file.name} (${file.size} bytes)`)
    }
    for (const file of inlineFiles) {
      log(`内联提交（未超过 LFS 阈值，不 batch）: ${file.name} (${file.size} bytes)`)
    }

    // 3) 组装 versions.json（合并远端既有索引）+ 原子 commit
    const versions = { ...remoteVersions }
    const now = new Date().toISOString()
    versions[version] = {
      tag: args.tag,
      channel,
      assets: files.map((f) => f.name),
      uploadedAt: now,
    }
    // 提交前自校验：合并只能新增/覆盖本版本，条目数不得少于读取到的数量。
    // 退化说明合并逻辑出错或发生并发写，宁可报错也不提交一份丢掉历史的索引。
    // 抛错而非 fail()：这样 finally 仍会删掉临时目录（fail 会直接 exit）。
    const mergedCount = Object.keys(versions).length
    if (mergedCount < previousCount) {
      throw new Error(`versions.json 合并异常: 读取 ${previousCount} 条，合并后 ${mergedCount} 条（疑似并发发布），拒绝提交`)
    }
    const indexFile = { name: VERSIONS_PATH, localPath: path.join(tempDir, 'versions.json'), size: 0, sha256: '' }
    fs.writeFileSync(indexFile.localPath, JSON.stringify({ updated: now, versions }, null, 2) + '\n', 'utf8')
    indexFile.size = fs.statSync(indexFile.localPath).size

    const actions = []
    for (const file of files) {
      for (const remotePath of file.remotePaths) actions.push(buildCommitAction(remotePath, file))
    }
    actions.push(buildCommitAction(VERSIONS_PATH, indexFile))

    const commitMessage = `Mirror ${args.tag} from ${args.repo}`
    await withRetry(
      () => api('POST', `/repos/${REPO_TYPE_SEGMENT}/${repoId}/commit/${REVISION}`, token, {
        commit_message: commitMessage,
        actions,
      }),
      `提交 ${actions.length} 个变更`,
    )
    log(`镜像完成: ${repoId} ← ${args.tag}（${files.length} 个资产，${actions.length} 个路径变更）`)
    writeSummary([
      '### ModelScope mirror: OK',
      '',
      `- Release: \`${args.tag}\` (${channel})`,
      `- Target: \`${repoId}\``,
      `- Files: ${files.length} assets (${lfsFiles.length} via LFS, ${inlineFiles.length} inlined), ${actions.length} paths committed`,
      `- Index: \`${VERSIONS_PATH}\` now holds ${mergedCount} version(s)`,
      `- Backfill if this run needs repeating: \`${backfillCommand()}\``,
    ])
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch (err) {
      log(`警告: 临时目录清理失败 ${tempDir}: ${truncate(err.message, 200)}`)
    }
  }
}

try {
  await main()
} catch (err) {
  fail(truncate(err?.message ?? err, 500))
}
