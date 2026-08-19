// Copy static/ (setup window assets) into dist/static after tsc, and the
// brand-suite loader overlay next to the main bundle (brand-suite.ts reads
// it via __dirname at every server start).
import { cp, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dest = path.join(root, 'dist', 'static')

await mkdir(dest, { recursive: true })
await cp(path.join(root, 'static'), dest, { recursive: true })
console.log('static assets copied → dist/static')

await cp(path.join(root, 'plugins', 'dsh-app.patch.yml'), path.join(root, 'dist', 'main', 'dsh-app.patch.yml'))
console.log('brand-suite overlay copied → dist/main/dsh-app.patch.yml')
