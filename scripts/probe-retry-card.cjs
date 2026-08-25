// Probe: retry-policy card on the Advanced Models settings page — render,
// field hydration from the stored sensenova policy, and the full write path
// (edit maxRetries 8 -> 9, save, then restore 8; settings.yaml is the oracle).
// Usage: electron scripts/probe-retry-card.cjs <url>   (default :64399)
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const url = process.argv[2] || 'http://127.0.0.1:64399'
const settingsPath = path.join(os.homedir(), '.dsh', 'settings.yaml')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const maxRetriesInYaml = () => {
  const text = fs.readFileSync(settingsPath, 'utf8')
  const match = /maxRetries:\s*(\d+)/g
  const found = [...text.matchAll(match)].map((m) => Number(m[1]))
  return found
}

const clickText = (text) => `(() => {
  const els = [...document.querySelectorAll('button, [role="button"], a, summary')];
  const t = els.find((b) => (b.textContent || '').trim().includes(${JSON.stringify(text)}));
  if (t) { t.click(); return true }
  return false
})()`

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280, height: 900, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  await win.loadURL(url)
  await sleep(9000)

  const out = { before: maxRetriesInYaml() }
  out.openedSettings = await win.webContents.executeJavaScript(clickText('设置'))
  await sleep(1500)
  out.openedAdvanced = await win.webContents.executeJavaScript(clickText('模型高级设置'))
  await sleep(2500)

  out.routePicked = await win.webContents.executeJavaScript(`(() => {
    const sel = document.querySelector('select[aria-label="选择路由"]');
    if (!sel) return false
    const opt = [...sel.options].find(o => o.value === 'sensenova');
    if (!opt) return false
    sel.value = 'sensenova'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  await sleep(1500)

  out.card = await win.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('details.dshAma-retryCard');
    if (!card) return null
    return { summary: card.querySelector('summary').textContent.trim() }
  })()`)

  out.fields = await win.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('details.dshAma-retryCard');
    if (!card) return null
    card.open = true
    const read = (label) => {
      const input = card.querySelector('input[aria-label="' + label + '"]')
      return input ? input.value : null
    }
    const mode = card.querySelector('select[aria-label="重试模式"]')
    const save = [...card.querySelectorAll('button')].find(b => (b.textContent || '').includes('保存重试策略'))
    return {
      mode: mode ? mode.value : null,
      maxRetries: read('最大重试次数'),
      initialDelayMs: read('首次重试延迟'),
      maxDelayMs: read('重试延迟上限'),
      jitterRatio: read('重试抖动比例'),
      saveDisabled: save ? save.disabled : null,
    }
  })()`)
  await sleep(300)

  // Write path: edit via the native setter (React-controlled input), save,
  // then read the notice/failure state. Run twice: 9 (mutate) then 8 (restore).
  const editAndSave = async (value) => win.webContents.executeJavaScript(`(async () => {
    const card = document.querySelector('details.dshAma-retryCard');
    if (!card) return { error: 'no card' }
    const input = card.querySelector('input[aria-label="最大重试次数"]');
    if (!input) return { error: 'no input' }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 400))
    const save = [...card.querySelectorAll('button')].find(b => (b.textContent || '').includes('保存重试策略'))
    if (!save) return { error: 'no save button' }
    if (save.disabled) return { error: 'save disabled after edit' }
    save.click()
    await new Promise(r => setTimeout(r, 3000))
    const notice = [...card.querySelectorAll('.dshAma-notice')].map(n => n.textContent)
    const failure = [...card.querySelectorAll('.dshAma-error')].map(n => n.textContent)
    const after = card.querySelector('input[aria-label="最大重试次数"]').value
    return { notice, failure, fieldAfter: after }
  })()`)

  out.write9 = await editAndSave('9')
  out.afterWrite9 = maxRetriesInYaml()
  out.write8 = await editAndSave('8')
  out.afterWrite8 = maxRetriesInYaml()

  console.log(JSON.stringify(out, null, 2))
  setTimeout(() => app.quit(), 300)
})
