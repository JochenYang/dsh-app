// Copy static/ (setup window assets) into dist/static after tsc.
import { cp, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dest = path.join(root, 'dist', 'static')

await mkdir(dest, { recursive: true })
await cp(path.join(root, 'static'), dest, { recursive: true })
console.log('static assets copied → dist/static')
