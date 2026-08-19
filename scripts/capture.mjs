// Capture the running dsh web UI to PNGs for visual design work.
// Usage: electron scripts/capture.mjs <url> <outDir> [width] [height]
import { app, BrowserWindow } from 'electron'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const url = process.argv[2]
const outDir = process.argv[3] ?? 'shots'
const width = Number(process.argv[4] ?? 1440)
const height = Number(process.argv[5] ?? 900)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    webPreferences: { offscreen: false, backgroundThrottling: false },
  })
  await win.loadURL(url)
  await mkdir(outDir, { recursive: true })

  const shots = [2500, 5000, 8000]
  for (let i = 0; i < shots.length; i++) {
    await sleep(shots[i] - (i === 0 ? 0 : shots[i - 1]))
    const image = await win.webContents.capturePage()
    const file = path.join(outDir, `shot-${i + 1}-${Date.now()}.png`)
    await import('node:fs/promises').then((fs) => fs.writeFile(file, image.toPNG()))
    console.log('captured', file)
  }
  app.quit()
})
