/**
 * DSH APP brand whale background — an event-driven Canvas 2D port of the
 * DeepSeek hero "digitile" whale: the whale silhouette built from ~1300
 * small squares that scatter away from the pointer.
 *
 * Render model (v2 — "static + hover diffusion"): v1 kept a full-viewport
 * canvas repainting every tile at 30 FPS forever, which janked scrolling
 * even on local hardware. v2 inverts the cost model:
 *
 *   - The canvas is a small fixed element sized to the whale bounding box
 *     (plus push margin), not the viewport, so the composited texture is
 *     tiny and scrolling never re-rasterizes it.
 *   - Idle state is a single static frame; NO rAF loop runs at all.
 *   - While the pointer is over the whale, a 30 FPS loop redraws only the
 *     disc around the pointer: restore that region from a cached pristine
 *     frame, then repaint the few hundred tiles inside the disc with the
 *     radial push (displacement only — no highlight ring). Pointer leaves
 *     → decay → restore → the loop stops itself.
 *   - Phase moves (hero ⇄ active) and layout changes run a short (~0.45 s)
 *     full re-render transition on the small canvas, then settle to idle.
 *
 * Layout is phase-aware (the conversation root carries data-phase):
 *   - hero (new session): the whale hovers directly ABOVE the centered
 *     composer card, anchored by measuring the textarea DOM box.
 *   - active (messages exist): the whale drops into the background, larger
 *     and dimmed, behind the transcript.
 *
 * Theming: colors derive from the live `--dsw-alias-*` tokens (ink mixed
 * toward brand). Light themes paint at a higher base alpha with a bluer
 * mix and a brightness floor so the mosaic stays legible on light
 * backgrounds (v1's ink-lean 0.375 alpha washed out to invisibility).
 *
 * `prefers-reduced-motion` only snaps phase/layout transitions (no glide)
 * and drops the CSS fade — the pointer scatter is user-initiated and runs
 * regardless. `window.__dshappWhale` exposes frame counters for probes.
 */

import { WHALE_DATA_B64, WHALE_GRID } from './whale-data.ts'

/** World units: one grid cell pitch (whale spans 10.8 wide × 8.1 tall). */
const CELL = 0.18
/** Whale-local grid center (60 cells → 29.5). */
const GRID_CENTER = (WHALE_GRID - 1) / 2
/** Whale art size in cells (60 × 45: the 24:18 artwork contain-fit). */
const ART_CELLS_X = 60
const ART_CELLS_Y = 45
/** Interaction frame cap. */
const FPS = 30
const FRAME_MS = 1000 / FPS
/** Device-pixel ratio cap; the canvas is small, so full res stays cheap. */
const DPR_CAP = 2
/** Pointer scatter parameters (whale-local units), reference defaults. */
const MOUSE_RADIUS = 2.4
const MOUSE_STRENGTH = 0.8
const MOUSE_DECAY = 0.2
const MOUSE_DISTORT = 5
/**
 * Canvas margin around the art, world units: the radial push displaces a
 * tile by at most force·2 ≈ 1.6 units, plus half a tile and slack.
 */
const TILE_MARGIN_U = 1.8
/** Shading light (whale-local units); fixed in the static frame. */
const LIGHT = { x: 4.5, y: 5.5, z: 3, range: 14, shadeMin: 0.2, shadeMax: 1.116 } as const
/** Center-glow color mixed into lit tiles on dark themes. */
const GLOW_ADD = [51, 77, 128] as const
/** Tile face size in world units (reference BoxGeometry 0.06). */
const TILE_SIZE = 0.06
/** Whale dims to this alpha share while a conversation is active. */
const ACTIVE_PHASE_ALPHA = 0.3
/** Hero anchoring: gap between the composer card top and the whale bottom. */
const HERO_GAP_PX = 40
/** Hero anchoring: keep this much clearance below the app header. */
const HERO_TOP_SAFE_PX = 64
/** Phase/layout poll cadence (ms); both are cheap reads. */
const POLL_MS = 250
/** Phase-move transition duration (seconds), cubic-out ease. */
const TRANSITION_S = 0.45
/** Placement drift below this (px-equivalent) is ignored by the poll. */
const PLACE_EPS_PX = 1.5
/** Frozen animation time for the static frame's shimmer variation. */
const T_STATIC = 10
/** vLight shade buckets × glow buckets for the cached fillStyle palette. */
const V_BUCKETS = 33
const G_BUCKETS = 5

/** One decoded whale tile (static geometry + fixed random face scale). */
interface Tile {
  /** Rest position, whale-local world units (y up). */
  wx: number
  wy: number
  /** Coverage opacity 0..1 (sampled luminance). */
  lum: number
  /** Fixed random face scale (reference: 0.5–1.5). */
  scale: number
  /** Scan index — drives per-tile noise phases. */
  i: number
}

interface Rgb {
  r: number
  g: number
  b: number
}

/** clamp(x, lo, hi) */
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
/** smoothstep with edge0 < edge1, clamped. */
function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1)
  return t * t * (3 - 2 * t)
}

/** Parse any `rgb()` / `rgba()` / `#hex` color the token layer may emit. */
function parseColor(value: string): Rgb | null {
  const v = value.trim()
  const m = /rgba?\(([^)]+)\)/.exec(v)
  if (m !== null) {
    const p = m[1].split(',').map((s) => parseFloat(s))
    if (p.length >= 3) return { r: p[0], g: p[1], b: p[2] }
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v)
  if (hex !== null) {
    let h = hex[1]
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
  }
  return null
}

const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => ({
  r: lerp(a.r, b.r, t),
  g: lerp(a.g, b.g, t),
  b: lerp(a.b, b.b, t),
})
const luminance = (c: Rgb): number => (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255
const cssRgb = (c: Rgb): string =>
  `rgb(${Math.round(clamp(c.r, 0, 255))},${Math.round(clamp(c.g, 0, 255))},${Math.round(clamp(c.b, 0, 255))})`

/** Read a `--dsw-alias-*` token from the body's computed style. */
function readToken(name: string): string {
  const v = getComputedStyle(document.body).getPropertyValue(name)
  return v === '' ? '' : v
}

interface ThemePalette {
  dark: boolean
  /** Base tile color: ink mixed toward brand. */
  base: Rgb
  /** Brand color (light-theme glow tint). */
  brand: Rgb
  /** Assembled base alpha (before glow/shimmer/light). */
  baseAlpha: number
  /** Light-theme brightness floor applied to the vLight alpha term. */
  lightShadeFloor: number
  /** fillStyle cache: [vLight bucket][glow bucket]. */
  fills: string[][]
}

/** Resolve the current theme into paint parameters from the live tokens. */
function readTheme(): ThemePalette {
  const bg = parseColor(readToken('--dsw-alias-bg-base')) ?? { r: 255, g: 255, b: 255 }
  const ink = parseColor(readToken('--dsw-alias-label-primary')) ?? (luminance(bg) < 0.5 ? { r: 230, g: 235, b: 245 } : { r: 15, g: 23, b: 42 })
  const brand = parseColor(readToken('--dsw-alias-brand-primary')) ?? { r: 59, g: 130, b: 246 }
  const dark = luminance(bg) < 0.5
  // Light themes mix harder toward the brand and paint at a much higher
  // alpha than v1: the old ink-lean 0.375 mix was near-invisible on white.
  const base = mixRgb(ink, brand, dark ? 0.3 : 0.5)
  // Dark themes keep the whale a LOW-contrast texture: the upstream dark
  // palette is near-black (bg rgb(21,21,23)) with a slightly lighter
  // sidebar (rgb(27,27,28)) — a bright tile wall there clashes hard with
  // the quiet sidebar. 0.45 reads as a subtle inked watermark instead.
  const baseAlpha = dark ? 0.45 : 0.66
  const lightShadeFloor = 0.55

  // Precompute the per-(vLight, glow) fill colors: tiles only ever paint one
  // of these cached strings, so render paths never build color strings.
  const fills: string[][] = []
  for (let v = 0; v < V_BUCKETS; v++) {
    const vLight = LIGHT.shadeMin + ((LIGHT.shadeMax - LIGHT.shadeMin) * v) / (V_BUCKETS - 1)
    const row: string[] = []
    for (let g = 0; g < G_BUCKETS; g++) {
      const glow = (g / (G_BUCKETS - 1)) * 0.3
      let c: Rgb
      if (dark) {
        c = { r: base.r * vLight, g: base.g * vLight, b: base.b * vLight }
        if (vLight > 1) {
          // Slight warm shift on the lit side (reference fragment shader).
          const w = clamp(vLight - 1, 0, 1)
          c = { r: c.r * (1 + 0.07 * w), g: c.g * (1 + 0.02 * w), b: c.b * (1 - 0.06 * w) }
        }
        c = { r: c.r + glow * GLOW_ADD[0], g: c.g + glow * GLOW_ADD[1], b: c.b + glow * GLOW_ADD[2] }
      } else {
        // Compressed shade range: never sink too dark on a light background.
        const k = 0.7 + 0.3 * vLight
        c = { r: base.r * k, g: base.g * k, b: base.b * k }
        if (glow > 0) c = mixRgb(c, brand, (glow / 0.3) * 0.35)
      }
      row.push(cssRgb(c))
    }
    fills.push(row)
  }
  return { dark, base, brand, baseAlpha, lightShadeFloor, fills }
}

/** Decode the packed whale grid into per-tile records. */
function decodeTiles(): Tile[] {
  const bin = atob(WHALE_DATA_B64)
  const bitmapBytes = Math.ceil((WHALE_GRID * WHALE_GRID) / 8)
  const tiles: Tile[] = []
  let attr = bitmapBytes
  for (let row = 0; row < WHALE_GRID; row++) {
    for (let col = 0; col < WHALE_GRID; col++) {
      const bit = row * WHALE_GRID + col
      if (((bin.charCodeAt(bit >> 3) >> (bit & 7)) & 1) === 0) continue
      const a = bin.charCodeAt(attr++)
      tiles.push({
        wx: (col - GRID_CENTER) * CELL,
        wy: (GRID_CENTER - row) * CELL,
        lum: (a >> 4) / 15,
        scale: 0.5 + Math.random(),
        i: tiles.length,
      })
    }
  }
  return tiles
}

/** Smooth whale placement: screen-space center, art height in px, and the
 * phase alpha share (1 on hero, dimmed while chatting). */
interface LayoutState {
  cx: number
  cy: number
  /** Rendered art height (45 cells) in CSS px. */
  h: number
  alpha: number
}

/** Fixed-position canvas + the CSS overrides that let it read as the app
 * background: the frame and the conversation root stop painting their own
 * base fill (the body already paints `--dsw-alias-bg-base`), so the whale
 * layer sits between the base color and the app content. */
const WHALE_CSS = `
#dshapp-whale-bg {
  position: fixed;
  left: 0;
  top: 0;
  z-index: -1;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.6s ease;
  will-change: transform;
}
#dshapp-whale-bg.is-visible { opacity: 1; }
@media (prefers-reduced-motion: reduce) {
  #dshapp-whale-bg { transition: none; }
}
body [class*="_frame"] { background: transparent; }
body [class*="_centerCol"] [data-phase='hero'],
body [class*="_centerCol"] [data-phase='active'],
body [class*="_centerCol"] [data-phase='settling'] { background: transparent; }
`

/** Dirty-region bookkeeping for the interaction redraw. */
interface Box {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Mount the whale background. Returns a disposer that removes the canvas,
 * its stylesheet, and every listener/observer.
 */
export function mountWhaleBackground(): () => void {
  if (typeof document === 'undefined') return () => undefined

  const style = document.createElement('style')
  style.id = 'dshapp-whale-style'
  style.textContent = WHALE_CSS
  document.head.append(style)

  const canvas = document.createElement('canvas')
  canvas.id = 'dshapp-whale-bg'
  canvas.setAttribute('aria-hidden', 'true')
  document.body.prepend(canvas)
  const maybeCtx = canvas.getContext('2d')
  if (maybeCtx === null) {
    style.remove()
    canvas.remove()
    return () => undefined
  }
  // Non-null alias: TS null-narrowing does not cross closure boundaries, and
  // every render helper below closes over the context.
  const ctx: CanvasRenderingContext2D = maybeCtx

  // Pristine static frame: interaction frames restore their dirty region
  // from this offscreen copy, so the visible canvas never accumulates drift.
  const base = document.createElement('canvas')
  const maybeBaseCtx = base.getContext('2d')
  if (maybeBaseCtx === null) {
    style.remove()
    canvas.remove()
    return () => undefined
  }
  const bctx: CanvasRenderingContext2D = maybeBaseCtx

  const tiles = decodeTiles()
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

  // Per-tile render cache, filled by renderFrame and reused by the
  // interaction redraw so boosted tiles stay continuous with the base frame.
  const n = tiles.length
  const bx = new Float32Array(n)
  const by = new Float32Array(n)
  const bs = new Float32Array(n)
  const ba = new Float32Array(n)
  const vBi = new Uint8Array(n)
  const gBi = new Uint8Array(n)

  // Probe diagnostics (scripts/probe-whale.cjs): frame counter + live flags.
  const debug = { frames: 0, interacting: false, running: false }
  ;(window as { __dshappWhale?: typeof debug }).__dshappWhale = debug

  // ---- layout -------------------------------------------------------------
  let vw = 0
  let vh = 0
  let dpr = 1
  /** Canvas CSS size — fixed per resize for the largest (active) phase. */
  let W = 0
  let H = 0

  function resizeCanvas(): void {
    vw = window.innerWidth
    vh = window.innerHeight
    dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP)
    const esMax = activeLayout().h / (ART_CELLS_Y * CELL)
    W = Math.ceil((ART_CELLS_X * CELL + 2 * TILE_MARGIN_U) * esMax)
    H = Math.ceil((ART_CELLS_Y * CELL + 2 * TILE_MARGIN_U) * esMax)
    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(H * dpr)
    base.width = canvas.width
    base.height = canvas.height
    canvas.style.width = `${W}px`
    canvas.style.height = `${H}px`
  }

  /** Hero placement: hover above the composer card, following its DOM box. */
  function heroLayout(): LayoutState {
    // The composer input is the only main-column element carrying the input
    // class; its class is a CSS-module hash (`InputBar_input__…`) so match on
    // the stable local part. It renders as a DIV in current kernels (older
    // ones used a textarea), so accept either once the class matches.
    const seat = document.querySelector('[class*="_input"]')
    const rect = seat instanceof HTMLElement ? seat.getBoundingClientRect() : null
    if (rect === null || rect.width === 0) {
      // DOM not ready yet: assume the centered composer sits slightly above
      // the vertical middle (its stack has a 32px bottom pad).
      const h = Math.min(vh * 0.3, vw * 0.26)
      return { cx: vw / 2, cy: vh * 0.36 - h / 2, h, alpha: 1 }
    }
    const avail = rect.top - HERO_GAP_PX - HERO_TOP_SAFE_PX
    const h = clamp(avail, 96, Math.min(vh * 0.34, vw * 0.26))
    const cx = rect.left + rect.width / 2
    const cy = rect.top - HERO_GAP_PX - h / 2
    return { cx, cy, h, alpha: 1 }
  }

  /**
   * Active placement: large, behind the transcript. The center column sits
   * right of the sidebar, so centering on the viewport leaves the whale
   * visibly offset from the conversation it backgrounds — anchor on the
   * conversation column's own box instead (the composer textarea shares
   * that column, so the hero path is already column-aligned implicitly).
   */
  function activeLayout(): LayoutState {
    const h = Math.min(vh * 0.46, vw * 0.4)
    let cx = vw / 2
    // Same hashed-CSS-module caveat as heroLayout: match the stable local
    // part of the center column class (`AppFrame_centerCol__…`).
    const col = document.querySelector('[class*="_centerCol"]')
    if (col instanceof HTMLElement) {
      const rect = col.getBoundingClientRect()
      if (rect.width > 0) cx = rect.left + rect.width / 2
    }
    return { cx, cy: vh * 0.42, h, alpha: ACTIVE_PHASE_ALPHA }
  }

  // ---- theme / phase state ------------------------------------------------
  let theme = readTheme()
  /** Current smoothed placement. */
  let place: LayoutState = { cx: 0, cy: 0, h: 100, alpha: 1 }
  /** Transition origin/target; tT = 1 means settled. */
  let from: LayoutState | null = null
  let to: LayoutState | null = null
  let tT = 1
  /** First poll snaps instead of transitioning (the CSS fade covers entry). */
  let booted = false

  function applyPlacement(): void {
    canvas.style.transform = `translate(${place.cx - W / 2}px, ${place.cy - H / 2}px)`
  }

  function beginTransition(target: LayoutState): void {
    if (reducedMotion.matches || !booted) {
      booted = true
      place = { ...target }
      applyPlacement()
      renderFrame()
      return
    }
    const drift =
      Math.abs(target.cx - place.cx) +
      Math.abs(target.cy - place.cy) +
      Math.abs(target.h - place.h) +
      Math.abs(target.alpha - place.alpha) * 100
    if (drift < PLACE_EPS_PX) return
    from = { ...place }
    to = { ...target }
    tT = 0
    start()
  }

  function advanceTransition(dt: number): boolean {
    if (tT >= 1 || from === null || to === null) return false
    tT = Math.min(1, tT + dt / TRANSITION_S)
    const e = 1 - Math.pow(1 - tT, 3)
    place = {
      cx: lerp(from.cx, to.cx, e),
      cy: lerp(from.cy, to.cy, e),
      h: lerp(from.h, to.h, e),
      alpha: lerp(from.alpha, to.alpha, e),
    }
    applyPlacement()
    renderFrame()
    if (tT >= 1) {
      from = null
      to = null
    }
    return true
  }

  function pollState(): void {
    const next = readTheme()
    if (next.dark !== theme.dark || cssRgb(next.base) !== cssRgb(theme.base) || cssRgb(next.brand) !== cssRgb(theme.brand)) {
      theme = next
      renderFrame()
    }
    // The conversation root carries data-phase (hero | active | settling).
    // Filter by those exact values: the input textarea and settings tabs
    // also carry a data-phase, but from unrelated state machines. No match
    // (pre-mount or foreign phase) reads as the welcome state.
    const phase = document.querySelector("[data-phase='hero'], [data-phase='active'], [data-phase='settling']")
    const value = phase === null ? null : phase.getAttribute('data-phase')
    beginTransition(value === 'active' ? activeLayout() : heroLayout())
  }

  // ---- pointer ------------------------------------------------------------
  const mouse = { x: 0, y: 0, sx: 0, sy: 0, strength: 0, active: false, everMoved: false }

  /** Pointer proximity test against the placed canvas box (plus a pad). */
  function pointerInsideCanvas(x: number, y: number): boolean {
    const pad = 24
    return (
      x >= place.cx - W / 2 - pad &&
      x <= place.cx + W / 2 + pad &&
      y >= place.cy - H / 2 - pad &&
      y <= place.cy + H / 2 + pad
    )
  }

  function onPointerMove(event: MouseEvent): void {
    mouse.x = event.clientX
    mouse.y = event.clientY
    mouse.active = pointerInsideCanvas(mouse.x, mouse.y)
    // Pointer scatter is user-initiated, so it runs even under
    // prefers-reduced-motion (that flag only snaps layout transitions).
    if (mouse.active) start()
  }
  function onPointerLeave(): void {
    mouse.active = false
  }
  function onVisibility(): void {
    if (document.hidden) {
      mouse.active = false
      stop()
    }
  }
  window.addEventListener('mousemove', onPointerMove, { passive: true })
  window.addEventListener('mouseleave', onPointerLeave)
  document.addEventListener('visibilitychange', onVisibility)

  /** Smooth the pointer toward its target and ease the push strength.
   * Returns true while the pointer effect is live. */
  function advancePointer(dt: number): boolean {
    const es = place.h / (ART_CELLS_Y * CELL)
    const lx = (mouse.x - place.cx) / es
    const ly = (place.cy - mouse.y) / es
    if (!mouse.everMoved) {
      mouse.sx = lx
      mouse.sy = ly
      mouse.everMoved = true
    } else {
      mouse.sx += (lx - mouse.sx) * MOUSE_DECAY
      mouse.sy += (ly - mouse.sy) * MOUSE_DECAY
    }
    const target = mouse.active ? MOUSE_STRENGTH : 0
    mouse.strength += (target - mouse.strength) * (1 - Math.pow(0.05, dt))
    return mouse.strength > 0.005
  }

  // ---- animation ----------------------------------------------------------
  let raf = 0
  let lastMs = 0
  let running = false
  let prevDirty: Box | null = null

  function start(): void {
    if (running) return
    running = true
    debug.running = true
    lastMs = performance.now() - FRAME_MS
    raf = requestAnimationFrame(loop)
  }

  function stop(): void {
    if (!running) return
    running = false
    debug.running = false
    cancelAnimationFrame(raf)
  }

  function loop(now: number): void {
    raf = requestAnimationFrame(loop)
    if (now - lastMs < FRAME_MS - 1) return
    const dt = Math.min(0.1, (now - lastMs) / 1000 || FRAME_MS / 1000)
    lastMs = now
    debug.frames++
    if (advanceTransition(dt)) {
      // Full re-render path (small canvas); pointer effects resume after.
      debug.interacting = false
    } else {
      const live = advancePointer(dt)
      if (live) renderInteractive(now / 1000)
      else if (debug.interacting) restoreFull()
      debug.interacting = live
    }
    // Settled: no transition, pointer gone, push fully decayed → park.
    if (tT >= 1 && !mouse.active && !debug.interacting) stop()
  }

  /** Blit the pristine frame back over the whole visible canvas. */
  function restoreFull(): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(base, 0, 0)
    prevDirty = null
  }

  /**
   * Full static render into the pristine frame + blit to the visible
   * canvas. Also refreshes the per-tile cache the interaction path reads.
   */
  function renderFrame(): void {
    const es = place.h / (ART_CELLS_Y * CELL)
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    bctx.clearRect(0, 0, W, H)
    for (let idx = 0; idx < tiles.length; idx++) {
      const t = tiles[idx]
      const px = W / 2 + t.wx * es
      const py = H / 2 - t.wy * es
      // Shading: fixed light + center glow + frozen shimmer.
      const ldx = t.wx - LIGHT.x
      const ldy = t.wy - LIGHT.y
      const lit = clamp(1 - Math.sqrt(ldx * ldx + ldy * ldy + LIGHT.z * LIGHT.z) / LIGHT.range, 0, 1)
      const vLight = LIGHT.shadeMin + (LIGHT.shadeMax - LIGHT.shadeMin) * lit * lit
      const glow = (1 - smoothstep(0, 8, Math.sqrt(t.wx * t.wx + t.wy * t.wy))) * 0.3
      const shimmer = Math.sin(T_STATIC * 1.5 + t.wx * 5 + t.wy * 3) * 0.1 + 0.9
      const shade = theme.dark ? Math.min(vLight, 1) : theme.lightShadeFloor + (1 - theme.lightShadeFloor) * Math.min(vLight, 1)
      const alpha = clamp(t.lum * (theme.baseAlpha + glow) * shimmer * shade * place.alpha, 0, 1)
      if (alpha < 0.004) {
        ba[idx] = 0
        continue
      }
      const vBucket = Math.round(((vLight - LIGHT.shadeMin) / (LIGHT.shadeMax - LIGHT.shadeMin)) * (V_BUCKETS - 1))
      const gBucket = Math.round((glow / 0.3) * (G_BUCKETS - 1))
      // Integer-pixel geometry (x0/y0 = top-left, s = size): both the
      // static frame and the interactive frame draw from these exact
      // values, so a resting tile and a displaced-back tile are pixel
      // identical — no AA softness delta that reads as a glow.
      const s = Math.max(1, Math.round(TILE_SIZE * t.scale * es))
      const x0 = Math.round(px - s / 2)
      const y0 = Math.round(py - s / 2)
      bx[idx] = x0
      by[idx] = y0
      bs[idx] = s
      ba[idx] = alpha
      vBi[idx] = vBucket
      gBi[idx] = gBucket
      bctx.globalAlpha = alpha
      bctx.fillStyle = theme.fills[vBucket][gBucket]
      bctx.fillRect(x0, y0, s, s)
    }
    bctx.globalAlpha = 1
    restoreFull()
  }

  /**
   * Interaction frame: restore the disc region around the pointer from the
   * pristine frame, then repaint only the tiles inside the disc with the
   * radial push (same colors/alpha as the static frame). Everything outside
   * the disc keeps the cached static pixels — zero full-canvas work.
   */
  function renderInteractive(nowS: number): void {
    const es = place.h / (ART_CELLS_Y * CELL)
    const half = (MOUSE_RADIUS + TILE_MARGIN_U + 0.4) * es + 6
    const box: Box = {
      x: W / 2 + mouse.sx * es - half,
      y: H / 2 - mouse.sy * es - half,
      w: half * 2,
      h: half * 2,
    }
    // Dirty region = union(last disc, current disc), clamped to the canvas.
    let ux0 = box.x
    let uy0 = box.y
    let ux1 = box.x + box.w
    let uy1 = box.y + box.h
    if (prevDirty !== null) {
      ux0 = Math.min(ux0, prevDirty.x)
      uy0 = Math.min(uy0, prevDirty.y)
      ux1 = Math.max(ux1, prevDirty.x + prevDirty.w)
      uy1 = Math.max(uy1, prevDirty.y + prevDirty.h)
    }
    const dx0 = Math.max(0, Math.floor(ux0 * dpr))
    const dy0 = Math.max(0, Math.floor(uy0 * dpr))
    const dx1 = Math.min(canvas.width, Math.ceil(ux1 * dpr))
    const dy1 = Math.min(canvas.height, Math.ceil(uy1 * dpr))
    if (dx1 > dx0 && dy1 > dy0) {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(dx0, dy0, dx1 - dx0, dy1 - dy0)
      ctx.drawImage(base, dx0, dy0, dx1 - dx0, dy1 - dy0, dx0, dy0, dx1 - dx0, dy1 - dy0)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const r2 = MOUSE_RADIUS * MOUSE_RADIUS
      for (let idx = 0; idx < tiles.length; idx++) {
        if (ba[idx] === 0) continue
        const t = tiles[idx]
        const dx = t.wx - mouse.sx
        const dy = t.wy - mouse.sy
        const d2 = dx * dx + dy * dy
        if (d2 >= r2) continue
        const md = Math.sqrt(d2) || 1e-4
        const k = 1 - md / MOUSE_RADIUS
        const force = k * k * k * mouse.strength
        if (force < 0.002) continue
        // Radial push with a per-tile noise angle. The travel distance is
        // scaled by a per-tile hash (0.35–1.0): with a shared distance every
        // tile at one radius lands on the same shell, piling up into a dense
        // "ring" around the pointer; the hash spreads landings into a smooth
        // density falloff instead.
        const na = Math.sin(t.i * 0.37 + nowS * 0.5) * MOUSE_DISTORT
        const ca = Math.cos(na)
        const sa = Math.sin(na)
        const rx = dx / md
        const ry = dy / md
        const hash = (Math.sin(t.i * 12.9898) * 43758.5453) % 1
        const push = force * 1.2 * (0.35 + 0.65 * Math.abs(hash))
        // Integer displacement from the static-frame top-left: identical
        // geometry and paint to the resting tile, only the position moves.
        const dxp = Math.round((rx * ca - ry * sa) * push * es)
        const dyp = Math.round((rx * sa + ry * ca) * push * es)
        // Pure displacement, constant size, exact static-frame paint. The
        // base-frame restore above brings EVERY static tile back inside the
        // dirty rect — including the ones about to move — so each moving
        // tile must first clear its resting slot, otherwise the resting
        // and displaced copies co-exist as a double image (read as a glow
        // disc). Tiles never overlap (grid pitch >> tile size), so the
        // slot clear never clips a neighbor.
        ctx.clearRect(bx[idx], by[idx], bs[idx], bs[idx])
        ctx.globalAlpha = ba[idx]
        ctx.fillStyle = theme.fills[vBi[idx]][gBi[idx]]
        ctx.fillRect(bx[idx] + dxp, by[idx] + dyp, bs[idx], bs[idx])
      }
      ctx.globalAlpha = 1
    }
    prevDirty = box
  }

  function onResize(): void {
    resizeCanvas()
    // canvas.width reset cleared the bitmap — always repaint immediately;
    // pollState then transitions to the re-measured anchor if it moved.
    applyPlacement()
    renderFrame()
    pollState()
  }
  window.addEventListener('resize', onResize)

  // ---- mount --------------------------------------------------------------
  resizeCanvas()
  place = heroLayout()
  pollState()
  // Reveal after the first paint so the CSS opacity fade actually runs
  // (double rAF beats the "class added in the insertion frame" skip).
  requestAnimationFrame(() => requestAnimationFrame(() => canvas.classList.add('is-visible')))

  const poll = setInterval(pollState, POLL_MS)
  const onMotionChange = (): void => {
    stop()
    pollState()
  }
  reducedMotion.addEventListener('change', onMotionChange)

  return () => {
    stop()
    clearInterval(poll)
    window.removeEventListener('mousemove', onPointerMove)
    window.removeEventListener('mouseleave', onPointerLeave)
    window.removeEventListener('resize', onResize)
    document.removeEventListener('visibilitychange', onVisibility)
    reducedMotion.removeEventListener('change', onMotionChange)
    delete (window as { __dshappWhale?: typeof debug }).__dshappWhale
    style.remove()
    canvas.remove()
  }
}
