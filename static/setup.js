/* Setup window renderer: talks to the main process through the preload bridge. */

const el = {
  phase: document.getElementById('phase'),
  message: document.getElementById('message'),
  progress: document.getElementById('progress'),
  install: document.getElementById('install'),
  cancel: document.getElementById('cancel'),
  error: document.getElementById('error'),
}

let busy = false

function setPhase(text) {
  el.phase.textContent = text
}

function setMessage(text) {
  el.message.textContent = text
}

function setProgress(ratio) {
  el.progress.style.width = ratio === null ? '8%' : `${Math.round(ratio * 100)}%`
}

function showError(text) {
  el.error.hidden = false
  el.error.textContent = text
  el.install.hidden = false
  el.install.textContent = '重试'
  busy = false
}

window.dshSetup.onStatus((status) => {
  switch (status.phase) {
    case 'checking':
      setPhase('正在检查更新')
      setMessage(status.message)
      setProgress(null)
      break
    case 'downloading':
      setPhase('正在下载内核')
      setMessage(status.message)
      setProgress(status.progress)
      break
    case 'extracting':
    case 'installing':
    case 'starting':
      setPhase('正在安装')
      setMessage(status.message)
      setProgress(null)
      break
    case 'ready':
      setPhase('就绪')
      setMessage('正在启动 DSH App…')
      break
    case 'error':
      setPhase('出现问题')
      setMessage(status.message)
      showError(status.error || 'Unknown error')
      break
    default:
      setPhase('DSH App 安装')
      setMessage(status.message)
  }
})

el.install.addEventListener('click', () => {
  if (busy) return
  busy = true
  el.install.hidden = true
  el.error.hidden = true
  setPhase('正在安装')
  setMessage('正在准备内核…')
  window.dshSetup.install()
})

el.cancel.addEventListener('click', () => window.dshSetup.cancel())

// Show the install button immediately on first run.
setPhase('DSH App 安装')
setMessage('内核运行时尚未安装。')
el.install.hidden = false
el.install.textContent = '安装'
