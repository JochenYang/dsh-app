/**
 * CDP helpers for the probes that must drive the RUNNING window.
 *
 * Why this is a tracked module: the desktop window's document is
 * `dsh-app://app/index.html`, a scheme that exists only inside the app's own
 * process, so a probe that boots its own Electron instance cannot load it. Those
 * probes attach to a dev window launched with `--remote-debugging-port=9222`
 * instead — and they must be able to do that from a fresh clone, which is why
 * this helper is committed rather than kept in `scratch/` (it lived there until a
 * review pointed out the probes could not run anywhere but the author's machine).
 */

import { writeFileSync } from 'node:fs'

export async function connect(endpoint = process.env.CDP ?? 'http://127.0.0.1:9222') {
  const targets = await (await fetch(`${endpoint}/json`)).json()
  const pages = targets.filter((target) => target.type === 'page')
  const page = pages.find((target) => String(target.url).startsWith('dsh-app://')) ?? pages[0]
  if (page === undefined) throw new Error('no page target')
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let nextId = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const settle = pending.get(message.id)
    if (settle !== undefined) {
      pending.delete(message.id)
      settle(message)
    }
  })
  const send = (method, params = {}) => {
    const id = ++nextId
    return new Promise((resolve) => {
      pending.set(id, resolve)
      socket.send(JSON.stringify({ id, method, params }))
    })
  }
  const evaluate = async (expression) => {
    const reply = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    if (reply.error !== undefined) throw new Error(JSON.stringify(reply.error))
    const { result, exceptionDetails } = reply.result
    if (exceptionDetails !== undefined) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
    }
    return result.value
  }
  const mouse = async (type, x, y) => {
    await send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'none',
      buttons: 0,
      clickCount: 0,
    })
  }
  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
    })
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
    })
  }
  const shot = async (path) => {
    const reply = await send('Page.captureScreenshot', { format: 'png' })
    const data = reply.result?.data
    if (data === undefined) throw new Error(`screenshot failed: ${JSON.stringify(reply).slice(0, 300)}`)
    writeFileSync(path, Buffer.from(data, 'base64'))
    return path
  }
  return { send, evaluate, mouse, click, shot, close: () => socket.close() }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
