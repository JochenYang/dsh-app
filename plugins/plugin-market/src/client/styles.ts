/**
 * Styles for the market entry + panel. Alias-token colors only (light/dark
 * both legible); id-guarded injection stays idempotent across mounts. Same
 * visual language as the other suite sections; class prefix `dshMkt-` keeps
 * the global CSS namespace collision-free.
 *
 * @module @dsh-app/plugin-market/client/styles
 */

const STYLE_ID = 'dsh-app-plugin-market-style'

const cssText = `
/* Sidebar-foot rows mirror the host's settings trigger (SettingsRoot.module.css):
 * wide = 42px row, radius 12, margin 4/-2, padding 0 10 0 8, 14px/22px text;
 * rail = 36px circle. Hover uses the shared interactive token on both. */
.dshMkt-rowBtn {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  width: calc(100% + 4px);
  height: 42px;
  margin: 4px -2px;
  padding: 0 10px 0 8px;
  border: none;
  border-radius: 12px;
  background: none;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 14px;
  line-height: 22px;
  cursor: pointer;
  text-align: left;
  overflow: hidden;
}
.dshMkt-rowBtn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshMkt-rowBtn > span { white-space: nowrap; overflow: hidden; }
.dshMkt-iconBtn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  margin: 8px 0 10px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: none;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
.dshMkt-iconBtn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshMkt-glyph { flex: none; }
.dshMkt-drawer {
  /* A right-edge drawer, not a modal: no page-wide dimming, so the workspace
   * stays readable behind it. It runs to the window's top edge on purpose:
   * the shell tints the native window-control strip by sampling the element
   * at the strip's top-right, so a drawer covering that point hands the strip
   * the drawer's own background — the two read as one continuous surface
   * instead of two bands. The strip's own buttons are painted over the
   * drawer's top 36px, which carries no controls. */
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 2147483646;
  display: flex;
  -webkit-app-region: no-drag;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  /* Transition, not keyframes: the same rule covers the exit (the component
   * flips the state class before unmounting), so entry and exit read alike. */
  transform: translateX(100%);
  opacity: .6;
  transition: transform .22s cubic-bezier(.22, 1, .36, 1), opacity .22s ease-out;
  will-change: transform;
}

.dshMkt-drawerOn {
  transform: translateX(0);
  opacity: 1;
}

.dshMkt-drawer * {
  -webkit-app-region: no-drag;
}

/* Collapse control: a handle centered on the drawer's left border. */
.dshMkt-handle {
  position: absolute;
  left: -22px;
  top: 50%;
  transform: translateY(-50%);
  width: 22px;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--dsw-alias-border-l1, rgba(15, 23, 42, 0.08));
  border-right: none;
  border-radius: 10px 0 0 10px;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-secondary, #64748b);
  box-shadow: -6px 0 16px rgba(0, 0, 0, .10);
  cursor: pointer;
}

.dshMkt-handle:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .05));
  color: var(--dsw-alias-label-primary, #0f172a);
}

.dshMkt-panel {
  display: flex;
  flex-direction: column;
  position: relative;
  box-sizing: border-box;
  width: 460px;
  max-width: calc(100vw - 48px);
  height: 100%;
  /* Clears the native window-control buttons, which paint over this band. */
  padding-top: 36px;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  border-left: 1px solid var(--dsw-alias-border-l1, rgba(15, 23, 42, 0.06));
  box-shadow: -14px 0 36px rgba(0, 0, 0, .14);
}
.dshMkt-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  /* The overlay sits below the native control strip (see the mask rule), so the
   * head keeps its natural spacing: no reserve is needed here. */
  padding: 10px 14px 10px 16px;
}
.dshMkt-title {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
  color: var(--dsw-alias-label-primary, #0f172a);
}
.dshMkt-tabs {
  display: flex;
  gap: 4px;
  padding: 0 16px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dshMkt-tab {
  position: relative;
  padding: 5px 12px;
  border: none;
  border-radius: 8px;
  background: none;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  cursor: pointer;
}
.dshMkt-tabOn {
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary-foreground);
  font-weight: 600;
}
/* Update badge pinned to the 已安装 tab's top-right corner: the tab label
 * already counts every installed package, so the pending-update backlog gets
 * its own corner signal instead of competing with that number in the text. */
.dshMkt-tabBadge {
  position: absolute;
  top: -2px;
  right: -3px;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--dsw-alias-state-error-primary, #dc2626);
  color: #ffffff;
  font-size: 10px;
  font-weight: 600;
  line-height: 15px;
  text-align: center;
}
.dshMkt-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 16px 16px;
}
.dshMkt-banner {
  padding: 8px 12px;
  border: 1px solid var(--dsw-alias-state-error-secondary);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-state-error-primary, #dc2626);
  font-size: 12.5px;
  line-height: 19px;
  word-break: break-word;
}
.dshMkt-noticeOk {
  padding: 8px 12px;
  border: 1px solid var(--dsw-alias-state-success-secondary, rgba(34, 197, 94, 0.35));
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-state-success-primary, #16a34a);
  font-size: 12.5px;
  line-height: 19px;
}
/* Status strip layout: text grows, close button hugs the corner, and the
 * collapsed log disclosure keeps long pnpm output from flooding the panel. */
.dshMkt-stripBody {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.dshMkt-stripText {
  flex: 1;
  min-width: 0;
  word-break: break-word;
}
.dshMkt-stripClose {
  flex: none;
  padding: 0 2px;
  border: none;
  background: none;
  color: inherit;
  font-size: 14px;
  line-height: 19px;
  opacity: 0.6;
  cursor: pointer;
}
.dshMkt-stripClose:hover { opacity: 1; }
.dshMkt-logToggle {
  margin-top: 6px;
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  font-size: 11.5px;
  text-decoration: underline;
  text-underline-offset: 3px;
  opacity: 0.85;
  cursor: pointer;
}
.dshMkt-logToggle:hover { opacity: 1; }
/* Blocked-builds bar inside a status strip: amber reads as pending-work (the
 * scripts still need approving), distinct from the strip's own ok/error tone. */
.dshMkt-blockedBar {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--dsw-alias-state-warning-secondary, rgba(234, 179, 8, 0.35));
}
.dshMkt-blockedBar > .dshMkt-stripText {
  color: var(--dsw-alias-state-warning-primary, #b45309);
}
.dshMkt-hint {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
.dshMkt-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2);
}
.dshMkt-cardHead {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
/* Row-1 action of a catalog card (install / update / installed badge) pinned
 * to the right edge, clear of a long wrapped title. */
.dshMkt-cardAction {
  margin-left: auto;
  flex: none;
}
/* Row-2 byline: 作者 · stars/30 天安装 · 分类, muted so the title leads. */
.dshMkt-cardByline {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
  line-height: 16px;
  word-break: break-word;
}
/* Bottom tag row: category chip + source-only + declared-version chips. */
.dshMkt-cardTags {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.dshMkt-pkgName {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  word-break: break-all;
}
.dshMkt-badge {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  background: rgba(148, 163, 184, 0.2);
  color: var(--dsw-alias-label-secondary);
}
.dshMkt-badgeOn {
  background: rgba(34, 197, 94, 0.16);
  color: var(--dsw-alias-state-success-primary, #16a34a);
}
.dshMkt-badgeOff {
  background: rgba(148, 163, 184, 0.14);
  color: var(--dsw-alias-label-tertiary);
}
/* "可更新 vX → vY" badge: amber reads as pending-work, not as an error. */
.dshMkt-badgeUpdate {
  background: rgba(234, 179, 8, 0.18);
  color: var(--dsw-alias-state-warning-primary, #b45309);
}
/* "同名不同源" badge: the same amber attention tone — a same-named install
 * exists but from another repo, so this entry's install is a replacement. */
.dshMkt-badgeWarn {
  background: rgba(234, 179, 8, 0.18);
  color: var(--dsw-alias-state-warning-primary, #b45309);
}
/* Badge + primary button pair inside the card action slot: the cross-origin
 * install keeps the warning and the action visible at the same time. */
.dshMkt-actionPair {
  display: flex;
  align-items: center;
  gap: 6px;
}
.dshMkt-desc {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
  word-break: break-word;
  /* Four-line clamp: the relaxed size keeps full feature copy readable while
   * a 3500-row directory stays scannable. */
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.dshMkt-meta {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
  word-break: break-all;
}
.dshMkt-cardFoot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
/* Catalog title as a repository link: underlines subtly, never steals focus
 * from the install action. */
.dshMkt-linkName {
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  font: inherit;
  text-align: left;
  text-decoration: underline dotted;
  text-underline-offset: 3px;
}
.dshMkt-linkName:hover { color: var(--dsw-alias-brand-primary); }
/* Request-level catalog failure block: the reload button is the first thing
 * the eye lands on (the top strip alone proved too easy to miss). */
.dshMkt-failBox {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 16px 14px;
  border: 1px solid var(--dsw-alias-state-error-secondary);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2);
}
.dshMkt-failTitle {
  margin: 0;
  color: var(--dsw-alias-state-error-primary, #dc2626);
  font-size: 13.5px;
  font-weight: 600;
}
.dshMkt-failReason {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  word-break: break-all;
}
.dshMkt-bannerActions {
  display: flex;
  justify-content: flex-end;
  margin-top: 6px;
}
/* Installed-row enable/disable switch (track + thumb, alias-token colors). */
.dshMkt-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-right: auto;
  padding: 3px 6px;
  border: none;
  background: none;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  cursor: pointer;
}
.dshMkt-switch:disabled { opacity: 0.5; cursor: not-allowed; }
.dshMkt-switchTrack {
  position: relative;
  flex: none;
  width: 28px;
  height: 16px;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.4);
  transition: background 0.15s;
}
.dshMkt-switchOn .dshMkt-switchTrack { background: var(--dsw-alias-brand-primary); }
.dshMkt-switchThumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #ffffff;
  transition: transform 0.15s;
}
.dshMkt-switchOn .dshMkt-switchThumb {
  transform: translateX(12px);
  /* The ON track is brand-primary, which the dsh dark theme maps to a
     near-white surface (not an accent) — a white thumb on it is invisible.
     The knob takes the layer colour instead, exactly like the memory
     plugin's toggle: near-black knob on the light track, white on the dark. */
  background: var(--dsw-alias-bg-layer-1, #ffffff);
}
.dshMkt-button {
  padding: 5px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: none;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  font-size: 12px;
}
.dshMkt-button:disabled { opacity: 0.5; cursor: not-allowed; }
.dshMkt-buttonPrimary {
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary-foreground);
  border-color: transparent;
  font-weight: 600;
}
.dshMkt-buttonDanger { color: var(--dsw-alias-state-error-primary, #dc2626); }
/* Confirm-dialog pair on the neutral system: install = white emphasized
 * (white surface, dark label, hairline border, faint gray hover); uninstall =
 * the dark inverted half. Deliberately no red — install is not destructive. */
.dshMkt-buttonNeutral {
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-primary, #0f172a);
  border-color: var(--dsw-alias-border-l2);
  font-weight: 600;
}
.dshMkt-buttonNeutral:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(15, 23, 42, 0.04));
}
.dshMkt-buttonDark {
  background: var(--dsw-alias-label-primary, #0f172a);
  color: var(--dsw-alias-bg-layer-1, #ffffff);
  border-color: transparent;
  font-weight: 600;
}
.dshMkt-buttonDark:hover:not(:disabled) {
  background: var(--dsw-alias-label-secondary, #334155);
}
.dshMkt-input {
  box-sizing: border-box;
  flex: 1 1 200px;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-size: 12.5px;
}
.dshMkt-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
/* Catalog filter row: search grows, the category select keeps its natural width. */
.dshMkt-filters {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.dshMkt-select {
  flex: 0 0 auto;
  max-width: 180px;
}
.dshMkt-rowBetween {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.dshMkt-headActions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.dshMkt-sourceUrl {
  font-size: 12px;
  color: var(--dsw-alias-label-primary);
  word-break: break-all;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}
/* Inherit row: offers the packages the previous profile declares and this one
   lacks — shown after the shell moved the suite to a profile of its own. */
.dshMkt-inherit {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  margin-bottom: 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2);
}
.dshMkt-inheritText {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12.5px;
  color: var(--dsw-alias-label-primary);
}
.dshMkt-empty {  padding: 18px 12px;
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: 10px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  line-height: 20px;
  text-align: center;
}
.dshMkt-log {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  line-height: 17px;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 140px;
  overflow-y: auto;
}
.dshMkt-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: dshMkt-spin 0.8s linear infinite;
  vertical-align: -1px;
}
@keyframes dshMkt-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .dshMkt-spinner { animation: none; }
  .dshMkt-drawer { transition: none; }
  .dshMkt-switchTrack, .dshMkt-switchThumb { transition: none; }
}
/* Confirmation modal — the React port of the shell's in-frame dialog idiom
 * (same mask/card idiom the other suite sections use). */
.dshMkt-dialogWrap {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, .35);
}
.dshMkt-dialogCard {
  width: 340px;
  max-width: calc(100vw - 48px);
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  border: 1px solid var(--dsw-alias-border-l1, rgba(15, 23, 42, 0.06));
  border-radius: 12px;
  padding: 20px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, .28);
}
.dshMkt-dialogTitle {
  font-size: 15px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #0f172a);
  margin-bottom: 6px;
}
.dshMkt-dialogMessage {
  font-size: 13px;
  color: var(--dsw-alias-label-secondary, #475569);
  line-height: 1.6;
  word-break: break-word;
}
.dshMkt-dialogActions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 16px;
}
`

/** Inject once per document (id-guarded, safe across HMR re-mounts). */
export function adoptStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = cssText
  document.head.append(style)
}

