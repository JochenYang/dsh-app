#!/usr/bin/env node
/**
 * Probe for the injected update-card script (src/main/update-card.ts).
 *
 * Executes the REAL production script (from dist/) against a minimal DOM stub
 * and asserts: card creation, message text, determinate progress width,
 * indeterminate (no bar) rendering, tone background, idempotent in-place
 * updates, and auto-hide timer scheduling + cleanup on the next status.
 *
 * Run after `npm run build`:
 *   node scripts/probe-update-card.cjs
 */
const assert = require('node:assert')
const path = require('node:path')

const { UPDATE_CARD_SCRIPT } = require(path.join(__dirname, '..', 'dist', 'main', 'update-card.js'))

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
    textContent: '',
    children: [],
    _removed: false,
    attributes: {},
    setAttribute(k, v) { this.attributes[k] = v; if (k === 'id') register?.(v, this) },
    appendChild(c) { this.children.push(c); if (c.attributes.id) register?.(c.attributes.id, c); return c },
    remove() {
      this._removed = true
      if (this.attributes.id) register?.(this.attributes.id, null)
    },
  }
  // Direct `el.id = ...` assignment (as the production script uses) must hit
  // the same registry as setAttribute('id', ...).
  Object.defineProperty(el, 'id', {
    get() { return this.attributes.id },
    set(v) { this.attributes.id = v; register?.(v, this) },
  })
  // Real-DOM textContent semantics: assigning '' (as the script does to reset
  // the card) removes all child nodes; the card is then re-populated.
  Object.defineProperty(el, 'textContent', {
    get() { return this._text || '' },
    set(v) {
      this._text = v
      if (v === '') this.children = []
    },
  })
  return el
}

/** document.getElementById semantics: id → element (or null after removal). */
const makeRegistry = () => {
  const map = new Map()
  const register = (id, el) => { if (el) map.set(id, el); else map.delete(id) }
  return { register, get: (id) => map.get(id) || null }
}

let reg = makeRegistry()
const documentStub = {
  getElementById(id) { return reg.get(id) },
  createElement(tag) { return makeElement(tag, reg.register) },
  body: null,
  head: null,
}
const windowStub = {}

function resetDom() {
  reg = makeRegistry()
  documentStub.body = makeElement('body', reg.register)
  documentStub.head = makeElement('head', reg.register)
  windowStub.__dshCardTimer = null
}

function run(payload) {
  global.document = documentStub
  global.window = windowStub
  eval(UPDATE_CARD_SCRIPT(payload)) // eslint-disable-line no-eval
}

// ---------------------------------------------------------------- cases
// 1. Determinate progress: card created with spinner icon + message + 45% bar.
resetDom()
run({ message: '正在下载 dsh…', progress: 0.45, tone: 'progress' })
{
  const card = documentStub.body.children[0]
  assert.ok(card, 'card appended to body')
  assert.strictEqual(card.id, 'dsh-update-card')
  assert.strictEqual(card.attributes.role, 'status')
  assert.strictEqual(card.children.length, 2, 'icon + content')
  const icon = card.children[0]
  assert.strictEqual(icon.textContent, '', 'spinner has no glyph')
  assert.ok(icon.style.animation.includes('dshCardSpin'), 'spinner animation')
  const content = card.children[1]
  assert.strictEqual(content.children[0].textContent, '正在下载 dsh…', 'message text')
  assert.strictEqual(content.children.length, 2, 'text + bar')
  const fill = content.children[1].children[0]
  assert.strictEqual(fill.style.width, '45%', 'determinate width')
  assert.strictEqual(windowStub.__dshCardTimer, null, 'no timer without autoHide')
  console.log('pass 1/4: determinate progress card (45%) + spinner icon')
}

// 2. Indeterminate: no progress bar rendered, element reused, message updated.
run({ message: '正在检查内核更新…', progress: null, tone: 'progress' })
{
  assert.strictEqual(documentStub.body.children.length, 1, 'element reused, not duplicated')
  const content = documentStub.body.children[0].children[1]
  assert.strictEqual(content.children.length, 1, 'text only, no bar')
  assert.strictEqual(content.children[0].textContent, '正在检查内核更新…')
  console.log('pass 2/4: indeterminate card, in-place update')
}

// 3. Error tone (✕ icon) + auto-hide schedules a timer; a later status clears it.
run({ message: '更新失败：网络错误', progress: null, tone: 'error', autoHide: 6000 })
assert.ok(windowStub.__dshCardTimer, 'auto-hide timer scheduled')
assert.strictEqual(documentStub.body.children[0].children[0].textContent, '✕', 'error icon')
run({ message: '正在下载 dsh…', progress: 0.1, tone: 'progress' })
assert.strictEqual(windowStub.__dshCardTimer, null, 'timer cleared by next status')
assert.strictEqual(documentStub.body.children[0].children[1].children[0].textContent, '正在下载 dsh…')
console.log('pass 3/4: auto-hide timer + cleanup on next status')

// 4. Progress width clamping (0..1 → 0-100%), ✓ icon and success tone.
run({ message: '已激活 dsh 0.1.1-rc.2', progress: 1, tone: 'success', autoHide: 1500 })
assert.strictEqual(documentStub.body.children[0].children[1].children[1].children[0].style.width, '100%')
assert.ok(windowStub.__dshCardTimer, 'success auto-hide scheduled')
assert.ok(documentStub.body.children[0].style.background === 'rgba(34, 139, 80, 0.90)', 'success bg')
assert.strictEqual(documentStub.body.children[0].children[0].textContent, '✓', 'success icon')
console.log('pass 4/4: clamp + success tone + ✓ icon')

console.log('\nprobe-update-card: all assertions passed')