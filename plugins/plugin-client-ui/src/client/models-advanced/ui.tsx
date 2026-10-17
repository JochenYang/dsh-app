/**
 * The field vocabulary this page's cards render with.
 *
 * Every control a route parameter needs goes through here, so one field looks the
 * same wherever it appears: a label, an optional hint under it, the control, an
 * inline error when the draft is refused, and — for a route field — an
 * "overridden" badge with a reset that restores the inherited value.
 *
 * Every control here is one of the kernel's own primitives (`Button`, `Input`,
 * `Checkbox`): this page writes a shared settings namespace, and a control dressed
 * in a private class vocabulary reads as a foreign element beside the surfaces
 * those primitives already build.
 *
 * @module @dsh-app/plugin-client-ui/client/models-advanced/ui
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Checkbox, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { formatCapacity, parseCapacity, parseHeaders, readHeaders } from './fields.ts'
import type { HeaderRow } from './fields.ts'
import { messageText } from './messages.ts'
import type { Translate } from './messages.ts'
import { parseCredentialRef, parseDurationMs, parseEnumChoice, parseRatio, parseRetryCount } from './route-fields.ts'

/**
 * The page's translate seat, re-exported so a control file imports one name for
 * copy instead of reaching into the message module for the type and the page for
 * the values.
 */
export type { Translate } from './messages.ts'

/** What a scalar control accepts, which decides how its draft text parses. */
export type ScalarKind = 'text' | 'count' | 'duration' | 'retries' | 'ratio' | 'credential' | 'enum'

/** One scalar field's inputs. */
export interface ScalarFieldProps {
  /** Stable id base for the input/label/hint wiring. */
  id: string
  /** Visible label. */
  label: string
  /** One line explaining what the field does, shown under the control. */
  hint?: string
  /** Stored value: number for counts/durations, string for text/enum. */
  value: unknown
  /** How the draft text parses. */
  kind: ScalarKind
  /** Accepted values for `kind: 'enum'`. */
  choices?: readonly string[]
  /** Human label of a choice, for `kind: 'enum'` (defaults to the raw value). */
  choiceLabel?: (choice: string) => string
  /** Placeholder shown while the field is empty. */
  placeholder?: string
  /** Disables the control (read-only surface, or a write in flight). */
  disabled?: boolean
  /** Copy for a draft THIS control could not parse. */
  invalidCopy: string
  /** Label of the "inherit" choice an empty draft means. */
  inheritLabel: string
  /** Called with the parsed value, or undefined when the draft means "inherit". */
  onCommit: (next: unknown) => void
  /** Shows the persisted-override badge and the reset control. */
  overridden?: boolean
  /** Copy for the badge. */
  overriddenLabel?: string
  /** Copy for the reset control. */
  resetLabel?: string
}

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
 * A labelled scalar field with inline validation.
 *
 * The draft text is local state so a half-typed value survives a keystroke ("12"
 * on the way to "1200") while the stored value only ever receives a parsed number.
 * Re-seeding from the caller's value is skipped for the echo of our own commit:
 * `formatCapacity` renders 500000 as "500K", so re-seeding on every keystroke would
 * rewrite "0.5M" under the user's cursor.
 *
 * @param props - see {@link ScalarFieldProps}.
 * @returns the field block.
 */
export function ScalarField(props: ScalarFieldProps): ReactNode {
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

  const message = localError ? invalidCopy : undefined
  const invalidId = `${id}-invalid`
  const hintId = `${id}-hint`
  const describedBy = [hint === undefined ? undefined : hintId, message === undefined ? undefined : invalidId]
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

  const head = (
    <>
      <label className="dshAma-fieldLabel" htmlFor={id}>{label}</label>
      {props.overridden === true && props.resetLabel !== undefined ? (
        <>
          <span className="dshAma-badge dshAma-badgeOverridden">{props.overriddenLabel ?? ''}</span>
          <button
            type="button"
            className="dshAma-linkButton"
            aria-label={`${props.resetLabel}: ${label}`}
            disabled={disabled === true}
            onClick={() => { setLocalError(false); echoed.current = undefined; onCommit(undefined) }}
          >{props.resetLabel}</button>
        </>
      ) : null}
    </>
  )

  return (
    <div className="dshAma-field">
      <span className="dshAma-fieldHead">{head}</span>
      {kind === 'enum' ? (
        <select
          id={id}
          className="dshAma-input dshAma-select"
          value={typeof value === 'string' ? value : ''}
          disabled={disabled === true}
          aria-invalid={message !== undefined}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          onChange={(event) => {
            const parsed = parseEnumChoice(event.target.value, choices)
            echoed.current = parsed ?? undefined
            setLocalError(false)
            onCommit(parsed ?? undefined)
          }}
        >
          <option value="">{props.inheritLabel}</option>
          {choices.map(choice => (
            <option key={choice} value={choice}>
              {props.choiceLabel === undefined ? choice : props.choiceLabel(choice)}
            </option>
          ))}
        </select>
      ) : (
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
          aria-invalid={message !== undefined}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          onChange={(event) => { edit(event.target.value) }}
        />
      )}
      {hint === undefined || hint === '' ? null : <p className="dshAma-fieldHint" id={hintId}>{hint}</p>}
      {message === undefined ? null : <p className="dshAma-fieldError" id={invalidId} role="status">{message}</p>}
    </div>
  )
}

/** A boolean field, rendered as the kernel's checkbox. */
export interface CheckFieldProps {
  /** Visible label; also the checkbox's accessible name. */
  label: string
  /** Current value. */
  checked: boolean
  /** Disables the control. */
  disabled?: boolean
  /** Called with the requested state. */
  onChange: (next: boolean) => void
}

/**
 * A checkbox with a visible label.
 * @param props - see {@link CheckFieldProps}.
 * @returns the row.
 */
export function CheckField(props: CheckFieldProps): ReactNode {
  return (
    <Checkbox
      checked={props.checked}
      label={props.label}
      disabled={props.disabled === true}
      onChange={props.onChange}
    />
  )
}

/** One collapsible group of fields, with a summary line in its header. */
export interface FieldGroupProps {
  /** Visible group title. */
  title: string
  /** Short description of what the group holds. */
  hint?: string
  /** Summary shown in the collapsed header ("已设置 2 项"). */
  summary?: string
  /** Whether the group starts open. */
  defaultOpen?: boolean
  /** Forces the group open (an unsaved change inside it). */
  forceOpen?: boolean
  /** A rule violation that spans the group's fields, shown inside it. */
  error?: string
  /** The group's fields. */
  children: ReactNode
}

/**
 * A collapsible group, drawn as the page's own `<details>` card so it sits beside
 * the three existing cards without a second visual language.
 *
 * Collapsed by default: the card carries a dozen rarely-used parameters, and
 * expanding them all would bury the two that matter. The header's summary is what
 * makes collapsing safe — a user can see a group is configured without opening it.
 *
 * @param props - see {@link FieldGroupProps}.
 * @returns the group.
 */
export function FieldGroup(props: FieldGroupProps): ReactNode {
  const [open, setOpen] = useState(props.defaultOpen === true)
  return (
    <details className="dshAma-card dshAma-retryCard" open={open || props.forceOpen === true}>
      <summary
        className="dshAma-cardSummary"
        onClick={(event) => {
          // Own the open state so a forced group can be closed without React
          // re-opening it on the next render.
          event.preventDefault()
          setOpen((was) => !was)
        }}
      >
        {props.title}{props.summary === undefined ? null : <span className="dshAma-groupSummary">{props.summary}</span>}
      </summary>
      <div className="dshAma-cardBody">
        {props.hint === undefined ? null : <p className="dshAma-hint">{props.hint}</p>}
        {props.children}
        {props.error === undefined ? null : <p className="dshAma-fieldError" role="status">{props.error}</p>}
      </div>
    </details>
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
    <div className="dshAma-field">
      <span className="dshAma-fieldLabel">{props.t('adv.headers.title')}</span>
      {rows.length === 0 ? <p className="dshAma-fieldHint">{props.t('adv.headers.empty')}</p> : null}
      {rows.map((row, index) => (
        <div className="dshAma-kvRow" key={String(index)}>
          <Input
            className="dshAma-inputWrap"
            type="text"
            value={row.name}
            disabled={props.disabled}
            aria-label={props.t('adv.headers.nameAria', { index: index + 1 })}
            onChange={(event) => {
              const next = [...rows]
              next[index] = { name: event.target.value, value: row.value }
              write(next)
            }}
          />
          <Input
            className="dshAma-inputWrap"
            type="text"
            value={row.value}
            disabled={props.disabled}
            aria-label={props.t('adv.headers.valueAria', { index: index + 1 })}
            onChange={(event) => {
              const next = [...rows]
              next[index] = { name: row.name, value: event.target.value }
              write(next)
            }}
          />
          <Button
            type="button" variant="ghost" size="sm" icon="×"
            className="dshAma-iconAction dshAma-iconDanger"
            disabled={props.disabled}
            aria-label={props.t('adv.headers.removeAria', { index: index + 1 })}
            onClick={() => { write(rows.filter((_row, at) => at !== index)) }}
          />
        </div>
      ))}
      <div className="dshAma-inline">
        <Button
          type="button" variant="outline" size="sm"
          disabled={props.disabled}
          onClick={() => { write([...rows, { name: '', value: '' }]) }}
        >{props.t('adv.headers.add')}</Button>
        {rows.length === 0 ? null : (
          <button
            type="button"
            className="dshAma-linkButton"
            disabled={props.disabled}
            onClick={() => { setRows([]); props.onChange(undefined) }}
          >{props.t('adv.headers.clear')}</button>
        )}
      </div>
      {parsed.ok ? null : <p className="dshAma-fieldError" role="status">{messageText(parsed.failure, props.t)}</p>}
      <p className="dshAma-fieldHint">{props.t('adv.headers.hint')}</p>
    </div>
  )
}
