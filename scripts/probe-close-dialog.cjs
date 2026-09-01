#!/usr/bin/env node
/**
 * Probe for the injected close-dialog script (src/main/close-dialog.ts).
 *
 * Executes the REAL production script (from dist/) against a minimal DOM stub
 * and asserts: themed modal render (mask + card + three buttons), theme-token
 * fallback colors, choice resolution for each button (tray/quit/cancel), Esc
 * and Enter keyboard handling, dedup of a prior unresolved invocation, and
 * mask-click cancel. The script also removes its DOM afterwards.
 *
 * Run after `npm run build`:
 *   node scripts/probe-close-dialog.cjs
 */
const assert = require('node:assert')
const path = require('node:path')

const { CLOSE_DIALOG_SCRIPT } = require(path.join(__dirname, '..', 'dist', 'main', 'close-dialog.js'))

// ------------------------------------------------------------- DOM stub
/** Mimics a browser: assigning style.cssText parses into style.<prop> keys. */
function makeStyle() {
  const s = {}
  Object.defineProperty(s, 'cssText', {
    set(v) {
      for (const k of Object.keys(s)) delete s[k]
      for (const part of String(v).split(';')) {
        const idx = part.indexOf(':')
        if (idx > 0) {
          const key = part.slice(0, idx).trim()
          const val = part.slice(idx + 1).trim()
          if (key) s[key] = val
        }
      }
    },
    get() { return '' },
  })
  return s
}

function makeElement(tag, register) {
  const el = {
    tag,
    style: makeStyle(),
    children: [],
    _parent: null,
    _text: '',
    attributes: {},
    listeners: {},
    type: '',
    className: '',
    setAttribute(k, v) { this.attributes[k] = v; if (k === 'id') register?.(v, this) },
    appendChild(c) { c._parent = this; this.children.push(c); if (c.attributes.id) register?.(c.attributes.id, c); return c },
    removeChild(c) {
      const i = this.children.indexOf(c)
      if (i >= 0) this.children.splice(i, 1)
      if (c.attributes.id) register?.(c.attributes.id, null)
    },
    get parentNode() { return this._parent },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) },
    removeEventListener(type, fn) {
      const list = this.listeners[type]
      if (list) { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1) }
    },
    click() { for (const fn of this.listeners['click'] ?? []) fn({ target: this, stopPropagation: () => {}, preventDefault: () => {} }) },
  }
  Object.defineProperty(el, 'id', {
    get() { return this.attributes.id },
    set(v) { this.attributes.id = v; register?.(v, this) },
  })
  Object.defineProperty(el, 'textContent', {
    get() { return this._text },
    set(v) { this._text = v; if (v === '') this.children = [] },
  })
  return el
}

const makeRegistry = () => {
  const map = new Map()
  return {
    register: (id, el) => { if (el) map.set(id, el); else map.delete(id) },
    get: (id) => map.get(id) || null,
  }
}

/** Script needs: getComputedStyle(document.body), document.{body,getElementById,
 * createElement, addEventListener, removeEventListener}, window['__dshInFrameDialog_dsh-close-dialog'].
 */
let reg = makeRegistry()
const listeners = { keydown: [] }
const documentStub = {
  body: null,
  getElementById(id) { return reg.get(id) },
  createElement(tag) { return makeElement(tag, reg.register) },
  addEventListener(type, fn) { (listeners[type] ??= []).push(fn) },
  removeEventListener(type, fn) {
    const list = listeners[type]
    if (list) { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1) }
  },
}
const windowStub = {}

const THEME_FIXTURE = {
  '--dsw-alias-bg-layer-1': 'rgb(255, 255, 255)',
  '--dsw-alias-bg-overlay': 'rgb(38, 48, 74)',
  '--dsw-alias-label-primary': 'rgb(15, 23, 42)',
  '--dsw-alias-label-secondary': 'rgb(71, 85, 105)',
  '--dsw-alias-border-l1': 'rgba(15, 23, 42, 0.06)',
  '--dsw-alias-brand-primary': 'rgb(59, 130, 246)',
}

function resetDom(theme = THEME_FIXTURE) {
  reg = makeRegistry()
  documentStub.body = makeElement('body', reg.register)
  listeners.keydown.length = 0
  global.document = documentStub
  global.window = windowStub
  global.getComputedStyle = () => ({
    getPropertyValue(name) { return theme[name] ?? '' },
  })
  windowStub.__dshCloseDialog = null
}

function run() {
  return eval(CLOSE_DIALOG_SCRIPT) // eslint-disable-line no-eval
}

function bodyMask() {
  const m = documentStub.body.children[0]
  assert.ok(m, 'mask appended to body')
  assert.strictEqual(m.id, 'dsh-close-dialog')
  return m
}

function press(key) {
  for (const fn of listeners.keydown) fn({ key })
}

// ---------------------------------------------------------------- cases
const tick = () => new Promise(r => setImmediate(r))
async function runCase(fn) { resetDom(undefined); await fn() }

async function main() {
  // 1. Render: mask + card + title/message/actions with three buttons.
  resetDom()
  {
    const promise = run()
    assert.ok(promise && typeof promise.then === 'function', 'script returns a promise')
    const mask = bodyMask()
    assert.strictEqual(mask.children.length, 1, 'mask holds one card')
    const card = mask.children[0]
    const title = card.children[0]
    assert.strictEqual(title.textContent, '关闭 DSH APP')
    assert.strictEqual(card.children[1].textContent, '关闭窗口后要如何运行？')
    const actions = card.children[2]
    const labels = actions.children.map(b => b.textContent)
    assert.deepStrictEqual(labels, ['取消', '退出程序', '最小化到托盘'])
    assert.strictEqual(card.style.background, 'rgb(255, 255, 255)')
    assert.strictEqual(actions.children[2].style.background, 'rgb(59, 130, 246)')
    console.log('pass 1/6: themed render (mask + card + 3 buttons)')
  }

  // 2. Tray resolves and cleans DOM.
  resetDom()
  {
    const promise = run()
    bodyMask().children[0].children[2].children[2].click()
    assert.strictEqual(await promise, 'tray')
    assert.strictEqual(documentStub.body.children.length, 0, 'mask removed after choice')
    assert.strictEqual(windowStub.__dshCloseDialog, null, 'registry cleared')
    console.log('pass 2/6: tray button => "tray", DOM cleaned')
  }

  // 3. Quit / cancel / mask-click.
  resetDom()
  {
    const promise = run()
    bodyMask().children[0].children[2].children[1].click()
    assert.strictEqual(await promise, 'quit')
  }
  resetDom()
  {
    const promise = run()
    bodyMask().children[0].children[2].children[0].click()
    assert.strictEqual(await promise, 'cancel')
  }
  resetDom()
  {
    const promise = run()
    documentStub.body.children[0].click() // mask itself
    assert.strictEqual(await promise, 'cancel')
    console.log('pass 3/6: quit / cancel / mask-click resolve correctly')
  }

  // 4. Keyboard.
  resetDom()
  {
    const promise = run()
    press('Enter')
    assert.strictEqual(await promise, 'tray')
    assert.strictEqual(listeners.keydown.length, 0, 'keydown listener removed after settle')
  }
  resetDom()
  {
    const promise = run()
    press('Escape')
    assert.strictEqual(await promise, 'cancel')
    console.log('pass 4/6: Enter => tray, Esc => cancel, listener cleaned')
  }

  // 5. Dedup.
  resetDom()
  {
    const first = run()
    const second = run()
    assert.strictEqual(await first, 'cancel', 'first promise settled as cancel')
    bodyMask().children[0].children[2].children[2].click()
    assert.strictEqual(await second, 'tray')
    console.log('pass 5/6: re-invocation dedups the prior unresolved dialog')
  }

  // 6. Fallbacks.
  resetDom({})
  {
    run()
    const card = bodyMask().children[0]
    assert.strictEqual(card.style.background, '#ffffff', 'neutral bg fallback')
    assert.strictEqual(card.children[2].children[2].style.background, '#3b82f6', 'brand fallback')
    console.log('pass 6/6: neutral fallbacks when theme tokens absent')
  }

  console.log('\nprobe-close-dialog: all assertions passed')
}

main().catch((e) => { console.error(e); process.exit(1) })
