#!/usr/bin/env node
/**
 * Probe for the Windows shell-update flow (src/main/updater.ts).
 *
 * Validates against the REAL latest.yml of the latest published release:
 *  1. fetch latest.yml (official URL, or a mirror prefix via PROBE_URL)
 *  2. parseLatestYaml() — version + files[] must match the live metadata
 *  3. pickAsset() — must select the x64 installer on x64
 *  4. sha512 entries must be valid base64 decoding to 64 bytes
 *  5. HEAD the installer download candidate chain (official + mirrors) to
 *     confirm the URLs resolve — WITHOUT downloading the ~160 MB installer.
 *
 * Run after `npm run build`:
 *   node scripts/probe-shell-update.mjs
 * Custom metadata URL override:  PROBE_URL=... node scripts/probe-shell-update.mjs
 */
import assert from 'node:assert'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const { parseLatestYaml, pickAsset } = await import(
  pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'main', 'updater.js')).href
)

const OWNER = 'JochenYang'
const REPO = 'dsh-app'
const overrideUrl = process.env.PROBE_URL

async function fetchYaml() {
  const urls = overrideUrl
    ? [overrideUrl]
    : [
        `https://github.com/${OWNER}/${REPO}/releases/latest/download/latest.yml`,
        `https://gh-proxy.com/https://github.com/${OWNER}/${REPO}/releases/latest/download/latest.yml`,
        `https://ghfast.top/https://github.com/${OWNER}/${REPO}/releases/latest/download/latest.yml`,
      ]
  for (const url of urls) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) })
      if (res.ok) return { text: await res.text(), source: url }
      console.log(`  metadata ${res.status}: ${url}`)
    } catch (err) {
      console.log(`  metadata ERR: ${url} (${(err.cause?.code || err.message).slice(0, 60)})`)
    }
  }
  return null
}

async function main() {
  console.log('fetching latest.yml…')
  const yaml = await fetchYaml()
  assert.ok(yaml, 'latest.yml must be reachable from at least one source')

  const parsed = parseLatestYaml(yaml.text)
  assert.ok(parsed, 'latest.yml must parse')
  assert.ok(/^\d+\.\d+\.\d+/.test(parsed.version), `version looks like semver: ${parsed.version}`)
  assert.ok(parsed.files.length >= 1, 'at least one file entry')
  console.log(`  version: ${parsed.version} (source ${yaml.source.split('github.com')[1] || yaml.source})`)
  console.log(`  files: ${parsed.files.map((f) => f.url).join(', ')}`)

  for (const f of parsed.files) {
    const decoded = Buffer.from(f.sha512, 'base64')
    assert.strictEqual(decoded.length, 64, `sha512 base64 decodes to 64 bytes for ${f.url}`)
    const re = Buffer.from(decoded).toString('base64')
    assert.strictEqual(re, f.sha512, `sha512 is canonical base64 for ${f.url}`)
  }
  console.log('  sha512: all entries are canonical base64 of 64 bytes')

  const asset = pickAsset(parsed.files, process.arch)
  assert.ok(asset, 'pickAsset must find an installer')
  const suffix = `-win-${process.arch}.exe`
  assert.ok(
    asset.url.endsWith(suffix) || /-win\.exe$/.test(asset.url) || /-win-x64\.exe$/.test(asset.url),
    `picked asset matches ${process.arch}: ${asset.url}`,
  )
  console.log(`  picked for ${process.arch}: ${asset.url}`)

  // Candidate chain resolves (HEAD, no body).
  const candidates = [
    `https://github.com/${OWNER}/${REPO}/releases/latest/download/${asset.url}`,
    `https://gh-proxy.com/https://github.com/${OWNER}/${REPO}/releases/latest/download/${asset.url}`,
  ]
  let reachable = false
  for (const url of candidates) {
    try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(20_000) })
      console.log(`  candidate HTTP ${res.status}: ${url.split('github.com').pop()}`)
      if (res.ok) reachable = true
    } catch (err) {
      console.log(`  candidate ERR: ${url} (${(err.cause?.code || err.message).slice(0, 60)})`)
    }
  }
  assert.ok(reachable, 'at least one download candidate is reachable')

  console.log('\nprobe-shell-update: all assertions passed')
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})