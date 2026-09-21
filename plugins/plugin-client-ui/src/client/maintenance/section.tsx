/**
 * The 维护 settings section (order 22): one rail row holding the suite's three
 * upkeep pages as tabs — 用量统计 (1), 预设包 (2), 诊断 (3).
 *
 * This is the section OWNER. It declares the root-level list slot
 * `settings.dsh-app-maintenance.tab` in the same `register()` call that
 * contributes the section (see `client.ts`), enumerates its entries, draws the
 * tab strip, and mounts the selected contribution inside its panel — the
 * pattern the kernel ships for its own 「内置插件」 section
 * (`@deepseek-ai/dsh-client-ui-settings-plugins`), copied rather than
 * reinvented: the entry options (`id` / `order` / `label`) become the tabs,
 * `renderSlot(key, {}, { only: id })` mounts one contribution, and a single
 * contribution renders as the page itself with no strip to choose from.
 *
 * The ledger arrives through the register call's `inject` face: its `hooks`
 * compartment is bound by the UI renderer as a `use<Name>` selector hook, so
 * `tabs` reaches this component as `useTabs`. A tab, once selected, stays
 * mounted (`hidden` on the panels the user has visited), which is what keeps a
 * loaded page's data and scroll position across tab switches.
 *
 * The three contributors keep their own locale namespace and their own `t`
 * seat — this page only ever renders its own two keys.
 *
 * @module @dsh-app/plugin-client-ui/client/maintenance/section
 */

import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'

/** The child slot this section declares and renders (see `client.ts`). */
export const TAB_SLOT = 'settings.dsh-app-maintenance.tab'

/** One tab of the strip, projected from its registration. */
export interface MaintenanceTabRow {
  /** List-slot id of the contributing entry (also its panel `only` filter). */
  readonly id: string
  /** Declared tab position, ascending. */
  readonly order: number
  /** Registrant-localized label of the active locale. */
  readonly label: string
}

/**
 * The inject face the section's register call supplies. The reserved `hooks`
 * compartment is what the renderer binds into selector hooks, so `tabs` is the
 * `useTabs` prop below (see `InjectFace`).
 */
export interface MaintenanceInjected {
  hooks: {
    /** The child slot's ledger, paired to the active locale. */
    tabs: HostObservable<readonly MaintenanceTabRow[]>
  }
}

/**
 * Props delivered by the slot outlet: the declared child slot's `renderSlot`
 * share, the inject face's bound hooks, and the `t` seat of this namespace.
 */
export type MaintenanceSectionProps =
  PropsRenderSlots<typeof TAB_SLOT>
  & InjectFace<MaintenanceInjected>
  & PropsLocale<typeof NS>

/**
 * Render the 维护 settings section: heading, tab strip, and the selected tab's
 * page.
 * @param props - the framework-supplied render/hook shares and the `t` seat.
 * @returns the section page.
 */
export function MaintenanceSection({ t, renderSlot, useTabs }: MaintenanceSectionProps): ReactNode {
  // One mount-scoped id namespace: the heading, every tab and every panel.
  const pageId = useId()
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const rows = useTabs((value) => value)
  const [activeId, setActiveId] = useState<string>()
  const [visitedIds, setVisitedIds] = useState<ReadonlySet<string>>(() => new Set())
  // An id that left the ledger (its plugin was disabled) falls back to the
  // first tab instead of rendering an empty pane.
  const active = rows.find((row) => row.id === activeId)?.id ?? rows[0]?.id
  const single = rows.length === 1 ? rows[0] : undefined

  // Visiting a tab is what mounts its panel; the set only ever grows, so a
  // visited page keeps its state instead of remounting on every switch.
  useEffect(() => {
    if (active === undefined) return
    setVisitedIds((previous) => {
      if (previous.has(active)) return previous
      return new Set([...previous, active])
    })
  }, [active])

  // The heading names the pane (a `<section>` with an accessible name is a
  // region); the tab strip's own name is the second key, because the pages
  // inside draw tablists of their own (the usage page's day range).
  const headingId = `${pageId}-title`
  const heading = <h2 id={headingId} className="dshMaint-heading">{t('maint.nav')}</h2>

  if (single !== undefined) {
    return (
      <section className="dshMaint-section" aria-labelledby={headingId}>
        <style>{MAINTENANCE_CSS}</style>
        {heading}
        <div className="dshMaint-panel">
          {renderSlot(TAB_SLOT, {}, { only: single.id })}
        </div>
      </section>
    )
  }

  return (
    <section className="dshMaint-section" aria-labelledby={headingId}>
      <style>{MAINTENANCE_CSS}</style>
      {heading}
      <div className="dshMaint-tabs" role="tablist" aria-label={t('maint.tabs')}>
        {rows.map((row, index) => {
          const selected = row.id === active
          return (
            <button
              key={row.id}
              ref={(element) => { tabRefs.current[index] = element }}
              id={`${pageId}-tab-${row.id}`}
              type="button"
              role="tab"
              className="dshMaint-tab"
              aria-selected={selected}
              aria-controls={`${pageId}-panel-${row.id}`}
              data-active={selected ? 'true' : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => { setActiveId(row.id) }}
              onKeyDown={(event) => {
                let nextIndex: number
                switch (event.key) {
                  case 'ArrowRight':
                    nextIndex = (index + 1) % rows.length
                    break
                  case 'ArrowLeft':
                    nextIndex = (index - 1 + rows.length) % rows.length
                    break
                  case 'Home':
                    nextIndex = 0
                    break
                  case 'End':
                    nextIndex = rows.length - 1
                    break
                  default:
                    return
                }
                event.preventDefault()
                setActiveId(rows[nextIndex].id)
                tabRefs.current[nextIndex]?.focus()
              }}
            >
              {row.label}
            </button>
          )
        })}
      </div>
      {rows.filter((row) => row.id === active || visitedIds.has(row.id)).map((row) => (
        <div
          key={row.id}
          id={`${pageId}-panel-${row.id}`}
          className="dshMaint-panel"
          role="tabpanel"
          aria-labelledby={`${pageId}-tab-${row.id}`}
          hidden={row.id !== active}
        >
          {renderSlot(TAB_SLOT, {}, { only: row.id })}
        </div>
      ))}
    </section>
  )
}

/**
 * Page styles (class prefix dshMaint-), injected inline — the brand bundle has
 * no CSS pipeline. Metrics come from the kernel's own PluginsSettingsSection so
 * the strip sits at the native size and weight; alias-token colors only, so
 * both system schemes stay legible.
 */
const MAINTENANCE_CSS = `
.dshMaint-section { display: flex; flex-direction: column; gap: 12px; max-width: 760px; color: var(--dsw-alias-label-primary); }
.dshMaint-heading { margin: 0; font-size: 18px; font-weight: 600; }
.dshMaint-tabs { display: flex; align-items: flex-end; gap: 22px; margin-top: 2px; border-bottom: .5px solid var(--dsw-alias-border-l2); }
.dshMaint-tab { position: relative; padding: 7px 1px 9px; border: 0; background: 0 0; color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 13px; line-height: 20px; cursor: pointer; }
.dshMaint-tab:hover, .dshMaint-tab[data-active="true"] { color: var(--dsw-alias-label-primary); }
.dshMaint-tab[data-active="true"]::after, .dshMaint-tab:focus-visible::after { content: ""; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; border-radius: 2px 2px 0 0; background: var(--dsw-alias-label-primary); }
.dshMaint-tab:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; border-radius: 2px; color: var(--dsw-alias-label-primary); }
.dshMaint-panel { min-width: 0; padding-top: 2px; }
`
