// Generate bilingual (zh/en) release notes for a version from CHANGELOG.md,
// in the <details>/<summary> structure GitHub's renderer actually supports
// (JS/CSS tab toggles are stripped by sanitization — this is the closest
// native "click to switch" pattern). Writes release-notes.md, then publish
// with: gh release edit <tag> --draft=false --notes-file release-notes.md
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const changelogPath = path.join(root, 'CHANGELOG.md')
const outPath = path.join(process.cwd(), 'release-notes.md')

const versionArg = process.argv[2]
if (!versionArg) {
  console.error('usage: node scripts/gen-release-notes.mjs <version>   e.g. v0.1.6')
  process.exit(1)
}
const tag = versionArg.startsWith('v') ? versionArg : `v${versionArg}`

const src = await readFile(changelogPath, 'utf8')
const lines = src.split(/\r?\n/)

// Locate the "## [vX.Y.Z]" block and read until the next "## " heading.
let start = -1
for (let i = 0; i < lines.length; i++) {
  const m = /^##\s+\[v([^\]]+)\]/.exec(lines[i])
  if (m && `v${m[1]}` === tag) {
    start = i
    break
  }
}
if (start === -1) {
  console.error(`CHANGELOG.md has no entry for ${tag}`)
  process.exit(1)
}
let end = lines.length
for (let i = start + 1; i < lines.length; i++) {
  if (/^##\s/.test(lines[i])) {
    end = i
    break
  }
}

// Slice one sub-section ("### 中文" / "### English") out of the version block.
function sliceSub(blockLines, title) {
  const idx = blockLines.findIndex((l) => l.trim() === title)
  if (idx === -1) return null
  const body = []
  for (let i = idx + 1; i < blockLines.length; i++) {
    if (/^#{2,5}\s/.test(blockLines[i])) break
    body.push(blockLines[i])
  }
  const text = body.join('\n').trim()
  return text === '' ? null : text
}

const block = lines.slice(start + 1, end)
const zh = sliceSub(block, '### 中文')
const en = sliceSub(block, '### English')
if (!zh) {
  console.error(`entry ${tag} is missing a non-empty "### 中文" section`)
  process.exit(1)
}
if (!en) {
  console.error(`entry ${tag} is missing a non-empty "### English" section`)
  process.exit(1)
}

const notes = `## 🚀 DSH APP ${tag} 更新说明 / Release Notes

<details open><summary>🇨🇳 中文</summary>

${zh}

</details>

<details><summary>🇬🇧 English</summary>

${en}

</details>

---
安装包见下方 Release 附件（Windows / macOS / Linux）。
Installers are attached below (Windows / macOS / Linux).
`

await writeFile(outPath, notes, 'utf8')
console.log(`release notes for ${tag} written → ${outPath}`)
console.log(`publish: gh release edit ${tag} --repo JochenYang/dsh-app --draft=false --notes-file ${outPath}`)
