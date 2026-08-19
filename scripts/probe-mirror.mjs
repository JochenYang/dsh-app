// Connectivity probe for the kernel update chain from mainland China.
// Run: node scripts/probe-mirror.mjs
const targets = [
  ['npmjs.org (official registry)', 'https://registry.npmjs.org/@deepseek-ai%2Fdsh'],
  ['npmmirror.com (registry mirror)', 'https://registry.npmmirror.com/@deepseek-ai%2Fdsh'],
]

async function probe(label, url, timeoutMs = 10_000) {
  const t0 = Date.now()
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'curl/8' } })
    const buf = new Uint8Array(await res.arrayBuffer())
    console.log(`[OK ] ${label.padEnd(38)} HTTP ${res.status} ${(buf.length / 1024).toFixed(0)}KB in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    return true
  } catch (e) {
    console.log(`[ERR] ${label.padEnd(38)} ${e.name}: ${e.message} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
    return false
  }
}

console.log('=== 1. npm registry metadata (kernel version resolution) ===')
for (const [label, url] of targets) await probe(label, url)

// GitHub asset probes. Use a real, stable public release asset so the mirror
// chain is validated even before the dsh-app release repo exists.
const base = process.env.PROBE_BASE
  ?? 'https://github.com/deepseek-ai/deepseek-harness/releases/download'
const tag = process.env.PROBE_TAG
const asset = process.env.PROBE_ASSET

console.log('\n=== 2. GitHub release-asset mirrors (real asset through each proxy) ===')
// A small, stable public release asset; proves the mirror proxies real
// GitHub release downloads from this network.
const realAsset = process.env.PROBE_URL
  ?? 'https://github.com/upx/upx/releases/download/v4.2.4/upx-4.2.4-win64.zip'
await probe('github.com (official)', realAsset, 20_000)
for (const m of ['https://ghfast.top/', 'https://gh-proxy.com/', 'https://mirror.ghproxy.com/']) {
  await probe(m.replace(/^https:\/\//, '').replace(/\/$/, ''), `${m}${realAsset}`, 20_000)
}
