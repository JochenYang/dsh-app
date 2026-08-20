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
      hideActions()
      break
    case 'downloading':
      setPhase('正在下载内核')
      setMessage(status.message)
      setProgress(status.progress)
      hideActions()
      break
    case 'extracting':
    case 'installing':
      // Bundled or in-progress activation: silent, no buttons.
      setPhase('正在初始化应用内核')
      setMessage(status.message)
      setProgress(null)
      hideActions()
      break
    case 'starting':
      // Launch transition for an already-installed kernel: show progress
      // while the server boots, no buttons.
      setPhase('正在启动 DSH APP')
      setMessage(status.message)
      setProgress(null)
      hideActions()
      break
    case 'ready':
      setPhase('就绪')
      setMessage('正在启动 DSH APP…')
      hideActions()
      break
    case 'error':
      setPhase('出现问题')
      setMessage(status.message)
      showError(status.error || 'Unknown error')
      break
    case 'idle':
      // Online setup fallback: the user must click install to download.
      setPhase('DSH APP 安装')
      setMessage(status.message)
      el.install.hidden = false
      el.install.textContent = '安装'
      el.cancel.hidden = false
      break
    default:
      setPhase('DSH APP 安装')
      setMessage(status.message)
  }
})

function hideActions() {
  el.install.hidden = true
  el.cancel.hidden = true
}

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

// Wait for the first status from the main process before showing anything:
// bundled activation sends extracting/installing immediately (silent), while
// the online fallback sends idle (then we show the install button).
setPhase('正在准备…')
setMessage('正在初始化应用内核。')
hideActions()
