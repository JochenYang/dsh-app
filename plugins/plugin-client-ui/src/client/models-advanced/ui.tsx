/**
 * The field vocabulary this page's cards render with — the source design's
 * grammar: a 12px label, a 32px control, an optional hint under it, and an
 * inline error when the draft is refused.
 *
 * Inputs and buttons are the kernel's primitives (`Button`, `Input`); the
 * controls the primitives do not carry — the two-state boolean, the chip
 * toggle, the compact add-row — are this page's own, styled to the same scale.
 *
 * `AdvancedField` keeps the draft text local so a half-typed value ("12" on the
 * way to "1200") survives a keystroke while the store only ever receives a
 * parsed number; re-seeding is skipped for the echo of our own commit, because
 * the K/M formatter would otherwise rewrite "0.5M" under the cursor.
 *
 * @module @dsh-app/plugin-client-ui/client/models-advanced/ui
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { formatCapacity, parseCapacity, parseHeaders, readHeaders } from './fields.ts'
import type { HeaderRow } from './fields.ts'
import { messageText } from './messages.ts'
import type { Translate } from './messages.ts'
import { parseCredentialRef, parseDurationMs, parseEnumChoice, parseRatio, parseRetryCount } from './route-fields.ts'
import { IconCheck, IconPlus, IconTrash } from './icons.tsx'

/** What a scalar control accepts, which decides how its draft text parses. */
export type ScalarKind = 'text' | 'count' | 'duration' | 'retries' | 'ratio' | 'credential' | 'enum'

/** Render the stored value as the draft text this control edits. */
function draftTextOf(value: unknown, kind: ScalarKind): string {
  if (value === undefined || value === null) return ''
  if (kind === 'count') return typeof value === 'number' ? formatCapacity(value) : String(value)
  return String(value)
}

/**
 * Parse one draft text into a store value.
 * @returns the value, `undefined` for "inherit", or `null` when refused.
 */
function parseDraft(text: string, kind: ScalarKind, choices: readonly string[]): unknown {
  switch (kind) {
    case 'count': return parseCapacity(text)
    case 'duration': return parseDurationMs(text)
    case 'retries': return parseRetryCount(text)
    case 'ratio': return parseRatio(text)
    case 'credential': return parseCredentialRef(text)
    case 'enum': return parseEnumChoice(text, choices)
    case 'text': return text.trim() === '' ? undefined : text.trim()
  }
}

/**
 * A reset is not the echo of a committed value: `undefined` IS what a reset
 * commits, so storing it in `echoed` would make the re-seed guard skip exactly
 * the update the reset asked for.
 */
const RESET = Symbol('reset')

/** Props of {@link AdvancedField}. */
export interface AdvancedFieldProps {
  /** Stable id base for the input/label/hint wiring. */
  readonly id: string
  /** Visible label. */
  readonly label: string
  /** One line explaining the field, shown under the control. */
  readonly hint?: string
  /** Stored value: number for counts/durations, string for text/enum. */
  readonly value: unknown
  /** How the draft text parses. */
  readonly kind: ScalarKind
  /** Accepted values for `kind: 'enum'`. */
  readonly choices?: readonly string[]
  /** Human label of a choice, for `kind: 'enum'` (defaults to the raw value). */
  readonly choiceLabel?: (choice: string) => string
  /** Placeholder shown while the field is empty. */
  readonly placeholder?: string
  /** Disables the control (read-only surface, or a write in flight). */
  readonly disabled?: boolean
  /** Copy for a draft THIS control could not parse. */
  readonly invalidCopy: string
  /** Label of the "inherit" choice an empty draft means. */
  readonly inheritLabel?: string
  /** Called with the parsed value, or undefined when the draft means "inherit". */
  readonly onCommit: (next: unknown) => void
}

/**
 * A labelled scalar field with inline validation.
 * @param props - see {@link AdvancedFieldProps}.
 * @returns the field block.
 */
export function AdvancedField(props: AdvancedFieldProps): ReactNode {
  const { id, label, hint, value, kind, choices = [], disabled, invalidCopy, onCommit } = props
  const [text, setText] = useState(() => draftTextOf(value, kind))
  const [localError, setLocalError] = useState(false)
  /** The value our own last commit stored, so its echo does not re-seed. */
  const echoed = useRef<unknown>(Symbol('initial'))

  useEffect(() => {
    if (Object.is(echoed.current, value)) return
    setText(draftTextOf(value, kind))
    setLocalError(false)
  }, [value, kind])

  const problem = localError ? invalidCopy : undefined
  const invalidId = `${id}-invalid`
  const hintId = `${id}-hint`
  const describedBy = [hint === undefined ? undefined : hintId, problem === undefined ? undefined : invalidId]
    .filter((part): part is string => part !== undefined)
    .join(' ')

  const edit = (next: string): void => {
    setText(next)
    const parsed = parseDraft(next, kind, choices)
    if (parsed === null || (typeof parsed === 'number' && Number.isNaN(parsed))) {
      setLocalError(true)
      return
    }
    setLocalError(false)
    echoed.current = parsed
    onCommit(parsed)
  }

  let control: ReactNode
  if (kind === 'enum') {
    control = (
      <span className="dshAma-selectWrap">
        <select
          id={id}
          className="dshAma-input dshAma-select"
          value={typeof value === 'string' ? value : ''}
          disabled={disabled === true}
          aria-invalid={problem !== undefined}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          onChange={(event) => {
            const parsed = parseEnumChoice(event.target.value, choices)
            echoed.current = parsed ?? undefined
            setLocalError(false)
            onCommit(parsed ?? undefined)
          }}
        >
          <option value="">{props.inheritLabel ?? ''}</option>
          {choices.map(choice => (
            <option key={choice} value={choice}>
              {props.choiceLabel === undefined ? choice : props.choiceLabel(choice)}
            </option>
          ))}
        </select>
      </span>
    )
  } else {
    control = (
      <Input
        id={id}
        className="dshAma-inputWrap"
        type="text"
        inputMode={kind === 'count' || kind === 'duration' ? 'numeric' : 'text'}
        value={text}
        placeholder={props.placeholder}
        disabled={disabled === true}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={problem !== undefined}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        onChange={(event) => { edit(event.target.value) }}
      />
    )
  }

  return (
    <div className="dshAma-field">
      <label className="dshAma-fieldLabel" htmlFor={id}>{label}</label>
      {control}
      {hint === undefined || hint === '' ? null : <span className="dshAma-fieldHint" id={hintId}>{hint}</span>}
      {problem === undefined
        ? null
        : <span className="dshAma-rowError" id={invalidId} role="status">{problem}</span>}
    </div>
  )
}

/** Props of {@link BoolToggle}. */
export interface BoolToggleProps {
  /** Accessible name of the pair. */
  readonly label: string
  /** Current value. */
  readonly value: boolean
  /** Labels for the two states, in display order (on, off). */
  readonly onLabel: string
  readonly offLabel: string
  readonly disabled?: boolean
  readonly onChange: (next: boolean) => void
}

/**
 * A two-state choice that reads better than a checkbox in a dense row.
 * @param props - see {@link BoolToggleProps}.
 * @returns the segmented pair.
 */
export function BoolToggle(props: BoolToggleProps): ReactNode {
  return (
    <div className="dshAma-bool" role="group" aria-label={props.label}>
      {[true, false].map((state) => {
        const on = props.value === state
        return (
          <button
            key={String(state)}
            type="button"
            className={`dshAma-boolBtn${on ? ' is-on' : ''}`}
            aria-pressed={on}
            disabled={props.disabled === true}
            onClick={() => { props.onChange(state) }}
          >{state ? props.onLabel : props.offLabel}</button>
        )
      })}
    </div>
  )
}

/** Props of {@link Chip}. */
export interface ChipProps {
  /** Whether the chip reads as selected. */
  readonly on: boolean
  readonly disabled?: boolean
  readonly children: ReactNode
  readonly onClick: () => void
}

/**
 * A toggle chip: a bordered pill with a check mark while selected.
 * @param props - see {@link ChipProps}.
 * @returns the chip.
 */
export function Chip(props: ChipProps): ReactNode {
  return (
    <button
      type="button"
      className={`dshAma-chip${props.on ? ' is-on' : ''}`}
      aria-pressed={props.on}
      disabled={props.disabled === true}
      onClick={props.onClick}
    >
      {props.on ? <IconCheck /> : null}
      {props.children}
    </button>
  )
}

/**
 * The custom-header table.
 *
 * Rows are local state because `parseHeaders` validates ROWS, not the object: a
 * half-typed name has to stay on screen to be fixed, while the draft only ever
 * receives a header set that passed. The component is remounted (by `key`) whenever
 * the draft is dropped, which is what re-seeds the rows.
 *
 * @param props - the draft value, the write sink, the disabled flag and `t`.
 * @returns the table.
 */
export function HeadersField(props: {
  t: Translate
  value: unknown
  disabled: boolean
  onChange: (next: Record<string, string> | undefined) => void
}): ReactNode {
  const [rows, setRows] = useState<HeaderRow[]>(() => readHeaders(props.value))
  const parsed = parseHeaders(rows)

  const write = (next: readonly HeaderRow[]): void => {
    setRows([...next])
    const outcome = parseHeaders(next)
    // An invalid row stays on screen but is NOT written: the draft never carries a
    // header set the namespace validator would refuse.
    if (!outcome.ok) return
    props.onChange(Object.keys(outcome.value).length === 0 ? undefined : outcome.value)
  }

  return (
    <div className="dshAma-kvList">
      {rows.map((row, index) => (
        <div className="dshAma-kvRow" key={String(index)}>
          <Input
            className="dshAma-inputWrap"
            type="text"
            value={row.name}
            disabled={props.disabled}
            placeholder={props.t('adv.headers.namePlaceholder')}
            aria-label={props.t('adv.headers.nameAria', { index: index + 1 })}
            onChange={(event) => {
              const next = [...rows]
              next[index] = { name: event.target.value, value: row.value }
              write(next)
            }}
          />
          <div className="dshAma-kvValue">
            <Input
              className="dshAma-inputWrap"
              type="text"
              value={row.value}
              disabled={props.disabled}
              placeholder={props.t('adv.headers.valuePlaceholder')}
              aria-label={props.t('adv.headers.valueAria', { index: index + 1 })}
              onChange={(event) => {
                const next = [...rows]
                next[index] = { name: row.name, value: event.target.value }
                write(next)
              }}
            />
          </div>
          <Button
            type="button" variant="ghost" size="sm" icon={<IconTrash />}
            className="dshAma-iconAction dshAma-iconDanger"
            disabled={props.disabled}
            aria-label={props.t('adv.headers.removeAria', { index: index + 1 })}
            onClick={() => { write(rows.filter((_row, at) => at !== index)) }}
          />
        </div>
      ))}
      <button
        type="button"
        className="dshAma-addRow is-compact"
        disabled={props.disabled}
        onClick={() => { write([...rows, { name: '', value: '' }]) }}
      >
        <span className="dshAma-addRowIcon" aria-hidden="true"><IconPlus /></span>
        {props.t('adv.headers.add')}
      </button>
      {parsed.ok ? null : <span className="dshAma-rowError" role="status">{messageText(parsed.failure, props.t)}</span>}
    </div>
  )
}
