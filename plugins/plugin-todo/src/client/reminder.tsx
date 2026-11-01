/**
 * In-app reminder setting popover and bottom-right toast notification.
 * Built strictly with dsh-client-ui-primitives to keep visual consistency.
 *
 * @module @dsh-app/plugin-todo/client/reminder
 */

import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  Button,
  IconAlarmClockOutlineRegular,
  IconClockOutlineRegular,
  IconCloseOutlineRegular,
  Input,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TodoItem } from '../wire.ts'
import type { TodoKey } from './locales.ts'
import type { Translate } from './translate.ts'

/** Format HH:MM from epoch ms */
export function formatTime(ms: number): string {
  const date = new Date(ms)
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

/**
 * Quick preset calculation based on current time.
 */
export function quickPresets(): { key: TodoKey, time: string | undefined, timeMs: number }[] {
  const now = new Date()
  const todayYMD = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

  // 1. 30 minutes later
  const in30m = Date.now() + 30 * 60 * 1000

  // 2. This afternoon (14:00 or 16:00)
  const thisAfternoon = new Date(todayYMD(now))
  thisAfternoon.setHours(now.getHours() >= 14 ? 16 : 14, 0, 0, 0)
  const afternoonMs = thisAfternoon.getTime() > Date.now() ? thisAfternoon.getTime() : in30m

  // 3. Tonight (20:00)
  const tonight = new Date(todayYMD(now))
  tonight.setHours(20, 0, 0, 0)
  const tonightMs = tonight.getTime() > Date.now() ? tonight.getTime() : Date.now() + 2 * 60 * 60 * 1000

  // 4. Tomorrow morning (09:00)
  const tomorrow = new Date(todayYMD(now) + 24 * 60 * 60 * 1000)
  tomorrow.setHours(9, 0, 0, 0)

  return [
    { key: 'todo.reminder.presetThirty', time: undefined, timeMs: in30m },
    { key: 'todo.reminder.presetAfternoon', time: formatTime(afternoonMs), timeMs: afternoonMs },
    { key: 'todo.reminder.presetTonight', time: formatTime(tonightMs), timeMs: tonightMs },
    { key: 'todo.reminder.presetTomorrow', time: formatTime(tomorrow.getTime()), timeMs: tomorrow.getTime() },
  ]
}

/** Quick fixed time slots for custom section */
const QUICK_SLOTS = ['09:00', '12:00', '15:00', '18:00', '21:00']

/** Standard hours (0..23) and minutes (0..59) for dropdown selection */
const HOURS = Array.from({ length: 24 }, (_, i) => i)
const MINUTES = Array.from({ length: 60 }, (_, i) => i)

/**
 * The popover picker for setting a reminder time on a task.
 */
export function ReminderPicker({
  value,
  onChange,
  t,
  disabled = false,
  compact = false,
  placement: forcedPlacement,
}: {
  value: number | undefined
  onChange: (timeMs: number | undefined) => void
  /** The dictionary seat: every label this picker prints comes from it. */
  t: Translate
  disabled?: boolean
  compact?: boolean
  placement?: 'bottom' | 'top'
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [customText, setCustomText] = useState('')
  const [placement, setPlacement] = useState<'bottom' | 'top'>('bottom')
  const [wheelOpen, setWheelOpen] = useState(false)
  const [selectedHour, setSelectedHour] = useState<number | undefined>(undefined)
  const [selectedMinute, setSelectedMinute] = useState<number | undefined>(undefined)
  const [hourClicked, setHourClicked] = useState(false)
  const [minuteClicked, setMinuteClicked] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)
  const hourListRef = useRef<HTMLDivElement>(null)
  const minuteListRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      setWheelOpen(false)
      setHourClicked(false)
      setMinuteClicked(false)
    }
  }, [open])

  useEffect(() => {
    if (!wheelOpen) return
    const timer = setTimeout(() => {
      const hourEl = hourListRef.current?.querySelector('[data-selected="true"]')
      hourEl?.scrollIntoView({ block: 'center' })
      const minuteEl = minuteListRef.current?.querySelector('[data-selected="true"]')
      minuteEl?.scrollIntoView({ block: 'center' })
    }, 0)
    return () => { clearTimeout(timer) }
  }, [wheelOpen])

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => { document.removeEventListener('mousedown', handleClickOutside) }
  }, [open])

  useEffect(() => {
    if (!open || !popoverRef.current) return
    if (forcedPlacement) {
      setPlacement(forcedPlacement)
      return
    }
    const rect = popoverRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const spaceAbove = rect.top
    if (spaceBelow < 320 && spaceAbove > spaceBelow) {
      setPlacement('top')
    } else {
      setPlacement('bottom')
    }
  }, [open, forcedPlacement])

  const presets = quickPresets()

  const setTimeSlot = (hhmm: string): void => {
    const parts = hhmm.split(':').map(Number)
    const h = parts[0] ?? 12
    const m = parts[1] ?? 0
    const d = new Date()
    d.setHours(h, m, 0, 0)
    const targetMs = d.getTime() < Date.now() ? d.getTime() + 24 * 60 * 60 * 1000 : d.getTime()
    onChange(targetMs)
    setOpen(false)
  }

  const toggleWheel = (): void => {
    const next = !wheelOpen
    if (next) {
      const match = /^(\d{1,2})[:：.](\d{2})$/u.exec(customText.trim())
      if (match) {
        setSelectedHour(Number(match[1]))
        setSelectedMinute(Number(match[2]))
      } else if (value !== undefined) {
        const d = new Date(value)
        setSelectedHour(d.getHours())
        setSelectedMinute(d.getMinutes())
      } else {
        const now = new Date()
        setSelectedHour(now.getHours())
        setSelectedMinute(now.getMinutes())
      }
      setHourClicked(false)
      setMinuteClicked(false)
    }
    setWheelOpen(next)
  }

  const handleHourSelect = (h: number): void => {
    setSelectedHour(h)
    setHourClicked(true)
    const m = selectedMinute ?? 0
    const formatted = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    setCustomText(formatted)

    if (minuteClicked) {
      setTimeSlot(formatted)
    }
  }

  const handleMinuteSelect = (m: number): void => {
    setSelectedMinute(m)
    setMinuteClicked(true)
    const h = selectedHour ?? new Date().getHours()
    const formatted = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    setCustomText(formatted)

    if (hourClicked) {
      setTimeSlot(formatted)
    }
  }

  const handleCustomApply = (): void => {
    const cleaned = customText.trim().replace('：', ':').replace('.', ':')
    let h = 0
    let m = 0
    if (/^\d{1,2}:\d{2}$/u.test(cleaned)) {
      const parts = cleaned.split(':').map(Number)
      h = parts[0] ?? 0
      m = parts[1] ?? 0
    } else if (/^\d{3,4}$/u.test(cleaned)) {
      const padded = cleaned.padStart(4, '0')
      h = Number(padded.slice(0, 2))
      m = Number(padded.slice(2, 4))
    } else {
      return
    }
    if (h < 0 || h > 23 || m < 0 || m > 59) return
    setTimeSlot(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`)
  }

  const tooltipLabel = value !== undefined
    ? t('todo.reminder.tooltipValue', { time: formatTime(value) })
    : t('todo.reminder.tooltipEmpty')

  return (
    <div
      className={`dshTodo-reminderPickerWrapper${compact ? ' dshTodo-reminderPickerCompact' : ''}`}
      data-empty={value === undefined ? 'true' : undefined}
      ref={popoverRef}
    >
      <Tooltip label={tooltipLabel} side="top">
        <button
          type="button"
          className={compact && value === undefined ? 'dshTodo-reminderTriggerCompact' : 'dshTodo-reminderTrigger'}
          data-active={value !== undefined ? 'true' : undefined}
          disabled={disabled}
          aria-label={tooltipLabel}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setOpen(!open)
          }}
        >
          <span className="dshTodo-reminderTriggerIcon" aria-hidden="true">
            {value !== undefined ? <IconClockOutlineRegular /> : <IconAlarmClockOutlineRegular />}
          </span>
          {value !== undefined ? (
            <span className="dshTodo-reminderTriggerText">{formatTime(value)}</span>
          ) : null}
        </button>
      </Tooltip>

      {open ? (
        <div className="dshTodo-reminderPopover" data-placement={placement} role="dialog" aria-label={t('todo.reminder.tooltipEmpty')}>
          <div className="dshTodo-reminderPopoverHead">
            <span>{t('todo.reminder.quick')}</span>
            {value !== undefined ? (
              <button
                type="button"
                className="dshTodo-reminderClear"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  onChange(undefined)
                  setOpen(false)
                }}
              >
                {t('todo.reminder.clear')}
              </button>
            ) : null}
          </div>
          <div className="dshTodo-reminderPresets">
            {presets.map(p => (
              <button
                key={p.key}
                type="button"
                className="dshTodo-reminderPresetBtn"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  onChange(p.timeMs)
                  setOpen(false)
                }}
              >
                {p.time === undefined ? t(p.key) : t(p.key, { time: p.time })}
              </button>
            ))}
          </div>

          <div className="dshTodo-reminderCustomSection">
            <span className="dshTodo-reminderCustomLabel">{t('todo.reminder.custom')}</span>
            <div className="dshTodo-reminderSlots">
              {QUICK_SLOTS.map(slot => (
                <button
                  key={slot}
                  type="button"
                  className="dshTodo-reminderSlotBtn"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setTimeSlot(slot)
                  }}
                >
                  {slot}
                </button>
              ))}
            </div>
            <div className="dshTodo-reminderCustomForm">
              <Input
                className="dshTodo-reminderCustomInput"
                icon={
                  <Tooltip label={t('todo.reminder.wheelToggle')} side="top">
                    <button
                      type="button"
                      className="dshTodo-timeIconBtn"
                      aria-label={t('todo.reminder.wheelToggle')}
                      data-active={wheelOpen ? 'true' : undefined}
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        toggleWheel()
                      }}
                    >
                      <IconClockOutlineRegular />
                    </button>
                  </Tooltip>
                }
                placeholder={t('todo.reminder.placeholder')}
                value={customText}
                onChange={(e) => { setCustomText(e.target.value) }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    e.stopPropagation()
                    handleCustomApply()
                  }
                }}
              />
              <Button
                type="button"
                variant="primary"
                size="sm"
                className="dshTodo-reminderApplyBtn"
                disabled={customText.trim() === ''}
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  handleCustomApply()
                }}
              >
                {t('todo.reminder.apply')}
              </Button>
            </div>

            {wheelOpen ? (
              <div className="dshTodo-timeWheelPicker" role="region" aria-label={t('todo.reminder.wheelLabel')}>
                <div className="dshTodo-timeWheelHeader">
                  <span>{t('todo.reminder.wheelTitle')}</span>
                  <span className="dshTodo-timeWheelHint">
                    {!hourClicked && !minuteClicked
                      ? t('todo.reminder.wheelHintBoth')
                      : !hourClicked
                        ? t('todo.reminder.wheelHintHour')
                        : !minuteClicked
                          ? t('todo.reminder.wheelHintMinute')
                          : t('todo.reminder.wheelHintDone')}
                  </span>
                </div>
                <div className="dshTodo-timeWheelCols">
                  <div className="dshTodo-timeWheelCol">
                    <span className="dshTodo-timeWheelColTitle">{t('todo.reminder.hour')}</span>
                    <div className="dshTodo-timeWheelList" ref={hourListRef}>
                      {HOURS.map(h => (
                        <button
                          key={h}
                          type="button"
                          className="dshTodo-timeWheelItem"
                          data-selected={selectedHour === h ? 'true' : undefined}
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            handleHourSelect(h)
                          }}
                        >
                          {String(h).padStart(2, '0')}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="dshTodo-timeWheelDivider">:</div>
                  <div className="dshTodo-timeWheelCol">
                    <span className="dshTodo-timeWheelColTitle">{t('todo.reminder.minute')}</span>
                    <div className="dshTodo-timeWheelList" ref={minuteListRef}>
                      {MINUTES.map(m => (
                        <button
                          key={m}
                          type="button"
                          className="dshTodo-timeWheelItem"
                          data-selected={selectedMinute === m ? 'true' : undefined}
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            handleMinuteSelect(m)
                          }}
                        >
                          {String(m).padStart(2, '0')}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * In-App toast card sliding in at bottom-right when a task's reminder rings.
 * Fully composed of dsh-client-ui-primitives atoms.
 */
export function ReminderToast({
  item,
  onDone,
  onSnooze,
  onDismiss,
  t,
}: {
  item: TodoItem
  onDone: () => void
  onSnooze: () => void
  onDismiss: () => void
  /** The dictionary seat: the toast's copy and its action labels come from it. */
  t: Translate
}): ReactNode {
  return (
    <div className="dshTodo-reminderToast" role="alert">
      <div className="dshTodo-reminderToastHead">
        <div className="dshTodo-reminderToastTitle">
          <span className="dshTodo-reminderToastBell" aria-hidden="true">
            <IconAlarmClockOutlineRegular />
          </span>
          <span>{t('todo.reminder.toastTitle')}</span>
          {item.reminderAt !== undefined ? (
            <span className="dshTodo-reminderToastTime">{formatTime(item.reminderAt)}</span>
          ) : null}
        </div>
        <Tooltip label={t('todo.view.close')} side="top">
          <button
            type="button"
            className="dshTodo-reminderToastClose"
            aria-label={t('todo.view.close')}
            onClick={onDismiss}
          >
            <IconCloseOutlineRegular />
          </button>
        </Tooltip>
      </div>
      <p className="dshTodo-reminderToastBody">{item.text}</p>
      <div className="dshTodo-reminderToastActions">
        <Button type="button" variant="primary" size="sm" onClick={onDone}>
          {t('todo.reminder.markDone')}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onSnooze}>
          {t('todo.reminder.snooze')}
        </Button>
      </div>
    </div>
  )
}
