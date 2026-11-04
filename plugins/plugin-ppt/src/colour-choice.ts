/**
 * Recording the deck's colours from a conversation.
 *
 * The settings page is not the only place a brand colour comes from: users say it in
 * chat ("ours is #c0392b") and the model needs a way to land that in the session
 * instead of typing it into a page. This is that landing spot — a model-facing tool
 * whose body is a pure function over the mode store, so the behaviour is testable
 * without a kernel.
 *
 * Two refusals are deliberate. A colour recorded with PPT mode OFF is refused rather
 * than silently turning the mode on: the mode is what the workflow reacts to, and a
 * tool that flips it would start a deck nobody asked for. And an unknown colourway id
 * is refused WITH the list of real ones, because "no such colourway" without the
 * alternatives is a dead end for the model.
 *
 * @module @dsh-app/plugin-ppt/colour-choice
 */

import { PALETTE_PRESETS, presetById, resolvePalette, type Palette } from './palette.ts'
import type { PptModeStore } from './mode-store.ts'

/** What the tool reports back: the source it recorded and the colours it resolved to. */
export interface ColourChoice {
  readonly status: 'ok'
  /** Which source now steers the deck. */
  readonly source: 'brand' | 'preset' | 'template'
  /** The six slots the model should write into `theme.colors`, when there are any. */
  readonly colors?: Palette | undefined
  /** Measured, for the claim the answer makes. */
  readonly contrast?: Readonly<Record<string, number>> | undefined
  /** One sentence the model can repeat to the user. */
  readonly note: string
}

/** A refusal: the same shape every other ppt tool uses for a recoverable problem. */
export interface ColourRefusal {
  readonly status: 'needs_revision'
  readonly issues: readonly { readonly severity: 'error', readonly message: string }[]
}

/**
 * Record a colour choice for one session.
 *
 * @param store - the session's mode store.
 * @param sessionId - the session whose deck this is; empty means the call had none.
 * @param args - `brand` (`#RRGGBB`), `palette` (a preset id), or `clear` to drop both.
 * @returns the recorded source, or a refusal naming what to fix.
 */
export function chooseColours(
  store: PptModeStore,
  sessionId: string,
  args: { readonly brand?: unknown, readonly palette?: unknown, readonly clear?: unknown },
): ColourChoice | ColourRefusal {
  const refuse = (message: string): ColourRefusal => ({ status: 'needs_revision', issues: [{ severity: 'error', message }] })

  if (sessionId === '') {
    return refuse('这个会话没有 id，无法记录配色：请让用户在当前会话里直接说颜色，或在模板面板里选。')
  }
  // NOT gated on the mode: a colour is a property of the deck, and users state it
  // before turning the capsule on all the time. Recording it while the switch is off
  // keeps the mode off (it is not a way to start a deck) and the colour is already
  // there when the switch goes on.
  const available = PALETTE_PRESETS.map(preset => preset.id).join('、')
  if (args.clear === true) {
    store.setColours(sessionId, null, null)
    return {
      status: 'ok',
      source: 'template',
      note: '已清除本会话的配色选择，接下来按模板自带的调色板排版。',
    }
  }

  let brand: string | null = null
  if (args.brand !== undefined) {
    if (typeof args.brand !== 'string' || !/^#[0-9a-fA-F]{6}$/u.test(args.brand.trim())) {
      return refuse(`brand 必须是 #RRGGBB 六位十六进制：收到 ${JSON.stringify(args.brand)}`)
    }
    brand = args.brand.trim().toLowerCase()
  }

  let paletteId: string | null = null
  if (args.palette !== undefined) {
    if (typeof args.palette !== 'string' || presetById(args.palette) === undefined) {
      return refuse(`未知配色 id：${JSON.stringify(args.palette)}。可用：${available}`)
    }
    paletteId = args.palette
  }

  if (brand === null && paletteId === null) {
    return refuse(`要么给 brand（#RRGGBB），要么给 palette（${available}），要么 clear: true。`)
  }

  // Colours only: the switch is the user's to flip, and this tool never flips it.
  const modeWasOff = !store.isEnabled(sessionId)
  store.setColours(sessionId, brand, paletteId)
  const resolved = resolvePalette({ brand, palette: paletteId })
  const contrast: Record<string, number> = {}
  if (resolved.source === 'brand' && resolved.report !== undefined) {
    contrast.textOnBackground = resolved.report.textOnBackground
    contrast.accentOnBackground = resolved.report.accentOnBackground
    contrast.secondaryOnBackground = resolved.report.secondaryOnBackground
    contrast.mutedOnBackground = resolved.report.mutedOnBackground
  } else if (resolved.preset !== undefined) {
    contrast.accentOnBackground = resolved.preset.accentOnBackground
  }
  const measured = Object.keys(contrast).length === 0 ? undefined : contrast
  const when = modeWasOff ? 'PPT 模式现在是关闭的，开启后这套配色立即生效。' : ''

  const note = resolved.source === 'brand'
    ? `已记录品牌色 ${brand ?? ''}，换算后正文对比度 ${String(resolved.report?.textOnBackground ?? 0)}:1。下一次组装会把 theme.colors 六行直接给出，原样写进清单即可。${when}`
    : resolved.preset === undefined
      ? `配色已记录。${when}`
      : `已记录配色「${resolved.preset.name}」${resolved.preset.accentOnBackground < 3 ? '，它的 accent 是色块用色，不要拿它压文字' : ''}。下一次组装会把 theme.colors 六行直接给出。${when}`

  return { status: 'ok', source: resolved.source, colors: resolved.palette, contrast: measured, note }
}
