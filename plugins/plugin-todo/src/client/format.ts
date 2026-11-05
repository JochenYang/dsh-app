/**
 * Calendar arithmetic for the todo view.
 *
 * Pure functions, no React and no DOM, so the week/month/year grids can be tested
 * without a browser — they are the part of this plugin that is easy to get subtly
 * wrong (a Monday-first week, a month that starts on Sunday, the 53rd column of a
 * year) and hard to notice on screen.
 *
 * Every key is a LOCAL `YYYY-MM-DD`, the same format the store writes, because the
 * user's "yesterday" is their clock's yesterday, not UTC's.
 *
 * @module @dsh-app/plugin-todo/client/format
 */

/** Local `YYYY-MM-DD` for one instant. */
export function keyOf(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Midnight of the day `at` falls on, in local time. */
function startOfDay(at: number): Date {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date
}

/**
 * Midnight of the MONDAY of the week `at` falls on.
 *
 * Monday-first: `getDay()` reports Sunday as 0, which is the one case that has to be
 * mapped to 6 rather than 0 (a Sunday belongs to the week that started six days
 * before it).
 */
export function weekStart(at: number): Date {
  const date = startOfDay(at)
  const offset = (date.getDay() + 6) % 7
  date.setDate(date.getDate() - offset)
  return date
}

/** The seven day keys of the week `at` falls on, Monday first. */
export function weekKeys(at: number): string[] {
  const start = weekStart(at)
  const out: string[] = []
  for (let index = 0; index < 7; index += 1) {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    out.push(keyOf(date.getTime()))
  }
  return out
}

/** One cell of a month grid. */
export interface MonthCell {
  /** The local day key. */
  readonly day: string
  /** The day belongs to the month being drawn; false for the neighbours that fill the grid. */
  readonly outside: boolean
}

/**
 * One month as a Monday-first grid of six rows, EVERY cell holding a real day.
 *
 * The neighbours are drawn rather than left blank: a calendar that starts with an
 * empty square where "the 26th" belongs reads as a hole, and the leading and trailing
 * days of the previous and next month are exactly what a reader uses to count.
 *
 * Six rows always: a 31-day month starting on Sunday needs six, and a fixed height
 * keeps the month view from jumping as the user pages through months.
 *
 * @param at - any instant inside the month to render.
 */
export function monthGrid(at: number): MonthCell[][] {
  const first = new Date(at)
  first.setHours(0, 0, 0, 0)
  first.setDate(1)
  const lead = (first.getDay() + 6) % 7
  const month = first.getMonth()
  const start = new Date(first)
  start.setDate(first.getDate() - lead)
  const cells: MonthCell[] = []
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    cells.push({ day: keyOf(date.getTime()), outside: date.getMonth() !== month })
  }
  const rows: MonthCell[][] = []
  for (let index = 0; index < cells.length; index += 7) rows.push(cells.slice(index, index + 7))
  return rows
}

/**
 * One year as columns of seven days, Monday-first — the GitHub contribution shape.
 *
 * Column 0 starts on the Monday on or before 1 January; the last column ends on the
 * Sunday on or after 31 December, so the year is padded with `null` at both ends
 * rather than shortening its first and last weeks.
 *
 * @param at - any instant inside the year to render.
 */
export function yearGrid(at: number): (string | null)[][] {
  const first = new Date(at)
  first.setHours(0, 0, 0, 0)
  first.setMonth(0, 1)
  const last = new Date(first.getFullYear() + 1, 0, 0)
  const cursor = weekStart(first.getTime())
  const columns: (string | null)[][] = []
  for (;;) {
    const column: (string | null)[] = []
    for (let index = 0; index < 7; index += 1) {
      const date = new Date(cursor)
      date.setDate(cursor.getDate() + index)
      const within = date >= first && date <= last
      column.push(within ? keyOf(date.getTime()) : null)
    }
    columns.push(column)
    const next = new Date(cursor)
    next.setDate(cursor.getDate() + 7)
    if (next > last) break
    cursor.setDate(cursor.getDate() + 7)
  }
  return columns
}

/** Parsed parts of one stored day key, in local terms. */
export interface DayParts {
  /** Calendar year. */
  readonly year: number
  /** Month, 1-12. */
  readonly month: number
  /** Day of month, 1-31. */
  readonly day: number
  /** Monday-first weekday, 0-6 — the same index the weekday dictionary uses. */
  readonly weekday: number
}

/**
 * Split a stored `YYYY-MM-DD` key into the parts a calendar draws.
 *
 * Built through a LOCAL `Date` rather than by slicing the string, because the
 * weekday is the one thing the key does not carry and `Date` is what knows it.
 * Noon keeps a DST shift from moving the day.
 *
 * @param key - a local day key.
 * @returns its parts.
 */
export function partsOf(key: string): DayParts {
  const [year, month, day] = key.split('-').map(Number)
  const date = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1, 12, 0, 0, 0)
  return {
    year: year ?? 1970,
    month: month ?? 1,
    day: day ?? 1,
    weekday: (date.getDay() + 6) % 7,
  }
}

/**
 * The column a year grid carries each month's label in.
 *
 * A column holds seven days, so the column that carries the 1st of a month is
 * where that month's label belongs — placing labels by week index instead would
 * drift for a year that starts mid-week.
 *
 * @param columns - the columns {@link yearGrid} produced.
 * @returns one month number (or null) per column.
 */
export function yearMonthLabels(columns: readonly (string | null)[][]): (number | null)[] {
  return columns.map((column) => {
    for (const day of column) {
      if (day !== null && day.endsWith('-01')) return Number(day.slice(5, 7))
    }
    return null
  })
}

/** `done / total` as a whole percent; 0 when there is nothing to do. */
export function percent(done: number, total: number): number {
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)))
}

/**
 * The colour band for one day's completed count, 0–4.
 *
 * Four steps rather than a continuous scale: the heat map answers "which days did I
 * do something" at a glance, and a gradient that never repeats makes a busy day and
 * a busier one look alike.
 *
 * @param done - tasks completed that day.
 */
export function heatLevel(done: number): 0 | 1 | 2 | 3 | 4 {
  if (done <= 0) return 0
  if (done === 1) return 1
  if (done <= 3) return 2
  if (done <= 5) return 3
  return 4
}

/** `MM-DD` for a tooltip, from a `YYYY-MM-DD` key. */
export function shortDay(key: string): string {
  return key.slice(5)
}

/**
 * Stamp one instant for a reader who may be a day or more late.
 *
 * `HH:MM` alone is what a notice shows while it is on time, and it is exactly what
 * makes a CATCH-UP unreadable: a reminder set for 09:00 on the 4th, noticed at 11:30 on
 * the 5th, would print "09:00" and read as if it had just rung on time. So the day is
 * included as soon as the instant is not TODAY (in the machine's own zone, which is the
 * zone the reminder was set in).
 *
 * @param at - the instant, epoch ms.
 * @param now - the current instant, epoch ms.
 * @returns `HH:MM` for today, `YYYY-MM-DD HH:MM` otherwise.
 */
export function formatStamp(at: number, now: number): string {
  const date = new Date(at)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  const time = `${hh}:${mm}`
  if (keyOf(at) === keyOf(now)) return time
  return `${keyOf(at)} ${time}`
}

/**
 * Render a divider line of box-drawing characters matching the visual width of the content,
 * clamped so it neither falls short in a wide card nor wraps past the bubble's maxWidth.
 */
export function tipDivider(lines: readonly string[]): string {
  let maxUnits = 0
  for (const line of lines) {
    let units = 0
    for (const char of line) {
      // In CJK fonts (e.g. Microsoft YaHei / PingFang SC at 13px), a full-width character is ~13px
      // and an ASCII character is ~7.2px, while `─` is ~9.8px wide.
      units += char.charCodeAt(0) > 255 ? 1.3 : 0.72
    }
    if (units > maxUnits) maxUnits = units
  }
  // Cap at 25 characters (~245px) with comfortable safety margin inside 306px usable width,
  // preventing any fractional-pixel wrap across display scalings.
  const count = Math.min(25, Math.max(18, Math.round(maxUnits * 0.85)))
  return '─'.repeat(count)
}
