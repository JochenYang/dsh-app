#!/usr/bin/env node
/**
 * Probe for the injected generic dialog script (src/main/in-frame-dialog.ts).
 *
 * Executes the REAL production script (from dist/) against a minimal DOM stub
 * and asserts: parameterized render (title/message/detail/buttons), themed
 * fallback colors, per-button value resolution, Esc→cancelValue and
 * Enter→default, dedup of a prior unresolved invocation, mask-click cancel,
 * and clean DOM removal. Complements probe-close-dialog.cjs (which covers the
 * close-specific config through the same engine).
 *
 * Run after `npm run build`:
 *   node scripts/probe-in-frame-dialog.cjs
 */
const assert = require('node:assert')
const path = require('node:path')

const { inFrameDialogScript } = require(path.join(__dirname, '..', 'dist', 'main', 'in-frame-dialog.js'))

// ------------------------------------------------------------- DOM stub
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

const THEME = {
  '--dsw-alias-bg-layer-1': 'rgb(255, 255, 255)',
  '--dsw-alias-label-primary': 'rgb(15, 23, 42)',
  '--dsw-alias-label-secondary': 'rgb(71, 85, 105)',
  '--dsw-alias-border-l1': 'rgba(15, 23, 42, 0.06)',
  '--dsw-alias-brand-primary': 'rgb(59, 130, 246)',
}

function resetDom(theme = THEME) {
  reg = makeRegistry()
  documentStub.body = makeElement('body', reg.register)
  listeners.keydown.length = 0
  global.document = documentStub
  global.window = windowStub
  global.getComputedStyle = () => ({
    getPropertyValue(name) { return theme[name] ?? '' },
  })
  windowStub.__dshInFrameDialog = null
}

function run(config) { return eval(inFrameDialogScript(config)) } // eslint-disable-line no-eval
function press(key) { for (const fn of listeners.keydown) fn({ key }) }

const tick = () => new Promise(r => setImmediate(r))

// ---------------------------------------------------------------- cases
async function main() {
  // 1. Parameterized render: title + message + detail + three buttons.
  resetDom()
  {
    const promise = run({
      title: '内核更新可用',
      message: 'dsh 0.1.1-rc.2 → 0.1.2-alpha.3',
      detail: '现在下载并激活？服务将会重启。',
      buttons: [
        { label: '稍后', value: 'later' },
        { label: '立即更新', value: 'update', primary: true },
      ],
      cancelValue: 'later',
      enterValue: 'update',
    })
    assert.ok(promise && typeof promise.then === 'function', 'returns a promise')
    const mask = documentStub.body.children[0]
    assert.strictEqual(mask.id, 'dsh-in-frame-dialog')
    const card = mask.children[0]
    assert.strictEqual(card.children[0].textContent, '内核更新可用')
    assert.strictEqual(card.children[1].textContent, 'dsh 0.1.1-rc.2 → 0.1.2-alpha.3')
    assert.strictEqual(card.children[2].textContent, '现在下载并激活？服务将会重启。')
    const actions = card.children[3]
    assert.deepStrictEqual(actions.children.map(b => b.textContent), ['稍后', '立即更新'])
    assert.strictEqual(actions.children[1].style.background, 'rgb(59, 130, 246)', 'primary themed')
    console.log('pass 1/6: parameterized render (title + message + detail + buttons)')
  }

  // 2. Button value resolution.
  resetDom()
  {
    const promise = run({
      title: 'x', message: 'm',
      buttons: [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b', primary: true },
      ],
      cancelValue: 'cancel', enterValue: 'b',
    })
    // Buttons live in: mask → card → actions → buttons.
    const card = documentStub.body.children[0].children[0]
    const actions = card.children[card.children.length - 1]
    actions.children[0].click()
    assert.strictEqual(await promise, 'a', 'first button value')
  }
  resetDom()
  {
    const promise = run({
      title: 'x', message: 'm',
      buttons: [{ label: 'B', value: 'b', primary: true }],
      cancelValue: 'cancel', enterValue: 'b',
    })
    const card = documentStub.body.children[0].children[0]
    card.children[card.children.length - 1].children[0].click()
    assert.strictEqual(await promise, 'b', 'single primary button')
    console.log('pass 2/6: button values resolve correctly')
  }

  // 3. Esc → cancelValue; Enter → enterValue.
  resetDom()
  {
    const promise = run({
      title: 'x', message: 'm',
      buttons: [{ label: 'B', value: 'b', primary: true }, { label: 'C', value: 'c' }],
      cancelValue: 'esc', enterValue: 'b',
    })
    press('Escape')
    assert.strictEqual(await promise, 'esc')
  }
  resetDom()
  {
    const promise = run({
      title: 'x', message: 'm',
      buttons: [{ label: 'B', value: 'b', primary: true }, { label: 'C', value: 'c' }],
      cancelValue: 'esc', enterValue: 'b',
    })
    press('Enter')
    assert.strictEqual(await promise, 'b')
    assert.strictEqual(listeners.keydown.length, 0, 'keydown listener removed')
    console.log('pass 3/6: Esc → cancelValue, Enter → default, listener cleaned')
  }

  // 4. Mask click = cancel; detail omitted keeps message margin default.
  resetDom()
  {
    const promise = run({
      title: 'x', message: 'm',
      buttons: [{ label: 'B', value: 'b', primary: true }],
      cancelValue: 'none', enterValue: 'b',
    })
    documentStub.body.children[0].click()
    assert.strictEqual(await promise, 'none')
  }
  resetDom()
  {
    const promise = run({
      title: 'x', message: 'm',
      buttons: [{ label: 'B', value: 'b', primary: true }],
    })
    documentStub.body.children[0].click()
    assert.strictEqual(await promise, 'cancel', 'default cancelValue')
    console.log('pass 4/6: mask click cancels; default cancelValue works')
  }

  // 5. Dedup: re-invocation settles the prior one as cancelValue.
  resetDom()
  {
    const first = run({
      message: 'm',
      buttons: [{ label: 'B', value: 'b', primary: true }],
      cancelValue: 'gone',
    })
    const second = run({
      message: 'm',
      buttons: [{ label: 'B', value: 'b', primary: true }],
      cancelValue: 'gone',
    })
    assert.strictEqual(await first, 'gone', 'first settled as cancel')
    const card = documentStub.body.children[0].children[0]
    card.children[card.children.length - 1].children[0].click()
    assert.strictEqual(await second, 'b')
    console.log('pass 5/6: re-invocation dedups prior unresolved dialog')
  }

  // 6. Fallback colors when theme tokens absent.
  resetDom({})
  {
    run({ title: 'x', message: 'm', buttons: [{ label: 'B', value: 'b', primary: true }] })
    const card = documentStub.body.children[0].children[0]
    assert.strictEqual(card.style.background, '#ffffff', 'neutral bg')
    assert.strictEqual(card.children[card.children.length - 1].children[0].style.background, '#3b82f6', 'brand fallback')
    console.log('pass 6/6: neutral fallbacks when theme tokens absent')
  }

  console.log('\nprobe-in-frame-dialog: all assertions passed')
}

main().catch((e) => { console.error(e); process.exit(1) })
