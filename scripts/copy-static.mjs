// Copy static/ into dist/static after tsc, plus the brand-suite loader overlay
// (read via __dirname at every server start). The static dir is currently
// empty (setup UI removed); git does not track empty directories, so only copy
// when it exists.
import { existsSync } from 'node:fs'
import { cp, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dest = path.join(root, 'dist', 'static')

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
