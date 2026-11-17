// Copy static/ into dist/static after tsc, plus the brand-suite loader overlay
// (read via __dirname at every server start). static/ holds the first-launch
// splash page (startup.html), loaded by startup-window.ts as dist/static/...;
// the directory is copied only when it exists, since git does not track empty
// directories.
import { existsSync } from 'node:fs'
import { cp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dest = path.join(root, 'dist', 'static')

// Mirror, never merge: a plain cp leaves files from an earlier build behind
// (the retired setup UI), and electron-builder packages whatever dist/ holds.
await rm(dest, { recursive: true, force: true })
await mkdir(dest, { recursive: true })
const staticDir = path.join(root, 'static')
if (existsSync(staticDir)) {
  await cp(staticDir, dest, { recursive: true })
  console.log('static assets copied → dist/static')
}

await cp(path.join(root, 'plugins', 'dsh-app.patch.yml'), path.join(root, 'dist', 'main', 'dsh-app.patch.yml'))
console.log('brand-suite overlay copied → dist/main/dsh-app.patch.yml')

// Tray icon: copy into dist/ so it lands inside app.asar at dist/icon.png
// (resources/ is the buildResources dir and is NOT packaged into asar).
await cp(path.join(root, 'resources', 'icon.png'), path.join(root, 'dist', 'icon.png'))
console.log('tray icon copied → dist/icon.png')

// Changelog for the About page: the app reads its own release notes instead of
// sending the user to a browser. Generated here (not hand-maintained) so
// CHANGELOG.md stays the only source of truth; the shell serves this file at
// `dsh-app://app/__changelog.json`.
const CHANGELOG_VERSIONS = 5
const changelogSource = path.join(root, 'CHANGELOG.md')
if (existsSync(changelogSource)) {
  const text = await (await import('node:fs/promises')).readFile(changelogSource, 'utf8')
  const versions = []
  let current = null
  let language = null
  for (const line of text.split(/\r?\n/u)) {
    const heading = /^## \[v(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/u.exec(line)
    if (heading !== null) {
      if (current !== null) versions.push(current)
      current = { version: heading[1], date: heading[2], zh: [], en: [] }
      language = null
      continue
    }
    if (current === null) continue
    if (/^### 中文$/u.test(line)) { language = 'zh'; continue }
    if (/^### English$/u.test(line)) { language = 'en'; continue }
    if (/^## /u.test(line)) { versions.push(current); current = null; language = null; continue }
    const bullet = /^- (.*\S)$/u.exec(line)
    if (bullet !== null && language !== null) current[language].push(bullet[1])
  }
  if (current !== null) versions.push(current)
  const complete = versions.filter((entry) => entry.zh.length > 0 && entry.en.length > 0).slice(0, CHANGELOG_VERSIONS)
  if (complete.length === 0) throw new Error('changelog: no bilingual version section found')
  await (await import('node:fs/promises')).writeFile(
    path.join(root, 'dist', 'changelog.json'),
    `${JSON.stringify({ versions: complete }, null, 2)}\n`,
    'utf8',
  )
  console.log(`changelog generated → dist/changelog.json (${complete.length} version(s))`)
}
