/**
 * The list rail: which list the board is showing, and the operations on the lists
 * themselves.
 *
 * Three selections exist and only one of them is a list: `全部清单` shows the whole
 * board, `未分类` shows the tasks filed under no list, and a list id shows that list.
 * The last two are the same axis the file keeps — `listId` ABSENT is the default list
 * (`wire.ts` `TodoItem.listId`), so "unfile" and "move to default" are one operation
 * and the rail's second row is not a reserved id anything could be renamed into.
 *
 * Creating, renaming, deleting and reordering each answer the whole board, so the
 * rail draws exactly the sequence the store holds: `order` is dense and in sequence
 * (`store.ts` `renumberLists`), which is what makes a press on 上移 a swap rather than
 * a guess.
 *
 * @module @dsh-app/plugin-todo/client/listrail
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button,
  IconChevronDownOutlineRegular,
  IconChevronUpOutlineRegular,
  IconEditOutlineRegular,
  IconPlusOutlineRegular,
  Input,
  Modal,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from './translate.ts'
import type { TodoList } from '../wire.ts'

/** Which tasks the board is showing: everything, the unfiled ones, or one list. */
export type ListFilter = 'all' | 'default' | string

/**
 * The dialog one list is managed in: its name, its place in the rail, and its end.
 *
 * The heading names the OPERATION, not the list: the name is in the field directly
 * below it, and a heading that repeats it is both redundant and the first thing a
 * long name breaks.
 *
 * The card holds two rows of chrome, not three: the footer carries every action —
 * the destructive one on the left, away from the name field, and the
 * `todo.rail.cancel` / `todo.rail.save` pair on the right — so no rule is needed
 * between the body and the actions. The delete button is a plain text button: a text
 * action carries no leading glyph.
 *
 * Deleting is TWO steps in the same card rather than a native confirm — the second
 * press says what happens to the tasks (`todo.rail.deleteConfirm`), because "delete
 * the list" reads like "delete the work" and the tasks are what the user would miss.
 * The confirmation takes the delete button's place while it is showing, so the two
 * presses are never on the same target: an accidental double press cannot delete
 * anything. Two steps are enough because the tasks survive: they fall back to the
 * unfiled row, so the action is recoverable and does not earn the acknowledgement
 * checkbox that `RiskConfirmation` reserves for irreversible choices.
 *
 * @param props.list - the list being managed.
 * @param props.canReorder - whether the rail holds more than one list. With a
 *   single list BOTH directions are unavailable at the same time, so the two arrows
 *   are not rendered at all: a pair of permanently disabled buttons is a dead
 *   control, not a hint about what the page can do.
 * @param props.first - whether this is the first list in the rail.
 * @param props.last - whether this is the last one.
 * @param props.busy - a write is in flight.
 * @param props.t - the dictionary seat.
 * @param props.onRename - renames it.
 * @param props.onRemove - deletes it.
 * @param props.onMove - moves it one place up (-1) or down (1).
 * @param props.onClose - closes the dialog.
 */
function ManageListDialog({ list, canReorder, first, last, busy, t, onRename, onRemove, onMove, onClose }: {
  list: TodoList
  canReorder: boolean
  first: boolean
  last: boolean
  busy: boolean
  t: Translate
  /** Resolves to the message to keep showing, or `undefined` on success. */
  onRename: (id: string, name: string) => Promise<string | undefined>
  onRemove: (id: string) => Promise<string | undefined>
  onMove: (id: string, offset: -1 | 1) => void
  onClose: () => void
}): ReactNode {
  const [name, setName] = useState(list.name)
  const [confirming, setConfirming] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const trimmed = name.trim()

  const rename = (): void => {
    setFailure(undefined)
    void onRename(list.id, trimmed).then((message) => {
      if (message === undefined) onClose()
      else setFailure(message)
    })
  }
  const drop = (): void => {
    setFailure(undefined)
    void onRemove(list.id).then((message) => {
      if (message === undefined) onClose()
      else setFailure(message)
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('todo.rail.manageTitle')}
      closeLabel={t('todo.view.close')}
      footer={(
        <div className="dshTodo-railDialogFooterSplit">
          {confirming ? null : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="dshTodo-railDeleteBtn"
              disabled={busy}
              onClick={() => { setConfirming(true) }}
            >
              {t('todo.rail.delete')}
            </Button>
          )}
          {/*
            ONE action row at all times. The second step replaces this row's primary
            instead of adding a second pair of buttons in the body: the body version
            left two Cancel buttons on screen at once, and a Save that had nothing
            left to save while the confirm was up.
          */}
          <div className="dshTodo-railDialogActions">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => { if (confirming) setConfirming(false); else onClose() }}
            >
              {t('todo.rail.cancel')}
            </Button>
            {confirming ? (
              <Button
                type="button"
                variant="primary"
                size="sm"
                className="dshTodo-dangerPrimary"
                disabled={busy}
                onClick={drop}
              >
                {t('todo.rail.deleteConfirmAction')}
              </Button>
            ) : (
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={busy || trimmed === '' || trimmed === list.name}
                onClick={rename}
              >
                {t('todo.rail.save')}
              </Button>
            )}
          </div>
        </div>
      )}
    >
      <div className="dshTodo-railDialog">
        <label className="dshTodo-editorLabel" htmlFor="dshTodo-railName">{t('todo.rail.nameLabel')}</label>
        <Input
          id="dshTodo-railName"
          type="text"
          className="dshTodo-railDialogInput"
          value={name}
          placeholder={t('todo.rail.namePlaceholder')}
          disabled={busy}
          data-modal-autofocus
          onChange={(event) => { setName(event.target.value) }}
          onKeyDown={(event) => {
            // Enter renames, but never while the delete is armed: the Save button is
            // gone in that state, so a keystroke must not do what it no longer offers.
            if (!confirming && event.key === 'Enter' && trimmed !== '' && trimmed !== list.name) {
              event.preventDefault()
              rename()
            }
          }}
        />
        {/* Only when there is somewhere to move: with one list both arrows are
            disabled at once, which is a dead control rather than an affordance. */}
        {canReorder && (
          <div className="dshTodo-railDialogRow">
            <Tooltip label={t('todo.rail.moveUp')} side="top">
              <Button
                type="button"
                variant="outline"
                size="sm"
                icon={<IconChevronUpOutlineRegular />}
                aria-label={t('todo.rail.moveUp')}
                disabled={busy || first}
                onClick={() => { onMove(list.id, -1) }}
              />
            </Tooltip>
            <Tooltip label={t('todo.rail.moveDown')} side="top">
              <Button
                type="button"
                variant="outline"
                size="sm"
                icon={<IconChevronDownOutlineRegular />}
                aria-label={t('todo.rail.moveDown')}
                disabled={busy || last}
                onClick={() => { onMove(list.id, 1) }}
              />
            </Tooltip>
          </div>
        )}
        {/* The second step explains what happens to the tasks; the decision itself
            lives in the footer, so this state never adds a second pair of buttons. */}
        {confirming ? (
          <p className="dshTodo-railDangerText" role="status">{t('todo.rail.deleteConfirm')}</p>
        ) : null}
        {failure === undefined ? null : <p className="dshTodo-editorError" role="alert">{failure}</p>}
      </div>
    </Modal>
  )
}

/**
 * The dialog a new list is created in.
 * @param props.busy - a write is in flight.
 * @param props.t - the dictionary seat.
 * @param props.onCreate - creates it under this name.
 * @param props.onClose - closes the dialog.
 */
function CreateListDialog({ busy, t, onCreate, onClose }: {
  busy: boolean
  t: Translate
  /** Resolves to the message to keep showing, or `undefined` on success. */
  onCreate: (name: string) => Promise<string | undefined>
  onClose: () => void
}): ReactNode {
  const [name, setName] = useState('')
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const trimmed = name.trim()
  const create = (): void => {
    if (trimmed === '') return
    setFailure(undefined)
    void onCreate(trimmed).then((message) => {
      if (message === undefined) onClose()
      else setFailure(message)
    })
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('todo.rail.createTitle')}
      closeLabel={t('todo.view.close')}
      footer={(
        <div className="dshTodo-railDialogFooter">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('todo.rail.cancel')}</Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={busy || trimmed === ''}
            onClick={create}
          >
            {t('todo.rail.create')}
          </Button>
        </div>
      )}
    >
      <div className="dshTodo-railDialog">
        <label className="dshTodo-editorLabel" htmlFor="dshTodo-newList">{t('todo.rail.nameLabel')}</label>
        <Input
          id="dshTodo-newList"
          type="text"
          className="dshTodo-railDialogInput"
          value={name}
          placeholder={t('todo.rail.namePlaceholder')}
          disabled={busy}
          data-modal-autofocus
          onChange={(event) => { setName(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              create()
            }
          }}
        />
        {failure === undefined ? null : <p className="dshTodo-editorError" role="alert">{failure}</p>}
      </div>
    </Modal>
  )
}

/**
 * The rail.
 * @param props.lists - the board's lists, in display order.
 * @param props.counts - open tasks per filter key (`all`, `default`, a list id).
 * @param props.selected - which filter the board is showing.
 * @param props.busy - a write is in flight.
 * @param props.t - the dictionary seat.
 * @param props.onSelect - shows another filter.
 * @param props.onCreate - creates a list.
 * @param props.onRename - renames a list.
 * @param props.onRemove - deletes a list.
 * @param props.onMove - moves a list one place.
 */
export function ListRail({ lists, counts, selected, busy, t, onSelect, onCreate, onRename, onRemove, onMove }: {
  lists: readonly TodoList[]
  counts: Readonly<Record<string, number>>
  selected: ListFilter
  busy: boolean
  t: Translate
  onSelect: (filter: ListFilter) => void
  /** Each write resolves to the message to keep showing, or `undefined` on success. */
  onCreate: (name: string) => Promise<string | undefined>
  onRename: (id: string, name: string) => Promise<string | undefined>
  onRemove: (id: string) => Promise<string | undefined>
  onMove: (id: string, offset: -1 | 1) => void
}): ReactNode {
  const [creating, setCreating] = useState(false)
  const [managing, setManaging] = useState<string | undefined>(undefined)
  const managed = lists.find(list => list.id === managing)
  const managedAt = lists.findIndex(list => list.id === managing)

  const rows: { key: ListFilter; label: string }[] = [
    { key: 'all', label: t('todo.rail.all') },
    { key: 'default', label: t('todo.rail.default') },
    ...lists.map(list => ({ key: list.id as ListFilter, label: list.name })),
  ]

  return (
    <aside className="dshTodo-rail" aria-label={t('todo.rail.title')}>
      <div className="dshTodo-railHead">
        <span className="dshTodo-railTitle">{t('todo.rail.title')}</span>
        <Tooltip label={t('todo.rail.new')} side="top">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon={<IconPlusOutlineRegular />}
            aria-label={t('todo.rail.new')}
            disabled={busy}
            onClick={() => { setCreating(true) }}
          />
        </Tooltip>
      </div>
      <ul className="dshTodo-railList">
        {rows.map((row) => {
          const list = lists.find(entry => entry.id === row.key)
          return (
            <li key={row.key} className="dshTodo-railItem">
              <button
                type="button"
                className="dshTodo-railBtn"
                data-active={selected === row.key ? 'true' : undefined}
                aria-current={selected === row.key ? 'true' : undefined}
                onClick={() => { onSelect(row.key) }}
              >
                <span className="dshTodo-railName">{row.label}</span>
                <span className="dshTodo-railCount">{counts[row.key] ?? 0}</span>
              </button>
              {list === undefined ? null : (
                <Tooltip label={t('todo.rail.manage', { name: list.name })} side="top">
                  <button
                    type="button"
                    className="dshTodo-railEdit"
                    aria-label={t('todo.rail.manage', { name: list.name })}
                    disabled={busy}
                    onClick={() => { setManaging(list.id) }}
                  >
                    <IconEditOutlineRegular />
                  </button>
                </Tooltip>
              )}
            </li>
          )
        })}
      </ul>
      {creating ? (
        <CreateListDialog
          busy={busy}
          t={t}
          onCreate={onCreate}
          onClose={() => { setCreating(false) }}
        />
      ) : null}
      {managed === undefined ? null : (
        <ManageListDialog
          list={managed}
          canReorder={lists.length > 1}
          first={managedAt <= 0}
          last={managedAt >= lists.length - 1}
          busy={busy}
          t={t}
          onRename={onRename}
          onRemove={onRemove}
          onMove={onMove}
          onClose={() => { setManaging(undefined) }}
        />
      )}
    </aside>
  )
}
