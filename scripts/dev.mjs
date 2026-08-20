// Cross-platform dev launcher (npm run dev).
// Sets DSH_APP_DEV=1 and points DSH_APP_DEV_RUNTIME at a deepseek-harness
// checkout, then builds and starts Electron with the shell's stdio inherited.
// When DSH_APP_DEV_RUNTIME is not set it probes two sibling layouts:
//   - <repo>/../deepseek-harness   (documented standard layout)
//   - <repo>/../../deepseek-harness(two-level sibling, e.g. harness sitting
//     beside the parent directory)
// and fails with a hint when neither exists.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(here, '..')

if (process.env.DSH_APP_DEV_RUNTIME === undefined) {
  const candidates = [
    path.resolve(appRoot, '..', 'deepseek-harness'),
    path.resolve(appRoot, '..', '..', 'deepseek-harness'),
  ]
  const found = candidates.find((dir) => existsSync(path.join(dir, 'package.json')))
  if (found !== undefined) {
    process.env.DSH_APP_DEV_RUNTIME = found
  } else {
    console.error('[dev] no deepseek-harness checkout found; tried:')
    for (const dir of candidates) console.error(`  - ${dir}`)
    console.error('[dev] set DSH_APP_DEV_RUNTIME to its location and re-run `npm run dev`.')
    process.exit(1)
  }
}

process.env.DSH_APP_DEV = '1'
console.log(`[dev] DSH_APP_DEV=1, DSH_APP_DEV_RUNTIME=${process.env.DSH_APP_DEV_RUNTIME}`)

// npm start = tsc+copy-static build, then `electron .`. The child inherits
// stdio so boot/server logs stay visible; shell:true resolves the npm shim
// on Windows (npm.cmd) and the bare binary on POSIX alike.
const result = spawnSync('npm', ['start'], {
  cwd: appRoot,
  stdio: 'inherit',
  env: process.env,
  shell: true,
})
process.exit(result.status ?? 1)