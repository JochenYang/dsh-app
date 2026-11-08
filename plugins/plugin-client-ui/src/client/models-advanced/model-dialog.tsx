/**
 * The model configuration dialog: one row's fields, with its advanced half as a
 * disclosure inside the same surface.
 *
 * The dialog edits a DRAFT — applying writes the row into the page's model list,
 * and the page's own footer saves it to disk. That split is why the footer here
 * says "apply" rather than "save": nothing has left the browser yet.
 *
 * Mounted only while open (the caller keys it), so its local draft seeds once and
 * an apply/cancel never races a re-render of the row it was opened for.
 *
 * @module @dsh-app/plugin-client-ui/client/models-advanced/model-dialog
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { ModelEntryEditor } from './entry-editor.tsx'
import type { ModelDraft } from './fields.ts'
import { message, messageText } from './messages.ts'
import type { PageMessage, Translate } from './messages.ts'

/** Props of {@link ModelDialog}. */
export interface ModelDialogProps {
  readonly t: Translate
  /** Dialog heading (add / edit / override). */
  readonly title: string
  /** The row to edit; the dialog copies it on mount. */
  readonly row: ModelDraft
  /** Lock the id input (an override addresses a catalog id by key). */
  readonly lockedId: boolean
  /** True when the route is hand-declared (hides capacities and modalities). */
  readonly handDeclared: boolean
  /** Resolved wire protocol of the row. */
  readonly api: string | undefined
  /** A write is in flight, or the settings source is read-only. */
  readonly disabled: boolean
  /** Ids already taken by sibling rows (a new row may not duplicate one). */
  readonly takenIds: ReadonlySet<string>
  /** Close without applying. */
  readonly onClose: () => void
  /** Apply the edited row to the draft list. */
  readonly onApply: (row: ModelDraft) => void
}

/**
 * Render the model dialog.
 * @param props - see {@link ModelDialogProps}.
 * @returns the dialog.
 */
export function ModelDialog(props: ModelDialogProps): ReactNode {
  const { t, title, row, lockedId, handDeclared, api, disabled, takenIds, onClose, onApply } = props
  const [draft, setDraft] = useState<ModelDraft>(row)
  const [failure, setFailure] = useState<PageMessage | undefined>(undefined)
  /** Remount key for the editor: its capacity buffers are local state, so a
   *  form reset has to remount it rather than only replace the draft. */
  const [epoch, setEpoch] = useState(0)

  const apply = (): void => {
    const id = typeof draft.id === 'string' ? draft.id.trim() : ''
    if (id === '') {
      setFailure(message('adv.failure.modelIdEmpty'))
      return
    }
    if (!lockedId && takenIds.has(id)) {
      setFailure(message('adv.failure.modelIdDuplicate', { id }))
      return
    }
    onApply({ ...draft, id })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      closeLabel={t('adv.common.close')}
      className="dshAma-modelModal dshAma-scope"
      contentClassName="dshAma-modalScroll"
      footer={(
        <>
          <Button
            type="button" variant="ghost" size="sm"
            disabled={disabled}
            onClick={() => { setDraft(row); setFailure(undefined); setEpoch(value => value + 1) }}
          >{t('adv.models.resetForm')}</Button>
          <span className="dshAma-footGap" />
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('adv.common.cancel')}</Button>
          <Button type="button" variant="primary" size="sm" disabled={disabled} onClick={apply}>
            {t('adv.models.apply')}
          </Button>
        </>
      )}
    >
      <ModelEntryEditor
        key={epoch}
        row={draft}
        onChange={(next) => { setDraft(next); setFailure(undefined) }}
        lockedId={lockedId}
        handDeclared={handDeclared}
        api={api}
        index={0}
        disabled={disabled}
        t={t}
      />
      {failure === undefined
        ? null
        : <p className="dshAma-alert is-err" role="status">{messageText(failure, t)}</p>}
    </Modal>
  )
}
