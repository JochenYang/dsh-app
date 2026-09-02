#!/usr/bin/env node
/**
 * Probe for the injected update-card script (src/main/update-card.ts).
 *
 * Executes the REAL production script (from dist/) against a minimal DOM stub
 * and asserts: card creation, message text, determinate progress width,
 * indeterminate (no bar) rendering, tone background, idempotent in-place
 * updates, auto-hide timer scheduling + cleanup on the next status, and —
 * critically — that same-tone progress updates keep the spinner icon element
 * identity so its CSS animation never restarts mid-download.
 *
 * Run after `npm run build`:
 *   node scripts/probe-update-card.cjs
 */
const assert = require('node:assert')
const path = require('node:path')

const { UPDATE_CARD_SCRIPT, KERNEL_UPDATE_CARD_SCRIPT } = require(path.join(__dirname, '..', 'dist', 'main', 'update-card.js'))

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
    listeners: {},
    setAttribute(k, v) { this.attributes[k] = v; if (k === 'id') register?.(v, this) },
    appendChild(c) { c._parent = this; this.children.push(c); if (c.attributes.id) register?.(c.attributes.id, c); return c },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) },
    click() { for (const fn of this.listeners.click || []) fn({ type: 'click' }) },
    remove() {
      this._removed = true
      if (this.attributes.id) register?.(this.attributes.id, null)
      // Real-DOM detach semantics: remove() must take the node out of its
      // parent's children, not just flag it (the fast-path update relies on
      // removing the progress bar without touching its siblings).
      if (this._parent) {
        const i = this._parent.children.indexOf(this)
        if (i >= 0) this._parent.children.splice(i, 1)
      }
    },
  }
  // Direct `el.id = ...` assignment (as the production script uses) must hit
  // the same registry as setAttribute('id', ...).
  Object.defineProperty(el, 'id', {
    get() { return this.attributes.id },
    set(v) { this.attributes.id = v; register?.(v, this) },
  })
  // Real-DOM parent linkage used by the kernel-update-card cleanup path
  // (root.parentNode.removeChild(root) after the promise settles).
  Object.defineProperty(el, 'parentNode', {
    get() { return this._parent || null },
  })
  el.removeChild = function (child) {
    const i = this.children.indexOf(child)
    if (i >= 0) this.children.splice(i, 1)
    if (child.attributes.id) register?.(child.attributes.id, null)
    child._parent = null
    return child
  }
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
  windowStub.__dshKernelUpdateCard = null
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
  console.log('pass 1/5: determinate progress card (45%) + spinner icon')
}

// 2. Indeterminate: no progress bar rendered, element reused, message updated.
run({ message: '正在检查内核更新…', progress: null, tone: 'progress' })
{
  assert.strictEqual(documentStub.body.children.length, 1, 'element reused, not duplicated')
  const content = documentStub.body.children[0].children[1]
  assert.strictEqual(content.children.length, 1, 'text only, no bar')
  assert.strictEqual(content.children[0].textContent, '正在检查内核更新…')
  console.log('pass 2/5: indeterminate card, in-place update')
}

// 3. Error tone (✕ icon) + auto-hide schedules a timer; a later status clears it.
run({ message: '更新失败：网络错误', progress: null, tone: 'error', autoHide: 6000 })
assert.ok(windowStub.__dshCardTimer, 'auto-hide timer scheduled')
assert.strictEqual(documentStub.body.children[0].children[0].textContent, '✕', 'error icon')
run({ message: '正在下载 dsh…', progress: 0.1, tone: 'progress' })
assert.strictEqual(windowStub.__dshCardTimer, null, 'timer cleared by next status')
assert.strictEqual(documentStub.body.children[0].children[1].children[0].textContent, '正在下载 dsh…')
console.log('pass 3/5: auto-hide timer + cleanup on next status')

// 4. Progress width clamping (0..1 → 0-100%), ✓ icon and success tone.
run({ message: '已激活 dsh 0.1.1-rc.2', progress: 1, tone: 'success', autoHide: 1500 })
assert.strictEqual(documentStub.body.children[0].children[1].children[1].children[0].style.width, '100%')
assert.ok(windowStub.__dshCardTimer, 'success auto-hide scheduled')
assert.ok(documentStub.body.children[0].style.background === 'rgba(34, 139, 80, 0.90)', 'success bg')
assert.strictEqual(documentStub.body.children[0].children[0].textContent, '✓', 'success icon')
console.log('pass 4/5: clamp + success tone + ✓ icon')

// 5. Same-tone progress updates keep the icon element identity (the spinner's
//    CSS animation would restart — visibly stuttering — if it were rebuilt)
//    and update the bar width in place; a removed bar re-adds cleanly.
resetDom()
run({ message: '正在下载 dsh…', progress: 0.1, tone: 'progress' })
{
  const card = documentStub.body.children[0]
  const icon = card.children[0]
  const fill = card.children[1].children[1].children[0]
  run({ message: '正在下载 dsh…', progress: 0.5, tone: 'progress' })
  assert.strictEqual(documentStub.body.children[0], card, 'card element reused')
  assert.strictEqual(card.children[0], icon, 'icon identity kept — animation not restarted')
  assert.strictEqual(card.children[1].children[1].children[0], fill, 'fill element reused')
  assert.strictEqual(fill.style.width, '50%', 'width updated in place')
  run({ message: '正在解压运行时…', progress: null, tone: 'progress' })
  assert.strictEqual(card.children[1].children.length, 1, 'bar removed for indeterminate phase')
  assert.strictEqual(card.children[0], icon, 'icon identity kept across bar removal')
  run({ message: '正在下载 dsh…', progress: 0.3, tone: 'progress' })
  assert.strictEqual(card.children[1].children.length, 2, 'bar re-added for determinate phase')
  assert.strictEqual(card.children[1].children[1].children[0].style.width, '30%', 're-added bar width')
  assert.strictEqual(card.children[0], icon, 'icon identity kept across bar re-add')
  console.log('pass 5/5: same-tone in-place update keeps the spinner spinning')
}

console.log('\nprobe-update-card: all assertions passed')

// --------------------------------------------------------------------------
// 6. KERNEL_UPDATE_CARD_SCRIPT: persistent card with 稍后 / 立即更新 buttons.
const getComputedStyleStub = () => ({ getPropertyValue: () => '' })
global.getComputedStyle = getComputedStyleStub

function runKernelCard(payload) {
  global.document = documentStub
  global.window = windowStub
  return eval(KERNEL_UPDATE_CARD_SCRIPT(payload)) // eslint-disable-line no-eval
}

;(async () => {
  // 6a. Mounts a bottom-right card with both buttons; 立即更新 resolves 'update'
  //     and removes the card + clears the registry key.
  resetDom()
  const pick1 = runKernelCard({ current: '0.1.2-alpha.4', latest: '0.1.2-alpha.5' })
  const card = documentStub.body.children.find((c) => c.id === 'dsh-kernel-update-card')
  assert.ok(card, 'kernel update card appended to body')
  assert.strictEqual(card.attributes.role, 'status')
  const title = card.children[0]
  assert.strictEqual(title.textContent, '发现新版本 dsh 0.1.2-alpha.5', 'card title (latest)')
  const detail = card.children[1]
  assert.strictEqual(detail.textContent, '当前版本 dsh 0.1.2-alpha.4。更新将下载新运行时并重启服务。', 'card detail (current)')
  const actions = card.children[2]
  assert.strictEqual(actions.children.length, 2, 'later + update buttons')
  assert.strictEqual(actions.children[0].textContent, '稍后')
  assert.strictEqual(actions.children[1].textContent, '立即更新')
  assert.ok(actions.children[1].style.background.includes('#3b82f6'), 'primary button uses brand fallback')
  assert.strictEqual(windowStub.__dshKernelUpdateCard && typeof windowStub.__dshKernelUpdateCard.resolve, 'function', 'registry holds resolve')
  actions.children[1].click()
  assert.strictEqual(await pick1, 'update', '立即更新 resolves update')
  assert.strictEqual(windowStub.__dshKernelUpdateCard, null, 'registry cleared after settle')
  assert.strictEqual(card._removed || card._parent === null || !card._parent.children.includes(card), true, 'card detached after settle')
  console.log('pass 6/8: kernel update card mounts, buttons resolve, cleans up')

  // 6b. 稍后 resolves 'later'.
  resetDom()
  const pick2 = runKernelCard({ current: '0.1.2-alpha.4', latest: '0.1.2-alpha.5' })
  const card2 = documentStub.body.children.find((c) => c.id === 'dsh-kernel-update-card')
  card2.children[2].children[0].click()
  assert.strictEqual(await pick2, 'later', '稍后 resolves later')
  console.log('pass 7/8: 稍后 resolves later')

  // 6c. A re-invocation while the first card is pending settles the previous
  //     promise as 'later' (no stale card, no leaked unresolved promise).
  resetDom()
  windowStub.__dshKernelUpdateCard = null
  const pick3 = runKernelCard({ current: '0.1.2-alpha.4', latest: '0.1.2-alpha.5' })
  const pick4 = runKernelCard({ current: '0.1.2-alpha.5', latest: '0.1.2-alpha.6' })
  const cards = documentStub.body.children.filter((c) => c.id === 'dsh-kernel-update-card')
  assert.strictEqual(cards.length, 1, 're-invocation replaces, never stacks')
  assert.strictEqual(await pick3, 'later', 'stale card settles later')
  cards[0].children[2].children[1].click()
  assert.strictEqual(await pick4, 'update', 'fresh card still interactive')
  console.log('pass 8/8: re-invocation settles stale promise as later')

  console.log('\nprobe-update-card: all kernel-update-card assertions passed')
})().catch((err) => {
  console.error(err)
  process.exit(1)
})