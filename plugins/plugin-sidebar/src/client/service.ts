/**
 * The ctx.dshAppSidebar registration service — the third-party extension
 * surface of the sidebar dock. Other dsh client plugins resolve this
 * service and register dock pages ("tabs") or extra file previewers;
 * built-in pages register through the exact same API, so the dock ships
 * with no private path of its own.
 *
 * M1 scope: the registration API + the built-in file tree tab. Terminal,
 * git and subagent pages (M2+) are further registrants.
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

/** Identity of one dock page (tab). */
export interface SidebarTabOptions {
  /** Stable tab key; duplicates replace (re-registration = HMR-friendly). */
  id: string
  /** Icon column order; built-ins occupy 10/20/…, third parties use 100+. */
  order?: number
  /** Tab-localized display text. */
  label?: string
}

/** One registered dock page. */
export interface SidebarTab {
  options: SidebarTabOptions
  /** The tab's React component. */
  component: unknown
}

/** Identity of one file viewer registration. */
export interface FileViewerOptions {
  /** File extensions covered, lowercase without the dot (e.g. ['svg']). */
  extensions: readonly string[]
  /** Viewer order within covered extensions; higher wins. */
  order?: number
}

/** One registered file viewer. */
export interface FileViewer {
  options: FileViewerOptions
  /** Receives the absolute path; renders the preview body. */
  component: unknown
}

/**
 * The dock's registration service. Registrations are stored, not rendered:
 * the dock React tree reads the live registries through {@link onChange},
 * so re-registration (HMR/plugin reload) just replaces the entry.
 */
export class DshAppSidebarService extends Service {
  /** Live tab registry in registration order. */
  readonly tabs = new Map<string, SidebarTab>()
  /** Live viewer registry keyed by registration id. */
  readonly viewers = new Map<string, FileViewer>()
  private readonly listeners = new Set<() => void>()

  constructor(ctx: Context) {
    super(ctx, 'dshAppSidebar')
  }

  /** Observe registration changes (returns the disposer). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private fire(): void {
    for (const listener of this.listeners) listener()
  }

  /**
   * Register (or replace) one dock page.
   * @param options - the tab identity.
   * @param component - the tab's React component.
   * @returns the disposer removing the registration.
   */
  registerTab(options: SidebarTabOptions, component: unknown): () => void {
    this.tabs.set(options.id, { options, component })
    this.fire()
    return () => {
      this.tabs.delete(options.id)
      this.fire()
    }
  }

  /**
   * Register (or replace) one file viewer.
   * @param options - the covered extensions.
   * @param component - the viewer component.
   * @returns the disposer removing the registration.
   */
  registerFileViewer(options: FileViewerOptions, component: unknown): () => void {
    const id = options.extensions.join('+')
    this.viewers.set(id, { options, component })
    this.fire()
    return () => {
      this.viewers.delete(id)
      this.fire()
    }
  }
}
