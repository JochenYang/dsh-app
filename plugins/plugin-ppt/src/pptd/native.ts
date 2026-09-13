/**
 * Lazy native-shape table: the set of preset shape names pptxgenjs can place.
 * Built once on first use so both the checker and the renderer share one
 * definition of "known shape".
 *
 * @module @dsh-app/plugin-ppt/pptd/native
 */

import PptxGenJS from 'pptxgenjs'

let cached: ReadonlySet<string> | undefined

/** Preset shape names accepted by the renderer (pptxgenjs ShapeType values). */
export function nativeShapeNames(): ReadonlySet<string> {
  if (cached === undefined) {
    const instance = new PptxGenJS()
    const table = (instance as unknown as { ShapeType?: Record<string, string> }).ShapeType
    cached = new Set(Object.values(table ?? {}))
  }
  return cached
}
