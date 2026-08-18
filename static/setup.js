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
  el.install.textContent = 'Retry'
  busy = false
}

window.dshSetup.onStatus((status) => {
  switch (status.phase) {
    case 'checking':
      setPhase('Checking for updates')
      setMessage(status.message)
      setProgress(null)
      break
    case 'downloading':
      setPhase('Downloading kernel')
      setMessage(status.message)
      setProgress(status.progress)
      break
    case 'extracting':
    case 'installing':
    case 'starting':
      setPhase('Installing')
      setMessage(status.message)
      setProgress(null)
      break
    case 'ready':
      setPhase('Ready')
      setMessage('Starting DSH App…')
      break
    case 'error':
      setPhase('Something went wrong')
      setMessage(status.message)
      showError(status.error || 'Unknown error')
      break
    default:
      setPhase('DSH App setup')
      setMessage(status.message)
  }
})

el.install.addEventListener('click', () => {
  if (busy) return
  busy = true
  el.install.hidden = true
  el.error.hidden = true
  setPhase('Installing')
  setMessage('Preparing kernel…')
  window.dshSetup.install()
})

el.cancel.addEventListener('click', () => window.dshSetup.cancel())

// Show the install button immediately on first run.
setPhase('DSH App setup')
setMessage('The kernel runtime is not installed yet.')
el.install.hidden = false
el.install.textContent = 'Install'
