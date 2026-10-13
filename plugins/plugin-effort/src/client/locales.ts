/**
 * Dictionary of the effort slider's client half.
 *
 * zh is the source of truth — {@link EffortKey} is its key union, and the
 * English table is typed with it, so a missing or extra key on either side is a
 * compile error, and the same union constrains the component's `t` seat.
 *
 * The row itself carries NO copy of its own: it is injected directly under the
 * official 推理等级 row, which already names the control, so repeating that label
 * here would print it twice inside one card. Everything below is either an
 * assistive-technology name or an explanation of a state the track cannot show
 * by itself.
 *
 * ## The note's length is a layout constraint
 *
 * The sentences that can appear on the line under the track are shown at 11px in
 * the NARROWEST card the official menu allows (240px, its own `min-width`), which
 * leaves 224px for the line. A sentence past that wraps to a second line and the
 * card grows by 16px — which is the same class of bug the reserved line height
 * exists to prevent, only in the other direction, so `effort.noteUnset` is kept
 * short enough for that width. Measured in the app on 2026-10-13, each sentence set
 * on the real note line at the narrowest card (224px available, 11px/16px):
 * `effort.noteUnset` is 188.7px wide in English and 187px in Chinese, both ONE line
 * — 35px of margin on the English side, which is the tighter of the two and the
 * number to re-check before either sentence gains a word. The `unknown` and error
 * sentences quote a level id or a host message and are allowed to wrap: they are
 * not two shapes of one control, and a card that grows to fit a message is honest.
 *
 * @module @dsh-app/plugin-effort/client/locales
 */

/** Locale namespace owned by this plugin's client half. */
export const NS = 'dsh-app.effort'

/** Simplified Chinese dictionary — the source of truth. */
export const zh = {
  'effort.aria': '推理等级：{name}',
  'effort.ariaUnset': '推理等级：跟随服务默认',
  'effort.hint.keys': '左右方向键可切换档位',
  'effort.noteSingle': '该模型只有一个推理等级。',
  'effort.noteUnset': '当前跟随服务默认，拖动可指定档位。',
  'effort.noteUnknown': '当前档位 {id} 不在该模型的列表中。',
  'effort.error.timeout': '档位切换超时，宿主没有回报结果（显示已回滚）。',
  'effort.error.unavailable': '模型目录不可用，档位没有写入。',
  'effort.error.rejected': '档位写入被拒绝：{detail}',
} as const

/** The key union, taken from the Chinese table. */
export type EffortKey = keyof typeof zh

/** English dictionary, constrained to the same keys. */
export const en: Record<EffortKey, string> = {
  'effort.aria': 'Reasoning effort: {name}',
  'effort.ariaUnset': 'Reasoning effort: following the provider default',
  'effort.hint.keys': 'Left and right arrows change the level',
  'effort.noteSingle': 'This model advertises a single reasoning level.',
  'effort.noteUnset': 'Following the provider default — drag to pin a level.',
  'effort.noteUnknown': 'The level in use ({id}) is not in this model list.',
  'effort.error.timeout': 'The level switch timed out; the host never reported back (display rolled back).',
  'effort.error.unavailable': 'The model catalog is unavailable; the level was not written.',
  'effort.error.rejected': 'The level was rejected: {detail}',
}
