/**
 * Dictionary of the todo board, in this plugin's own locale namespace.
 *
 * The namespace is declared by the client entry (`src/client.ts`, the
 * `declare module` merge into `LocaleNamespaceMap`); this module owns the keys.
 * zh is the source of truth and {@link TodoKey} is its key union, so a missing or
 * extra key on either side is a compile error.
 *
 * Two rules the copy follows:
 *
 * - A date is built from parts, never from a formatted string: the weekday comes
 *   from the interface's own week order (Monday first), so `todo.weekday.*` carries
 *   the name and `todo.date.*` the numeric shape.
 * - A day the store only counts says so instead of rendering an empty list. "No
 *   detail" and "nothing happened" are different facts, and only one is worth
 *   trusting.
 *
 * @module @dsh-app/plugin-todo/client/locales
 */

/** Locale namespace owned by this plugin's client half. */
export const NS = 'dsh-app.todo'

/** Simplified Chinese dictionary — the source of truth for this plugin. */
export const zh = {
  'todo.card.title': '待办',
  'todo.card.open': '{count} 项未完成',
  'todo.card.emptyTitle': '今天还没有待办',
  'todo.card.emptyHint': '点开写下第一条',
  'todo.card.allDone': '今天的都做完了',
  'todo.card.overdue': '{count} 项之前未完成',
  'todo.card.loading': '读取中',
  'todo.card.failed': '读取失败',

  'todo.view.title': '待办',
  'todo.view.date': '{date} · {weekday}',
  'todo.view.today': '今天',
  'todo.view.progress': '今天完成 {done} / {total}',
  'todo.view.addPlaceholder': '添加一项待办，回车提交',
  'todo.view.addLabel': '添加',
  'todo.view.empty': '今天还没有待办。写一条，按回车即可。',
  'todo.view.openHeading': '未完成 · {count}',
  'todo.view.doneHeading': '已完成 · {count}',
  'todo.view.remove': '删除',
  'todo.view.earlier': '之前',
  'todo.view.retry': '重试',
  'todo.view.close': '关闭',

  'todo.error.load': '读不到待办：{detail}',
  'todo.error.save': '保存失败：{detail}',

  'todo.date.ymd': '{year}年{month}月{day}日',
  'todo.date.md': '{month}月{day}日',

  'todo.stats.title': '统计',
  'todo.stats.week': '本周',
  'todo.stats.month': '本月',
  'todo.stats.year': '今年',
  'todo.stats.tabs': '统计范围',
  'todo.stats.summary': '{done} 完成 · {created} 新增',
  'todo.stats.legendLess': '少',
  'todo.stats.legendMore': '多',
  'todo.stats.monthLabel': '{year} 年 {month} 月',
  'todo.stats.yearLabel': '{year} 年全年完成情况',
  'todo.stats.metricDone': '全年完成',
  'todo.stats.metricActive': '完成天数',
  'todo.stats.metricStreak': '最长连续',
  'todo.stats.days': '{count} 天',
  'todo.stats.items': '{count} 项',

  'todo.day.summary': '完成 {done} · 新增 {created}',
  'todo.day.empty': '这天没有待办',
  'todo.day.emptyHint': '这天还没有待办，写一条吧',
  'todo.day.addPlaceholder': '为 {date} 添加一项待办',
  'todo.day.counts': '明细已不在列表中，只保留统计',
  'todo.day.countsChip': '只剩统计 · 完成 {done}',
  'todo.day.doneCount': '{done} 完成',
  'todo.day.more': '还有 {count} 项',
  'todo.day.expandMore': '展开更多 (还有 {count} 项)',
  'todo.day.collapse': '收起',
  'todo.day.unlisted': '另有 {count} 项已完成不在明细中',
  'todo.day.open': '未完成',
  'todo.day.done': '已完成',

  'todo.reminder.presetThirty': '30 分钟后',
  'todo.reminder.presetAfternoon': '下午 {time}',
  'todo.reminder.presetTonight': '今晚 {time}',
  'todo.reminder.presetTomorrow': '明天 {time}',
  'todo.reminder.tooltipValue': '提醒时间 {time}，点击修改或清除',
  'todo.reminder.tooltipEmpty': '设置提醒时间',
  'todo.reminder.quick': '快捷时间',
  'todo.reminder.clear': '清除',
  'todo.reminder.custom': '指定时刻',
  'todo.reminder.wheelToggle': '下拉选择时分',
  'todo.reminder.placeholder': '如 15:30',
  'todo.reminder.apply': '设定',
  'todo.reminder.wheelLabel': '时分选择',
  'todo.reminder.wheelTitle': '选择具体时分',
  'todo.reminder.wheelHintBoth': '请依次选择时、分',
  'todo.reminder.wheelHintHour': '请选择小时',
  'todo.reminder.wheelHintMinute': '请选择分钟',
  'todo.reminder.wheelHintDone': '已选定',
  'todo.reminder.hour': '时',
  'todo.reminder.minute': '分',
  'todo.reminder.toastTitle': '待办提醒',
  'todo.reminder.markDone': '标记完成',
  'todo.reminder.snooze': '推迟 10 分钟',
  'todo.reminder.rowTooltip': '提醒 {time}',

  'todo.weekdayLong.mon': '星期一',
  'todo.weekdayLong.tue': '星期二',
  'todo.weekdayLong.wed': '星期三',
  'todo.weekdayLong.thu': '星期四',
  'todo.weekdayLong.fri': '星期五',
  'todo.weekdayLong.sat': '星期六',
  'todo.weekdayLong.sun': '星期日',
  'todo.weekdayCard.mon': '周一',
  'todo.weekdayCard.tue': '周二',
  'todo.weekdayCard.wed': '周三',
  'todo.weekdayCard.thu': '周四',
  'todo.weekdayCard.fri': '周五',
  'todo.weekdayCard.sat': '周六',
  'todo.weekdayCard.sun': '周日',

  'todo.weekday.mon': '一',
  'todo.weekday.tue': '二',
  'todo.weekday.wed': '三',
  'todo.weekday.thu': '四',
  'todo.weekday.fri': '五',
  'todo.weekday.sat': '六',
  'todo.weekday.sun': '日',
} as const

/** The key union both dictionaries are checked against. */
export type TodoKey = keyof typeof zh

/** English dictionary, typed by the Chinese one. */
export const en: Record<TodoKey, string> = {
  'todo.card.title': 'To do',
  'todo.card.open': '{count} open',
  'todo.card.emptyTitle': 'Nothing planned today',
  'todo.card.emptyHint': 'Open it to add the first one',
  'todo.card.allDone': 'All done for today',
  'todo.card.overdue': '{count} from earlier still open',
  'todo.card.loading': 'Loading',
  'todo.card.failed': 'Could not load',

  'todo.view.title': 'To do',
  'todo.view.date': '{date} · {weekday}',
  'todo.view.today': 'Today',
  'todo.view.progress': '{done} of {total} done today',
  'todo.view.addPlaceholder': 'Add a task, Enter to save',
  'todo.view.addLabel': 'Add',
  'todo.view.empty': 'Nothing yet today. Write one and press Enter.',
  'todo.view.openHeading': 'Open · {count}',
  'todo.view.doneHeading': 'Done · {count}',
  'todo.view.remove': 'Remove',
  'todo.view.earlier': 'earlier',
  'todo.view.retry': 'Retry',
  'todo.view.close': 'Close',

  'todo.error.load': 'Could not read the tasks: {detail}',
  'todo.error.save': 'Could not save: {detail}',

  'todo.date.ymd': '{month}/{day}/{year}',
  'todo.date.md': '{month}/{day}',

  'todo.stats.title': 'Statistics',
  'todo.stats.week': 'This week',
  'todo.stats.month': 'This month',
  'todo.stats.year': 'This year',
  'todo.stats.tabs': 'Statistics range',
  'todo.stats.summary': '{done} done · {created} added',
  'todo.stats.legendLess': 'Less',
  'todo.stats.legendMore': 'More',
  'todo.stats.monthLabel': '{month}/{year}',
  'todo.stats.yearLabel': 'Completion across {year}',
  'todo.stats.metricDone': 'Finished',
  'todo.stats.metricActive': 'Days completed',
  'todo.stats.metricStreak': 'Longest run',
  'todo.stats.days': '{count} d',
  'todo.stats.items': '{count} items',

  'todo.day.summary': '{done} done · {created} added',
  'todo.day.empty': 'Nothing on this day',
  'todo.day.emptyHint': 'Nothing on this day yet. Write one.',
  'todo.day.addPlaceholder': 'Add a task for {date}',
  'todo.day.counts': 'The detail is no longer listed; only the counts remain',
  'todo.day.countsChip': 'Counts only · {done} done',
  'todo.day.doneCount': '{done} done',
  'todo.day.more': '+{count} more',
  'todo.day.expandMore': 'Show {count} more',
  'todo.day.collapse': 'Show less',
  'todo.day.unlisted': 'Another {count} finished no longer listed',
  'todo.day.open': 'open',
  'todo.day.done': 'done',

  'todo.reminder.presetThirty': 'In 30 minutes',
  'todo.reminder.presetAfternoon': 'This afternoon {time}',
  'todo.reminder.presetTonight': 'Tonight {time}',
  'todo.reminder.presetTomorrow': 'Tomorrow {time}',
  'todo.reminder.tooltipValue': 'Reminder {time} — click to change or clear',
  'todo.reminder.tooltipEmpty': 'Set a reminder',
  'todo.reminder.quick': 'Quick',
  'todo.reminder.clear': 'Clear',
  'todo.reminder.custom': 'Exact time',
  'todo.reminder.wheelToggle': 'Pick hour and minute',
  'todo.reminder.placeholder': 'e.g. 15:30',
  'todo.reminder.apply': 'Set',
  'todo.reminder.wheelLabel': 'Hour and minute picker',
  'todo.reminder.wheelTitle': 'Pick the exact time',
  'todo.reminder.wheelHintBoth': 'Pick the hour, then the minute',
  'todo.reminder.wheelHintHour': 'Pick the hour',
  'todo.reminder.wheelHintMinute': 'Pick the minute',
  'todo.reminder.wheelHintDone': 'Selected',
  'todo.reminder.hour': 'h',
  'todo.reminder.minute': 'm',
  'todo.reminder.toastTitle': 'Task reminder',
  'todo.reminder.markDone': 'Mark done',
  'todo.reminder.snooze': 'Snooze 10 min',
  'todo.reminder.rowTooltip': 'Reminder {time}',

  'todo.weekdayLong.mon': 'Monday',
  'todo.weekdayLong.tue': 'Tuesday',
  'todo.weekdayLong.wed': 'Wednesday',
  'todo.weekdayLong.thu': 'Thursday',
  'todo.weekdayLong.fri': 'Friday',
  'todo.weekdayLong.sat': 'Saturday',
  'todo.weekdayLong.sun': 'Sunday',
  'todo.weekdayCard.mon': 'Mon',
  'todo.weekdayCard.tue': 'Tue',
  'todo.weekdayCard.wed': 'Wed',
  'todo.weekdayCard.thu': 'Thu',
  'todo.weekdayCard.fri': 'Fri',
  'todo.weekdayCard.sat': 'Sat',
  'todo.weekdayCard.sun': 'Sun',

  'todo.weekday.mon': 'Mon',
  'todo.weekday.tue': 'Tue',
  'todo.weekday.wed': 'Wed',
  'todo.weekday.thu': 'Thu',
  'todo.weekday.fri': 'Fri',
  'todo.weekday.sat': 'Sat',
  'todo.weekday.sun': 'Sun',
}
