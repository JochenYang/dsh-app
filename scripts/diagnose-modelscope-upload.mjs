#!/usr/bin/env node
// Diagnostic probe for the ModelScope LFS blob upload path.
//
// WHY THIS EXISTS
// The mirror flow (publish-modelscope.mjs) succeeds at the LFS batch call but
// the presigned blob PUT comes back HTTP 400 {"Code":10030000001}. The batch
// URL is trusted and does not reveal which request headers the storage
// endpoint actually wants, so the only reliable way to find the accepted
// header combination is to try controlled variants against synthetic files
// whose content is throwaway.
//
// WHAT IT DOES
// For each variant it creates a small unique file (>1 MiB, so it takes the LFS
// path), runs its own LFS batch call to obtain a fresh presigned URL, then PUTs
// the file with a variant-specific header set. Every variant uses unique
// content, so it gets a unique oid and can never reuse another variant's blob.
// No commit is issued: the mirror repo tree stays untouched and the probe blobs
// are simply unreferenced. Bodies and URLs are redacted before printing.
//
// Official client reference (modelscope_hub 0.4.2, LegacyClient.upload_blob):
//   PUT <presigned url>
//   Content-Length: <size>
//   X-Request-ID: <uuid>
//   Authorization: Bearer <token>
//   Cookie: m_session_id=<token>
// and no Content-Type. Credentials are attached only when the target host is
// the endpoint host or its lfs./pre-lfs. sibling (OpenAPIClient
// ._same_host_as_endpoint).
//
// Usage:
//   MODELSCOPE_TOKEN=... node scripts/diagnose-modelscope-upload.mjs \
//     --repo owner/name [--modelscope-repo ns/name] [--size-bytes 2097152]
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'

const ENDPOINT = (process.env.MODELSCOPE_ENDPOINT || 'https://www.modelscope.cn').replace(/\/+$/, '')
const REPO_TYPE_SEGMENT = 'models'
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_SIZE_BYTES = 2 * 1024 * 1024 // comfortably above the 1 MiB LFS threshold
const PROBE_PREFIX = '_diagnostics'

function fail(message) {
  console.error(`[diagnose] ${message}`)
  process.exit(2)
}

function log(message) {
  console.log(`[diagnose] ${message}`)
}

function truncate(text, max = 400) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, max)
}

// Strip anything that can carry a credential: full URLs keep origin+path only
// (signed query strings are dropped), and known credential values are masked.
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
    .replace(/(modelscope_session=)[^;&\s"']+/gi, '$1<redacted>')
    .replace(/(x-amz-(?:signature|credential|security-token)=)[^&\s"']+/gi, '$1<redacted>')
    .replace(/("?(?:AccessToken|access_token|Token|token)"?\s*[:=]\s*")[^"]+/gi, '$1<redacted>')
}

const CREDENTIAL_HEADER_PATTERN = /^(authorization|cookie|proxy-authorization)$|token|session/i

// Header previews must never leak a credential value.
function maskHeaderValue(name, value) {
  if (CREDENTIAL_HEADER_PATTERN.test(name)) return '<redacted>'
  return truncate(String(value), 120)
}

function headerNames(headers) {
  return Object.keys(headers || {}).join(', ') || '(none)'
}

function rawRequest(method, urlStr, { headers = {}, body = null, bodyStream = null, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr)
    const mod = url.protocol === 'http:' ? http : https
    const req = mod.request(url, { method, headers, timeout: REQUEST_TIMEOUT_MS }, (res) => {
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
    })
    req.on('timeout', () => req.destroy(new Error(`请求超时: ${method} ${url.host}`)))
    req.on('error', (err) => reject(new Error(`${method} ${url.host}${url.pathname} 网络失败: ${truncate(err.message, 200)}`)))
    if (bodyStream) bodyStream.pipe(req)
    else req.end(body)
  })
}

function authHeaders(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    Cookie: `m_session_id=${token}`,
    'X-Request-ID': crypto.randomUUID(),
    ...extra,
  }
}

// POST /api/v1/repos/models/{id}/info/lfs/objects/batch
async function batch(token, repoId, object) {
  const resp = await rawRequest('POST', `${ENDPOINT}/api/v1/repos/${REPO_TYPE_SEGMENT}/${repoId}/info/lfs/objects/batch`, {
    headers: authHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ operation: 'upload', objects: [object] }),
  })
  let parsed = null
  try {
    parsed = JSON.parse(resp.body.toString('utf8'))
  } catch {
    // non-JSON error body is reported below
  }
  const code = parsed ? parsed.Code ?? parsed.code : undefined
  const ok = resp.status >= 200 && resp.status < 300 && (code === undefined || code === 200 || code === '200')
  if (!ok) {
    const msg = parsed ? parsed.Message ?? parsed.message ?? '' : truncate(resp.body.toString('utf8'), 200)
    throw new Error(`LFS batch 失败: HTTP ${resp.status}${code !== undefined ? ` Code ${code}` : ''} ${truncate(msg, 200)}`)
  }
  const obj = parsed?.Data?.objects?.[0] ?? parsed?.objects?.[0]
  return {
    href: obj?.actions?.upload?.href ?? null,
    serverHeaders: obj?.actions?.upload?.header ?? {},
    rawCode: code,
  }
}

// Content-Type by extension, matching what a browser/uploader would send.
const CONTENT_TYPE_BY_EXT = {
  '.zip': 'application/zip',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.dmg': 'application/x-apple-diskimage',
  '.7z': 'application/x-7z-compressed',
}

function contentTypeForExt(ext) {
  return CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream'
}

// Each variant builds its own header set. ctx: { token, size, ext, serverHeaders }
const VARIANTS = [
  {
    id: 'A',
    label: '当前行为（Content-Type: octet-stream + Length + X-Request-ID）',
    ext: '.bin',
    build: (ctx) => ({
      'Content-Type': 'application/octet-stream',
      'Content-Length': ctx.size,
      'X-Request-ID': crypto.randomUUID(),
    }),
  },
  {
    id: 'B',
    label: 'A + Authorization: Bearer',
    ext: '.bin',
    build: (ctx) => ({
      'Content-Type': 'application/octet-stream',
      'Content-Length': ctx.size,
      'X-Request-ID': crypto.randomUUID(),
      Authorization: `Bearer ${ctx.token}`,
    }),
  },
  {
    id: 'C',
    label: 'B + Cookie: m_session_id',
    ext: '.bin',
    build: (ctx) => ({
      'Content-Type': 'application/octet-stream',
      'Content-Length': ctx.size,
      'X-Request-ID': crypto.randomUUID(),
      Authorization: `Bearer ${ctx.token}`,
      Cookie: `m_session_id=${ctx.token}`,
    }),
  },
  {
    id: 'D',
    label: '完全透传 batch 的 actions.upload.header（原样，另加 Content-Length）',
    ext: '.bin',
    build: (ctx) => ({
      ...ctx.serverHeaders,
      'Content-Length': ctx.size,
    }),
  },
  {
    id: 'E',
    label: 'A 但 Content-Type 按扩展名推断（.zip）',
    ext: '.zip',
    build: (ctx) => ({
      'Content-Type': contentTypeForExt(ctx.ext),
      'Content-Length': ctx.size,
      'X-Request-ID': crypto.randomUUID(),
    }),
  },
  {
    id: 'F',
    label: '官方客户端原样（无 Content-Type + Authorization + Cookie + Length + X-Request-ID）',
    ext: '.bin',
    build: (ctx) => ({
      'Content-Length': ctx.size,
      'X-Request-ID': crypto.randomUUID(),
      Authorization: `Bearer ${ctx.token}`,
      Cookie: `m_session_id=${ctx.token}`,
    }),
  },
]

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const eq = arg.indexOf('=')
    const key = eq === -1 ? arg : arg.slice(0, eq)
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1)
    if (value === undefined || value === '') fail(`参数 ${key} 缺少值`)
    switch (key) {
      case '--repo': args.repo = value; break
      case '--modelscope-repo': args.modelscopeRepo = value; break
      case '--size-bytes': args.sizeBytes = Number(value); break
      default: fail(`未知参数: ${key}`)
    }
  }
  args.repo = args.repo || process.env.GITHUB_REPOSITORY || ''
  if (!args.repo || !args.repo.includes('/')) fail('缺少 --repo（GitHub owner/name）')
  if (!Number.isFinite(args.sizeBytes) || args.sizeBytes <= 0) args.sizeBytes = DEFAULT_SIZE_BYTES
  return args
}

async function putVariant(uploadUrl, filePath, headers) {
  const stream = fs.createReadStream(filePath)
  try {
    const resp = await rawRequest('PUT', uploadUrl, { headers, bodyStream: stream })
    return { status: resp.status, body: truncate(redactSecrets(resp.body.toString('utf8')), 400) }
  } finally {
    stream.destroy()
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const token = process.env.MODELSCOPE_TOKEN || ''
  if (!token) fail('MODELSCOPE_TOKEN 未设置，无法进行上传诊断（该脚本需要真实凭据；CI 里由 secret 注入）')

  const [ghOwner, ghName] = args.repo.split('/')
  const repoId = (args.modelscopeRepo || process.env.MODELSCOPE_REPO || `${ghOwner}/${ghName}`).replace(/^\/+|\/+$/g, '')
  if (!repoId.includes('/')) fail(`ModelScope 仓库 id 不合法: ${repoId}`)

  log(`目标仓库: ${repoId}；合成文件大小: ${args.sizeBytes} bytes；变体数: ${VARIANTS.length}`)
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-diagnose-'))
  const results = []
  try {
    for (const variant of VARIANTS) {
      const name = `probe-${variant.id}-${crypto.randomUUID()}${variant.ext}`
      const filePath = path.join(tempDir, name)
      // Unique random content per variant → unique sha256 → unique oid, so a
      // variant can never silently reuse a blob uploaded by an earlier one.
      const payload = crypto.randomBytes(args.sizeBytes - variant.id.charCodeAt(0))
      fs.writeFileSync(filePath, payload)
      const size = payload.length
      const oid = crypto.createHash('sha256').update(payload).digest('hex')
      const record = { id: variant.id, label: variant.label, name, oid: oid.slice(0, 12) }

      log('')
      log(`=== 变体 ${variant.id}: ${variant.label} ===`)
      log(`  文件: ${PROBE_PREFIX}/${name} (${size} bytes, oid ${oid.slice(0, 12)}…)`)

      let batchResult
      try {
        batchResult = await batch(token, repoId, { oid, size })
      } catch (err) {
        record.error = `batch: ${truncate(err.message, 300)}`
        results.push(record)
        log(`  batch 失败: ${record.error}`)
        continue
      }
      record.serverHeaderNames = headerNames(batchResult.serverHeaders)
      record.serverHeadersPreview = Object.entries(batchResult.serverHeaders)
        .map(([k, v]) => `${k}=${maskHeaderValue(k, v)}`)
        .join('; ') || '(none)'
      log(`  batch 回执: header 名 = ${record.serverHeaderNames}`)
      log(`  batch 回执: header 值 = ${record.serverHeadersPreview}`)
      if (!batchResult.href) {
        record.error = 'batch 未返回 upload href（blob 已存在）'
        results.push(record)
        log(`  ${record.error}`)
        continue
      }
      log(`  上传地址: ${redactSecrets(batchResult.href)}`)

      const headers = variant.build({ token, size, ext: variant.ext, serverHeaders: batchResult.serverHeaders })
      record.requestHeaderNames = headerNames(headers)
      record.requestHeadersPreview = Object.entries(headers)
        .map(([k, v]) => `${k}=${maskHeaderValue(k, v)}`)
        .join('; ')
      log(`  请求头: ${record.requestHeadersPreview}`)

      try {
        const resp = await putVariant(batchResult.href, filePath, headers)
        record.status = resp.status
        record.body = resp.body
        record.ok = resp.status >= 200 && resp.status < 300
        log(`  PUT 结果: HTTP ${resp.status} ${record.ok ? '(成功)' : ''}`)
        if (resp.body) log(`  响应体: ${resp.body}`)
      } catch (err) {
        record.error = `PUT: ${truncate(err.message, 300)}`
        log(`  PUT 异常: ${record.error}`)
      }
      results.push(record)
    }

    log('')
    log('=== 结果矩阵 ===')
    for (const r of results) {
      const outcome = r.ok ? 'SUCCESS' : r.status !== undefined ? `HTTP ${r.status}` : 'ERROR'
      const detail = r.error || (r.ok ? '' : r.body || '')
      log(`  ${r.id}: ${outcome}${detail ? ` — ${detail}` : ''}`)
    }
    const winners = results.filter((r) => r.ok).map((r) => r.id)
    if (winners.length) {
      log(`结论: 成功变体 = ${winners.join(', ')}`)
    } else {
      log('结论: 没有任何变体成功，诊断不充分')
    }
    // Exit non-zero only when the experiment produced no usable answer, so a
    // red step in CI always means "inconclusive", never "one variant worked".
    process.exit(winners.length ? 0 : 1)
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
