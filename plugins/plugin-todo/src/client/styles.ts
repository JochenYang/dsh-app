/**
 * The todo plugin's stylesheet, adopted once per renderer.
 *
 * @module @dsh-app/plugin-todo/client/styles
 */

const STYLE_ID = 'dsh-app-plugin-todo-style'

export const CSS = `
.dshTodo-view,
.dshTodo-card,
.dshTodo-dayPanelBody,
.dshTodo-reminderToast {
  --dshTodo-text: var(--dsw-alias-label-primary);
  --dshTodo-text-2: var(--dsw-alias-label-secondary);
  --dshTodo-line: var(--dsw-alias-border-l1);
  --dshTodo-line-2: var(--dsw-alias-border-l2);
  --dshTodo-surface: var(--dsw-alias-bg-layer-1);
  --dshTodo-hover: var(--dsw-alias-interactive-bg-hover);
  --dshTodo-track: color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent);
  --dshTodo-done: var(--dsw-alias-state-success-primary);
  --dshTodo-done-wash: color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent);
  --dshTodo-warn: var(--dsw-alias-state-warn-primary);
  --dshTodo-warn-wash: var(--dsw-alias-state-warn-tertiary);
  --dshTodo-error: var(--dsw-alias-state-error-primary);
  --dshTodo-r-sm: var(--dsw-radius-xs);
  --dshTodo-r-md: var(--dsw-radius-sm);
  --dshTodo-r-lg: var(--dsw-radius-md);
  --dshTodo-s1: 4px;
  --dshTodo-s2: 8px;
  --dshTodo-s3: 12px;
  --dshTodo-s4: 16px;
  --dshTodo-s8: 32px;
  --dshTodo-fs-xs: 11px;
  --dshTodo-lh-xs: 16px;
  --dshTodo-fs-s: 12px;
  --dshTodo-lh-s: 18px;
  --dshTodo-fs-m: 13px;
  --dshTodo-lh-m: 20px;
  --dshTodo-fs-l: 15px;
  --dshTodo-lh-l: 22px;
  --dshTodo-fs-xl: 20px;
  --dshTodo-lh-xl: 28px;
  --dshTodo-fs-figure: 32px;
  --dshTodo-lh-figure: 36px;
}

.dshTodo-card:focus-visible,
.dshTodo-day:focus-visible,
.dshTodo-rowRemove:focus-visible,
.dshTodo-groupHeadBtn:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dshTodo-done);
  outline-offset: 2px;
}

.dshTodo-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--dshTodo-s3);
  width: 100%;
  min-width: 0;
  color: var(--dshTodo-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  background-image:
    radial-gradient(circle at 86% 22%, color-mix(in srgb, var(--dshTodo-done) 14%, transparent) 0%, transparent 58%),
    linear-gradient(155deg, transparent 60%, color-mix(in srgb, var(--dshTodo-done) 4%, transparent) 100%);
}
.dshTodo-cardDeco {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  overflow: hidden;
}
.dshTodo-cardHalo {
  position: absolute;
  top: -20px;
  right: -10px;
  width: 130px;
  height: 130px;
  border-radius: 999px;
  background: radial-gradient(circle, rgba(255, 208, 90, 0.28) 0%, color-mix(in srgb, var(--dshTodo-done) 14%, transparent) 45%, transparent 70%);
  filter: blur(12px);
  opacity: 0.8;
}
.dshTodo-cardSun {
  position: absolute;
  top: 14px;
  right: 56px;
  width: 32px;
  height: 32px;
  pointer-events: none;
  filter: drop-shadow(0 2px 8px rgba(255, 174, 51, 0.28));
  animation: dshTodo-sunRotate 24s linear infinite;
}
@keyframes dshTodo-sunRotate {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.dshTodo-cardHill {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 48px;
  width: 100%;
  pointer-events: none;
}
.dshTodo-cardHillFront {
  fill: color-mix(in srgb, var(--dshTodo-done) 8.5%, transparent);
}
.dshTodo-cardHillBack {
  fill: color-mix(in srgb, var(--dshTodo-done) 4%, transparent);
}
.dshTodo-cardHead,
.dshTodo-cardMain,
.dshTodo-cardWarn,
.dshTodo-cardWeek {
  position: relative;
  z-index: 1;
}
.dshTodo-cardHead {
  display: flex;
  align-items: center;
  gap: var(--dshTodo-s2);
  min-width: 0;
}
.dshTodo-cardMark {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--dshTodo-r-md);
  background: var(--dshTodo-hover);
  color: var(--dshTodo-text);
}
.dshTodo-cardMark > svg {
  display: block;
}
.dshTodo-cardTitle {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--dshTodo-fs-m);
  line-height: var(--dshTodo-lh-m);
  font-weight: 600;
}
.dshTodo-cardDate {
  flex: none;
  white-space: nowrap;
  font-size: var(--dshTodo-fs-xs);
  line-height: var(--dshTodo-lh-xs);
  color: var(--dshTodo-text-2);
  font-variant-numeric: tabular-nums;
}
.dshTodo-cardMain {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--dshTodo-s3);
  min-height: 52px;
}
.dshTodo-cardFigures {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.dshTodo-cardFigure {
  font-size: var(--dshTodo-fs-figure);
  line-height: var(--dshTodo-lh-figure);
  font-weight: 600;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
  color: var(--dshTodo-text);
}
.dshTodo-cardHeadline {
  font-size: var(--dshTodo-fs-l);
  line-height: var(--dshTodo-lh-l);
  font-weight: 600;
  color: var(--dshTodo-text);
}
.dshTodo-cardLabel {
  margin-top: 2px;
  font-size: var(--dshTodo-fs-m);
  line-height: var(--dshTodo-lh-m);
  color: var(--dshTodo-text-2);
}
.dshTodo-cardError {
  font-size: var(--dshTodo-fs-m);
  line-height: var(--dshTodo-lh-m);
  color: var(--dshTodo-text);
}
.dshTodo-cardError::before {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 6px;
  vertical-align: middle;
  border-radius: 999px;
  background: var(--dshTodo-error);
}
.dshTodo-ring {
  position: relative;
  display: block;
  flex: none;
  width: 44px;
  height: 44px;
}
.dshTodo-ring > svg {
  position: absolute;
  inset: 0;
  overflow: visible;
}
.dshTodo-ringTrack {
  fill: none;
  stroke: var(--dshTodo-track);
  stroke-width: 4;
}
.dshTodo-ringFill {
  fill: none;
  stroke: var(--dshTodo-done);
  stroke-width: 4;
  stroke-linecap: round;
  transform: rotate(-90deg);
  transform-origin: 22px 22px;
  transition: stroke-dashoffset .3s ease;
}
.dshTodo-ringText {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--dshTodo-fs-xs);
  line-height: 1;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--dshTodo-text);
}
.dshTodo-cardWarn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  height: 22px;
  padding: 0 var(--dshTodo-s2);
  border-radius: 999px;
  background: var(--dshTodo-warn-wash);
  color: var(--dshTodo-text);
  font-size: var(--dshTodo-fs-xs);
  line-height: 22px;
}
.dshTodo-warnDot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--dshTodo-warn);
}
.dshTodo-cardWeek {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 6px;
}
.dshTodo-cardWeekCol {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--dshTodo-s1);
  min-width: 0;
}
.dshTodo-cardWeekTrack {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  width: 100%;
  height: 28px;
  border-bottom: 1px solid var(--dshTodo-line-2);
}
.dshTodo-cardWeekBar {
  display: block;
  width: 56%;
  border-radius: var(--dshTodo-r-sm) var(--dshTodo-r-sm) 0 0;
  background: var(--dshTodo-done);
  transition: height .3s ease;
}
.dshTodo-cardWeekLetter {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--dshTodo-fs-xs);
  line-height: var(--dshTodo-lh-xs);
  color: var(--dshTodo-text-2);
}
.dshTodo-cardWeekCol[data-today='true'] .dshTodo-cardWeekLetter {
  color: var(--dshTodo-text);
  font-weight: 600;
}

.dshTodo-skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--dshTodo-s2);
  width: 100%;
}
.dshTodo-skeletonBar {
  display: block;
  width: 72px;
  height: 12px;
  border-radius: var(--dshTodo-r-sm);
  background: var(--dshTodo-track);
}
.dshTodo-skeletonFigure {
  width: 64px;
  height: 32px;
}
.dshTodo-skeletonShort {
  width: 96px;
}
.dshTodo-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

.dshTodo-view {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--dshTodo-s8);
  min-width: 0;
  padding-bottom: 76px;
  color: var(--dshTodo-text);
}
.dshTodo-masthead {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--dshTodo-s3);
}
.dshTodo-masthead::after {
  content: '';
  position: absolute;
  bottom: 8px;
  right: 12px;
  width: 140px;
  height: 120px;
  border-radius: 999px;
  background: radial-gradient(circle, color-mix(in srgb, var(--dshTodo-done) 22%, transparent) 0%, transparent 70%);
  pointer-events: none;
  z-index: 0;
}
.dshTodo-mastArt {
  position: absolute;
  bottom: 14px;
  right: 0;
  width: 132px;
  height: auto;
  pointer-events: none;
  user-select: none;
}
.dshTodo-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--dshTodo-s4);
  padding-right: 148px;
}
@media (max-width: 720px) {
  .dshTodo-mastArt { width: 96px; bottom: 12px; }
  .dshTodo-head { padding-right: 108px; }
}

.dshTodo-headText {
  min-width: 0;
}
.dshTodo-title {
  display: flex;
  align-items: center;
  gap: var(--dshTodo-s2);
  margin: 0;
  font-size: var(--dshTodo-fs-xl);
  line-height: var(--dshTodo-lh-xl);
  font-weight: 600;
}
.dshTodo-titleMark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: var(--dshTodo-r-md);
  background: color-mix(in srgb, var(--dshTodo-done) 12%, transparent);
  color: var(--dshTodo-done);
}
.dshTodo-sub {
  margin: 2px 0 0;
  font-size: var(--dshTodo-fs-m);
  line-height: var(--dshTodo-lh-m);
  color: var(--dshTodo-text-2);
}
.dshTodo-headBadge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 12px 0 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--dshTodo-text) 4%, var(--dshTodo-surface));
  border: 1px solid var(--dshTodo-line-2);
  font-size: var(--dshTodo-fs-s);
  line-height: 28px;
  color: var(--dshTodo-text);
  font-variant-numeric: tabular-nums;
  transition: background-color .2s ease, border-color .2s ease, box-shadow .2s ease, color .2s ease;
}
.dshTodo-headBadgeDot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--dshTodo-done);
}
.dshTodo-headBadgeIcon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--dshTodo-done);
}
.dshTodo-headBadge[data-completed='true'] {
  background: var(--dshTodo-done-wash);
  border-color: color-mix(in srgb, var(--dshTodo-done) 40%, transparent);
  color: var(--dshTodo-done);
  font-weight: 600;
  box-shadow: 0 2px 8px color-mix(in srgb, var(--dshTodo-done) 18%, transparent);
}
.dshTodo-headBadgeText {
  white-space: nowrap;
}
.dshTodo-meter {
  position: relative;
  height: 6px;
  border-radius: 999px;
  background: var(--dshTodo-track);
  overflow: hidden;
}
@keyframes dshTodo-shimmer {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}
/* The completion sweep, once. 1.4s with an eased curve and a 200ms delay: at 500ms
   it was a flash nobody caught, and starting immediately ran it underneath the fill's
   own 300ms width transition, so half the sweep happened before the bar it decorates
   had arrived. */
.dshTodo-meter[data-completed='true']::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.45), transparent);
  transform: translateX(-100%);
  animation: dshTodo-shimmer 1400ms ease-in-out 200ms forwards;
}
.dshTodo-meterFill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--dshTodo-done);
  transition: width .3s ease;
}
@keyframes dshTodo-breath {
  0%, 100% { filter: brightness(1); }
  50% { filter: brightness(1.18); }
}
/* A completed bar keeps a slow breath instead of a running highlight. A light
   travelling along a bar is the idiom for "still working", which is the one thing a
   finished bar is not; a 3.6s swell reads as "done, at rest". The sweep above still
   fires once at the moment of completion — that is the announcement, this is the
   state. */
.dshTodo-meter[data-completed='true'] .dshTodo-meterFill {
  animation: dshTodo-breath 3600ms ease-in-out infinite;
}

.dshTodo-today {
  display: flex;
  flex-direction: column;
  gap: var(--dshTodo-s3);
  min-width: 0;
}
.dshTodo-sectionTitle {
  display: flex;
  align-items: center;
  gap: var(--dshTodo-s2);
  margin: 0;
  font-size: var(--dshTodo-fs-l);
  line-height: var(--dshTodo-lh-l);
  font-weight: 600;
  color: var(--dshTodo-text);
}
.dshTodo-sectionTitle::before {
  content: '';
  flex: none;
  width: 3px;
  height: 14px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--dshTodo-done) 60%, transparent);
}
.dshTodo-add {
  display: flex;
  align-items: center;
  gap: var(--dshTodo-s2);
}
.dshTodo-addInput {
  flex: 1 1 auto;
  min-width: 0;
}
.dshTodo-addInput:focus-within,
.dshTodo-reminderCustomInput:focus-within {
  border-color: var(--dshTodo-done) !important;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--dshTodo-done) 35%, transparent);
}
.dshTodo-notice {
  display: flex;
  align-items: center;
  gap: var(--dshTodo-s3);
  min-height: 32px;
  font-size: var(--dshTodo-fs-m);
  line-height: var(--dshTodo-lh-m);
  color: var(--dshTodo-text);
}
.dshTodo-notice::before {
  content: '';
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--dshTodo-error);
}
.dshTodo-notice > span {
  flex: 1 1 auto;
  min-width: 0;
}
.dshTodo-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--dshTodo-s2);
  margin: 0;
  padding: var(--dshTodo-s8) var(--dshTodo-s4);
  border: 1px dashed var(--dshTodo-line-2);
  border-radius: var(--dshTodo-r-lg);
  text-align: center;
}
.dshTodo-emptyMark {
  display: inline-flex;
  color: color-mix(in srgb, var(--dshTodo-text-2) 55%, transparent);
}
.dshTodo-emptyText {
  margin: 0;
  font-size: var(--dshTodo-fs-m);
  line-height: var(--dshTodo-lh-m);
  color: var(--dshTodo-text-2);
}
.dshTodo-group {
  overflow: hidden;
  border: 1px solid var(--dshTodo-line-2);
  border-radius: var(--dshTodo-r-lg);
  background: var(--dshTodo-surface);
}
.dshTodo-groupHead {
  margin: 0;
  padding: 10px var(--dshTodo-s4) 6px;
  font-size: var(--dshTodo-fs-s);
  line-height: var(--dshTodo-lh-s);
  font-weight: 500;
  color: var(--dshTodo-text-2);
  font-variant-numeric: tabular-nums;
}
.dshTodo-groupHeadBtn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  margin: 0;
  padding: 10px var(--dshTodo-s4) 8px;
  border: 0;
  background: transparent;
  font: inherit;
  font-size: var(--dshTodo-fs-s);
  line-height: var(--dshTodo-lh-s);
  font-weight: 500;
  color: var(--dshTodo-text-2);
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  text-align: left;
  transition: color .15s ease, background-color .15s ease;
}
.dshTodo-groupHeadBtn:hover {
  background: var(--dshTodo-hover);
  color: var(--dshTodo-text);
}
.dshTodo-groupHeadIcon {
  display: inline-flex;
  align-items: center;
  color: var(--dshTodo-text-2);
  transition: transform .2s ease, color .15s ease;
}
.dshTodo-groupHeadBtn:hover .dshTodo-groupHeadIcon {
  color: var(--dshTodo-done);
}
.dshTodo-groupHeadIcon[data-expanded='true'] {
  transform: rotate(180deg);
}
.dshTodo-groupMoreWrap {
  padding: 4px var(--dshTodo-s4) 8px;
  border-top: 1px solid var(--dshTodo-line);
}
.dshTodo-list {
  list-style: none;
  margin: 0;
  padding: 0 0 4px;
}
.dshTodo-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  padding: 0 var(--dshTodo-s2) 0 var(--dshTodo-s4);
}
.dshTodo-row + .dshTodo-row {
  border-top: 1px solid var(--dshTodo-line);
}
.dshTodo-row:hover {
  background: var(--dshTodo-hover);
}
.dshTodo-rowCheck {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--dshTodo-fs-m);
  line-height: var(--dshTodo-lh-m);
}
.dshTodo-rowCheck > span {
  min-width: 0;
  overflow-wrap: anywhere;
  transition: color .15s ease, opacity .15s ease;
}
.dshTodo-row[data-done='true'] .dshTodo-rowCheck > span {
  color: var(--dshTodo-text-2);
  text-decoration: line-through;
}
.dshTodo-tag {
  flex: none;
  height: 20px;
  padding: 0 var(--dshTodo-s2);
  border-radius: 999px;
  background: var(--dshTodo-warn-wash);
  color: var(--dshTodo-text);
  font-size: var(--dshTodo-fs-xs);
  line-height: 20px;
}
.dshTodo-rowRemove {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: var(--dshTodo-r-md);
  background: transparent;
  color: var(--dshTodo-text-2);
  font: inherit;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity .12s ease, background-color .12s ease;
}
.dshTodo-rowRemove svg {
  width: 14px;
  height: 14px;
}
.dshTodo-row:hover .dshTodo-rowRemove,
.dshTodo-row:focus-within .dshTodo-rowRemove,
.dshTodo-rowRemove:focus-visible {
  opacity: 1;
}
.dshTodo-rowRemove:hover {
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dshTodo-text);
}
.dshTodo-rowRemove:disabled {
  cursor: default;
  opacity: .4;
}
@media (hover: none) {
  .dshTodo-rowRemove {
    opacity: 1;
  }
}

.dshTodo-stats {
  display: flex;
  flex-direction: column;
  gap: var(--dshTodo-s4);
  min-width: 0;
}
.dshTodo-statsHead {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--dshTodo-s3);
}
.dshTodo-week,
.dshTodo-month,
.dshTodo-year {
  display: flex;
  flex-direction: column;
  gap: var(--dshTodo-s3);
  min-width: 0;
}
.dshTodo-faceHead {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--dshTodo-s2) var(--dshTodo-s3);
}
.dshTodo-faceTitle {
  margin: 0;
  font-size: var(--dshTodo-fs-m);
  line-height: var(--dshTodo-lh-m);
  font-weight: 600;
  color: var(--dshTodo-text);
}
.dshTodo-summary {
  margin: 0;
  font-size: var(--dshTodo-fs-s);
  line-height: var(--dshTodo-lh-s);
  color: var(--dshTodo-text-2);
  font-variant-numeric: tabular-nums;
}

.dshTodo-agenda {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--dshTodo-line-2);
  border-radius: var(--dshTodo-r-lg);
  background: var(--dshTodo-surface);
}
.dshTodo-agendaRow {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr) 112px;
  align-items: start;
  gap: var(--dshTodo-s3);
  padding: var(--dshTodo-s3) var(--dshTodo-s4);
}
.dshTodo-agendaRow + .dshTodo-agendaRow {
  border-top: 1px solid var(--dshTodo-line);
}
.dshTodo-agendaRow[data-today='true'] {
  background: color-mix(in srgb, var(--dshTodo-text) 3%, var(--dshTodo-surface));
}
.dshTodo-agendaDay {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.dshTodo-agendaWeekday {
  font-size: var(--dshTodo-fs-xs);
  line-height: var(--dshTodo-lh-xs);
  color: var(--dshTodo-text-2);
}
.dshTodo-agendaDate {
  white-space: nowrap;
  font-size: var(--dshTodo-fs-m);
  line-height: var(--dshTodo-lh-m);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--dshTodo-text);
}
.dshTodo-agendaRow[data-today='true'] .dshTodo-agendaWeekday {
  color: var(--dshTodo-text);
  font-weight: 600;
}
.dshTodo-agendaBody {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  padding-top: 2px;
}
.dshTodo-agendaNote {
  font-size: var(--dshTodo-fs-s);
  line-height: var(--dshTodo-lh-s);
  color: var(--dshTodo-text-2);
}
.dshTodo-agendaExpandBtn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  align-self: flex-start;
  margin-top: 2px;
  padding: 3px 8px;
  border: 1px solid var(--dshTodo-line-2);
  border-radius: var(--dshTodo-r-sm);
  background: color-mix(in srgb, var(--dshTodo-text) 2.5%, var(--dshTodo-surface));
  color: var(--dshTodo-text-2);
  font: inherit;
  font-size: var(--dshTodo-fs-xs);
  line-height: 1;
  font-weight: 500;
  cursor: pointer;
  transition: background-color .15s ease, border-color .15s ease, color .15s ease;
}
.dshTodo-agendaExpandBtn:hover {
  background: var(--dshTodo-hover);
  border-color: var(--dshTodo-done);
  color: var(--dshTodo-text);
}
.dshTodo-agendaExpandIcon {
  display: inline-flex;
  align-items: center;
  color: var(--dshTodo-text-2);
  transition: transform .2s ease;
}
.dshTodo-agendaExpandBtn:hover .dshTodo-agendaExpandIcon {
  color: var(--dshTodo-done);
}
.dshTodo-agendaExpandIcon[data-expanded='true'] {
  transform: rotate(180deg);
}
.dshTodo-agendaCount {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  width: 106px;
  box-sizing: border-box;
  padding: 6px 10px 8px;
  border-radius: var(--dshTodo-r-md);
  background: color-mix(in srgb, var(--dshTodo-text) 2.5%, var(--dshTodo-surface));
  border: 1px solid var(--dshTodo-line);
  align-self: flex-start;
  transition: background-color .2s ease, border-color .2s ease;
}
.dshTodo-agendaCount[data-completed='true'] {
  background: var(--dshTodo-done-wash);
  border-color: color-mix(in srgb, var(--dshTodo-done) 28%, transparent);
}
.dshTodo-agendaCountHead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px;
}
.dshTodo-agendaFigure {
  font-size: var(--dshTodo-fs-s);
  line-height: var(--dshTodo-lh-s);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--dshTodo-text);
}
.dshTodo-agendaFigure > span {
  font-weight: 400;
  color: var(--dshTodo-text-2);
}
.dshTodo-agendaPercent {
  font-size: var(--dshTodo-fs-xs);
  line-height: 1;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--dshTodo-text-2);
}
.dshTodo-agendaCount[data-completed='true'] .dshTodo-agendaPercent {
  color: var(--dshTodo-done);
}
.dshTodo-tally {
  display: block;
  width: 100%;
  height: 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--dshTodo-text) 8%, var(--dshTodo-surface));
  overflow: hidden;
}
.dshTodo-tallyFill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--dshTodo-done);
  transition: width .25s ease;
}

.dshTodo-cal {
  display: flex;
  flex-direction: column;
  gap: var(--dshTodo-s2);
}
.dshTodo-calHead,
.dshTodo-calGrid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: var(--dshTodo-s2);
}
.dshTodo-calGrid > * {
  display: flex;
  min-width: 0;
}
.dshTodo-calHead {
  padding: 0 var(--dshTodo-s2);
  text-align: center;
  font-size: var(--dshTodo-fs-s);
  line-height: var(--dshTodo-lh-s);
  font-weight: 500;
  color: var(--dshTodo-text-2);
}

.dshTodo-day {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--dshTodo-s1);
  width: 100%;
  min-width: 0;
  min-height: 92px;
  padding: var(--dshTodo-s2);
  border: 1px solid var(--dshTodo-line-2);
  border-radius: 12px;
  background: var(--dshTodo-surface);
  color: inherit;
  font: inherit;
  text-align: center;
  overflow: hidden;
  cursor: pointer;
  transition: background-color .16s ease, border-color .16s ease, box-shadow .16s ease;
}
.dshTodo-day:hover {
  background: color-mix(in srgb, var(--dshTodo-text) 3%, var(--dshTodo-surface));
  border-color: color-mix(in srgb, var(--dshTodo-text) 20%, transparent);
  box-shadow: 0 2px 8px color-mix(in srgb, var(--dshTodo-text) 4%, transparent);
}
/* The weekday sits above the date as a quiet caption: it names the number without
   competing with it, and it is the one thing that stops a 92px card looking empty. */
.dshTodo-dayWeek {
  font-size: var(--dshTodo-fs-xs);
  line-height: var(--dshTodo-lh-xs);
  color: var(--dshTodo-text-2);
  letter-spacing: .02em;
}
.dshTodo-day[data-today='true'] .dshTodo-dayWeek {
  color: var(--dshTodo-text);
}
.dshTodo-dayNum {
  font-size: 18px;
  line-height: 1;
  font-weight: 750;
  font-variant-numeric: tabular-nums;
  color: var(--dshTodo-text);
}
.dshTodo-day[data-outside='true'] .dshTodo-dayNum {
  color: color-mix(in srgb, var(--dshTodo-text) 34%, transparent);
}
.dshTodo-day[data-outside='true'] .dshTodo-chip {
  opacity: .55;
}
.dshTodo-day[data-today='true'] {
  background: color-mix(in srgb, var(--dshTodo-done) 10%, var(--dshTodo-surface));
  border: 1.5px solid var(--dshTodo-done);
}
@keyframes dshTodo-todayPop {
  0% { transform: scale(0.88); opacity: 0.7; }
  100% { transform: scale(1); opacity: 1; }
}
.dshTodo-day[data-today='true'] .dshTodo-dayNum {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 24px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--dshTodo-done);
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
  animation: dshTodo-todayPop 220ms cubic-bezier(0.16, 1, 0.3, 1);
}
.dshTodo-day[data-selected='true'] {
  border: 1.5px solid var(--dshTodo-done);
  box-shadow: inset 0 0 0 1px var(--dshTodo-done);
}
.dshTodo-dayTasks {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  margin-top: auto;
  text-align: left;
}
.dshTodo-dayTasks .dshTodo-chip {
  min-height: 18px;
  padding: 0 4px;
  background: transparent;
  box-shadow: none;
}
.dshTodo-dayTasks .dshTodo-chip[data-done='true'] {
  background: transparent;
  box-shadow: none;
}
/* Only the SIZE is overridden inside a day card. Filling the glyph here flattened the
   one thing it exists to say: an open task is a hollow ring and a finished one is a
   solid dot, so a rule that paints every glyph in the cell drew "done" on work that
   was not. The fill comes from the data-done rule further down. */
.dshTodo-dayTasks .dshTodo-chip .dshTodo-glyph {
  width: 6px;
  height: 6px;
}
.dshTodo-dayCount {
  align-self: flex-end;
  font-size: var(--dshTodo-fs-xs);
  line-height: var(--dshTodo-lh-xs);
  color: var(--dshTodo-text-2);
  font-variant-numeric: tabular-nums;
}
.dshTodo-dayMore {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  height: 16px;
  padding: 0 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--dshTodo-text) 8%, var(--dshTodo-surface));
  font-size: 10px;
  line-height: 16px;
  font-weight: 500;
  color: var(--dshTodo-text-2);
}
.dshTodo-dayCounts {
  align-self: flex-start;
  margin-top: auto;
  height: 20px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--dshTodo-done-wash);
  color: var(--dshTodo-text);
  font-size: var(--dshTodo-fs-xs);
  line-height: 20px;
}
.dshTodo-day .dshTodo-chip[data-done='true'] .dshTodo-chipText {
  text-decoration: none;
}

.dshTodo-dayPanelModal {
  gap: 0;
  overflow: visible !important;
  position: relative;
}
.dshTodo-dayPanelModal [class*="header"] {
  padding: 18px 14px 8px 24px;
}
.dshTodo-dayPanelModal [class*="content"] {
  overflow: visible !important;
}
.dshTodo-dayPanelModal [class*="body"] {
  margin-top: 0;
  padding: 0 24px 12px;
  overflow: visible !important;
}
.dshTodo-dayPanelModal .dshTodo-add .dshTodo-reminderPickerWrapper {
  position: static;
}
.dshTodo-dayPanelModal .dshTodo-add .dshTodo-reminderPopover {
  position: absolute;
  top: calc(100% + 8px) !important;
  bottom: auto !important;
  left: 0 !important;
  right: 0 !important;
  width: auto !important;
  max-width: none !important;
  border-radius: var(--dshTodo-r-lg);
  box-shadow: 0 16px 36px color-mix(in srgb, var(--dshTodo-text) 16%, transparent);
}
.dshTodo-dayPanelBody {
  display: flex;
  flex-direction: column;
  gap: var(--dshTodo-s3);
  font-size: var(--dshTodo-fs-m);
  line-height: var(--dshTodo-lh-m);
  color: var(--dshTodo-text);
}
.dshTodo-dayPanelEmptyCard {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--dshTodo-s2);
  padding: 28px var(--dshTodo-s4);
  border-radius: var(--dshTodo-r-lg);
  background: color-mix(in srgb, var(--dshTodo-text) 2.5%, var(--dshTodo-surface));
  border: 1px dashed var(--dshTodo-line-2);
  text-align: center;
}
.dshTodo-dayPanelEmptyIcon {
  color: color-mix(in srgb, var(--dshTodo-text-2) 60%, transparent);
}
.dshTodo-dayPanelEmpty {
  margin: 0;
  font-size: var(--dshTodo-fs-m);
  line-height: var(--dshTodo-lh-m);
  color: var(--dshTodo-text-2);
}
.dshTodo-dayPanelList {
  margin: 0 -24px;
  border-top: 1px solid var(--dshTodo-line);
}
.dshTodo-addInput input {
  font-size: var(--dshTodo-fs-m);
  line-height: var(--dshTodo-lh-m);
}

.dshTodo-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: var(--dshTodo-s3) 40px;
  margin: 0;
}
.dshTodo-metrics > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.dshTodo-metrics dt {
  margin: 0;
  font-size: var(--dshTodo-fs-s);
  line-height: var(--dshTodo-lh-s);
  color: var(--dshTodo-text-2);
}
.dshTodo-metrics dd {
  margin: 0;
  font-size: var(--dshTodo-fs-xl);
  line-height: var(--dshTodo-lh-xl);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--dshTodo-text);
}
.dshTodo-yearBody {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow-x: auto;
  padding-bottom: 2px;
}
.dshTodo-yearMonths {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 12px;
  column-gap: 3px;
  height: 14px;
  margin-bottom: 5px;
  font-size: var(--dshTodo-fs-xs);
  line-height: 14px;
  color: var(--dshTodo-text-2);
  white-space: nowrap;
}
.dshTodo-yearMonth {
  overflow: visible;
}
.dshTodo-yearGrid {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 12px;
  grid-template-rows: repeat(7, 12px);
  gap: 3px;
}
.dshTodo-yCell {
  display: block;
  width: 12px;
  height: 12px;
  border-radius: 3px;
  background: var(--dshTodo-track);
}
.dshTodo-yCell[data-tier='1'] {
  background: color-mix(in srgb, var(--dshTodo-done) 30%, transparent);
}
.dshTodo-yCell[data-tier='2'] {
  background: color-mix(in srgb, var(--dshTodo-done) 48%, transparent);
}
.dshTodo-yCell[data-tier='3'] {
  background: color-mix(in srgb, var(--dshTodo-done) 68%, transparent);
}
.dshTodo-yCell[data-tier='4'] {
  background: var(--dshTodo-done);
}
/* One pixel: the cell is 12px square, and a thicker ring reads as a selected chip
   rather than as the “today” marker it is. */
.dshTodo-yCell[data-today='true'] {
  box-shadow: 0 0 0 1px var(--dshTodo-text);
}
.dshTodo-yBlank {
  display: block;
  width: 12px;
  height: 12px;
}
.dshTodo-legend {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--dshTodo-fs-xs);
  line-height: var(--dshTodo-lh-xs);
  color: var(--dshTodo-text-2);
}
.dshTodo-legend > span:first-child {
  margin-right: 2px;
}
.dshTodo-legend > span:last-child {
  margin-left: 2px;
}

.dshTodo-chips {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.dshTodo-chip {
  display: flex;
  align-items: center;
  gap: var(--dshTodo-s2);
  min-width: 0;
  min-height: 26px;
  padding: 0 var(--dshTodo-s2);
  border-radius: var(--dshTodo-r-sm);
  box-shadow: inset 0 0 0 1px var(--dshTodo-line-2);
  color: var(--dshTodo-text);
  font-size: var(--dshTodo-fs-s);
  line-height: var(--dshTodo-lh-s);
}
.dshTodo-chip[data-compact='true'] {
  min-height: 22px;
  gap: 6px;
  padding: 0 6px;
  font-size: var(--dshTodo-fs-xs);
  line-height: var(--dshTodo-lh-xs);
}
.dshTodo-chip[data-done='true'] {
  background: var(--dshTodo-done-wash);
  box-shadow: none;
  color: var(--dshTodo-text-2);
}
.dshTodo-chip[data-done='true'] .dshTodo-chipText {
  text-decoration: line-through;
}
.dshTodo-chipText {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshTodo-glyph {
  flex: none;
  box-sizing: border-box;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  box-shadow: inset 0 0 0 1.5px var(--dshTodo-text-2);
  transition: transform .18s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.dshTodo-chip[data-done='true'] .dshTodo-glyph {
  background: var(--dshTodo-done);
  box-shadow: none;
  transform: scale(1.15);
}

.dshTodo-bottomDeco {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 96px;
  pointer-events: none;
  user-select: none;
  overflow: visible;
  z-index: 0;
}
.dshTodo-bottomSvg {
  display: block;
  width: 100%;
  height: 100%;
}
.dshTodo-hillBack {
  fill: color-mix(in srgb, var(--dshTodo-done) 10%, transparent);
}
.dshTodo-hillFront {
  fill: color-mix(in srgb, var(--dshTodo-done) 18%, transparent);
}
.dshTodo-bottomSparkles {
  position: absolute;
  bottom: 34px;
  left: -4px;
  width: 48px;
  height: 48px;
  pointer-events: none;
}

.dshTodo-reminderTag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 6px;
  border-radius: var(--dshTodo-r-sm);
  background: color-mix(in srgb, var(--dshTodo-text) 6%, var(--dshTodo-surface));
  color: var(--dshTodo-text-2);
  font-size: var(--dshTodo-fs-xs);
  line-height: 20px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dshTodo-reminderTag svg {
  width: 12px;
  height: 12px;
  color: var(--dshTodo-done);
}

.dshTodo-reminderPickerWrapper {
  position: relative;
  display: inline-flex;
}
.dshTodo-reminderPickerCompact {
  margin-left: auto;
}
.dshTodo-row .dshTodo-reminderPickerWrapper[data-empty='true'] {
  opacity: 0;
  transition: opacity .15s ease;
}
.dshTodo-row:hover .dshTodo-reminderPickerWrapper[data-empty='true'],
.dshTodo-row:focus-within .dshTodo-reminderPickerWrapper[data-empty='true'] {
  opacity: 1;
}
@media (hover: none) {
  .dshTodo-row .dshTodo-reminderPickerWrapper[data-empty='true'] {
    opacity: 0.6;
  }
}
.dshTodo-reminderTriggerCompact {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: var(--dshTodo-r-md);
  background: transparent;
  color: var(--dshTodo-text-2);
  cursor: pointer;
  transition: background-color .15s ease, color .15s ease;
}
.dshTodo-reminderTriggerCompact:hover {
  background: var(--dshTodo-hover);
  color: var(--dshTodo-text);
}
.dshTodo-reminderTriggerCompact svg {
  width: 14px;
  height: 14px;
}
.dshTodo-reminderTrigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 8px;
  border: 1px solid var(--dshTodo-line-2);
  border-radius: var(--dshTodo-r-md);
  background: transparent;
  color: var(--dshTodo-text-2);
  font: inherit;
  font-size: var(--dshTodo-fs-s);
  line-height: 1;
  cursor: pointer;
  transition: background-color .15s ease, border-color .15s ease, color .15s ease;
}
.dshTodo-reminderTrigger:hover {
  background: var(--dshTodo-hover);
  color: var(--dshTodo-text);
}
.dshTodo-reminderTrigger[data-active='true'] {
  background: var(--dshTodo-done-wash);
  border-color: var(--dshTodo-done);
  color: var(--dshTodo-done);
  font-weight: 600;
}
.dshTodo-reminderTriggerIcon {
  display: inline-flex;
  align-items: center;
}
.dshTodo-reminderTriggerIcon svg {
  width: 14px;
  height: 14px;
}
.dshTodo-reminderTriggerText {
  font-variant-numeric: tabular-nums;
}
.dshTodo-reminderPopover {
  position: absolute;
  right: 0;
  width: 280px;
  max-width: calc(100vw - 32px);
  padding: var(--dshTodo-s3);
  border-radius: var(--dshTodo-r-lg);
  background: var(--dshTodo-surface);
  border: 1px solid var(--dshTodo-line-2);
  box-shadow: 0 12px 32px color-mix(in srgb, var(--dshTodo-text) 14%, transparent);
  z-index: 100;
  display: flex;
  flex-direction: column;
  gap: var(--dshTodo-s2);
}
.dshTodo-reminderPopover[data-placement='bottom'] {
  top: calc(100% + 6px);
  bottom: auto;
}
.dshTodo-reminderPopover[data-placement='top'] {
  bottom: calc(100% + 6px);
  top: auto;
}
.dshTodo-reminderPopoverHead {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: var(--dshTodo-fs-xs);
  line-height: var(--dshTodo-lh-xs);
  color: var(--dshTodo-text-2);
  font-weight: 600;
}
.dshTodo-reminderClear {
  border: 0;
  background: transparent;
  color: var(--dshTodo-error);
  cursor: pointer;
  font-size: var(--dshTodo-fs-xs);
  padding: 0;
}
.dshTodo-reminderPresets {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.dshTodo-reminderPresetBtn {
  border: 1px solid var(--dshTodo-line-2);
  background: transparent;
  padding: 6px 4px;
  border-radius: var(--dshTodo-r-sm);
  font-size: var(--dshTodo-fs-xs);
  color: var(--dshTodo-text);
  cursor: pointer;
  text-align: center;
  transition: background-color .15s ease, border-color .15s ease;
}
.dshTodo-reminderPresetBtn:hover {
  background: var(--dshTodo-hover);
  border-color: var(--dshTodo-done);
}

.dshTodo-reminderCustomSection {
  display: flex;
  flex-direction: column;
  gap: var(--dshTodo-s2);
  margin-top: 4px;
  padding-top: 6px;
  border-top: 1px solid var(--dshTodo-line);
}
.dshTodo-reminderCustomLabel {
  font-size: var(--dshTodo-fs-xs);
  color: var(--dshTodo-text-2);
  font-weight: 500;
}
.dshTodo-reminderSlots {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.dshTodo-reminderSlotBtn {
  flex: 1 1 auto;
  border: 1px solid var(--dshTodo-line-2);
  background: transparent;
  padding: 3px 6px;
  border-radius: var(--dshTodo-r-sm);
  font-size: var(--dshTodo-fs-xs);
  font-variant-numeric: tabular-nums;
  color: var(--dshTodo-text-2);
  cursor: pointer;
  text-align: center;
  transition: background-color .15s ease, color .15s ease;
}
.dshTodo-reminderSlotBtn:hover {
  background: var(--dshTodo-hover);
  color: var(--dshTodo-text);
}
.dshTodo-reminderCustomForm {
  display: flex;
  align-items: center;
  gap: var(--dshTodo-s2);
}
.dshTodo-reminderCustomInput {
  flex: 1 1 auto;
  min-width: 0;
}
.dshTodo-reminderApplyBtn {
  flex: none;
  white-space: nowrap;
}
.dshTodo-timeIconBtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin: -2px 0 -2px -2px;
  padding: 0;
  border: 0;
  border-radius: var(--dshTodo-r-sm);
  background: transparent;
  color: var(--dshTodo-text-2);
  cursor: pointer;
  transition: color .15s ease, background-color .15s ease;
}
.dshTodo-timeIconBtn:hover,
.dshTodo-timeIconBtn[data-active='true'] {
  color: var(--dshTodo-done);
  background: var(--dshTodo-hover);
}
.dshTodo-timeIconBtn svg {
  width: 14px;
  height: 14px;
}
.dshTodo-timeWheelPicker {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border-radius: var(--dshTodo-r-md);
  background: color-mix(in srgb, var(--dshTodo-text) 2.5%, var(--dshTodo-surface));
  border: 1px solid var(--dshTodo-line);
}
.dshTodo-timeWheelHeader {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: var(--dshTodo-fs-xs);
  color: var(--dshTodo-text-2);
}
.dshTodo-timeWheelHint {
  color: var(--dshTodo-done);
  font-size: var(--dshTodo-fs-xs);
  font-weight: 500;
}
.dshTodo-timeWheelCols {
  display: flex;
  align-items: center;
  gap: 4px;
}
.dshTodo-timeWheelCol {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.dshTodo-timeWheelColTitle {
  font-size: var(--dshTodo-fs-xs);
  color: var(--dshTodo-text-2);
  margin-bottom: 2px;
}
.dshTodo-timeWheelList {
  width: 100%;
  max-height: 110px;
  overflow-y: auto;
  scrollbar-width: thin;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.dshTodo-timeWheelDivider {
  color: var(--dshTodo-text-2);
  font-weight: 600;
  padding: 0 2px;
  margin-top: 14px;
}
.dshTodo-timeWheelItem {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 24px;
  border: 0;
  border-radius: var(--dshTodo-r-sm);
  background: transparent;
  color: var(--dshTodo-text);
  font-size: var(--dshTodo-fs-xs);
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition: background-color .12s ease, color .12s ease;
}
.dshTodo-timeWheelItem:hover {
  background: var(--dshTodo-hover);
}
.dshTodo-timeWheelItem[data-selected='true'] {
  background: var(--dshTodo-done);
  color: #fff;
  font-weight: 600;
}

@keyframes dshTodo-toastIn {
  0% { transform: translateY(16px); opacity: 0; }
  100% { transform: translateY(0); opacity: 1; }
}
.dshTodo-reminderToast {
  position: fixed;
  right: 24px;
  bottom: 24px;
  width: max-content;
  min-width: 240px;
  max-width: min(420px, calc(100vw - 32px));
  padding: var(--dshTodo-s3) var(--dshTodo-s4);
  border-radius: var(--dshTodo-r-lg);
  background: var(--dshTodo-surface);
  border: 1px solid var(--dshTodo-line-2);
  box-shadow: 0 12px 32px color-mix(in srgb, var(--dshTodo-text) 14%, transparent);
  z-index: 1200;
  display: flex;
  flex-direction: column;
  gap: var(--dshTodo-s2);
  animation: dshTodo-toastIn 220ms cubic-bezier(0.16, 1, 0.3, 1);
}
.dshTodo-reminderToastHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--dshTodo-s3);
}
.dshTodo-reminderToastTitle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--dshTodo-fs-m);
  font-weight: 600;
  color: var(--dshTodo-text);
  white-space: nowrap;
}
.dshTodo-reminderToastBell {
  display: inline-flex;
  align-items: center;
  color: var(--dshTodo-done);
}
.dshTodo-reminderToastBell svg {
  width: 15px;
  height: 15px;
}
.dshTodo-reminderToastTime {
  font-size: var(--dshTodo-fs-xs);
  font-weight: 400;
  color: var(--dshTodo-text-2);
  margin-left: 2px;
}
.dshTodo-reminderToastClose {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: var(--dshTodo-r-sm);
  background: transparent;
  color: var(--dshTodo-text-2);
  cursor: pointer;
  transition: background-color .15s ease, color .15s ease;
}
.dshTodo-reminderToastClose:hover {
  background: var(--dshTodo-hover);
  color: var(--dshTodo-text);
}
.dshTodo-reminderToastClose svg {
  width: 14px;
  height: 14px;
}
.dshTodo-reminderToastBody {
  margin: 2px 0 6px;
  font-size: var(--dshTodo-fs-m);
  line-height: var(--dshTodo-lh-m);
  color: var(--dshTodo-text);
  word-break: break-word;
}
.dshTodo-reminderToastActions {
  display: flex;
  align-items: center;
  gap: var(--dshTodo-s2);
}

@media (max-width: 560px) {
  .dshTodo-agendaRow {
    grid-template-columns: 64px minmax(0, 1fr);
  }
  .dshTodo-agendaCount {
    grid-column: 2;
    width: auto;
    max-width: 180px;
    margin-top: 4px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .dshTodo-ringFill,
  .dshTodo-cardWeekBar,
  .dshTodo-meterFill,
  .dshTodo-rowRemove,
  .dshTodo-day,
  .dshTodo-day[data-today='true'] .dshTodo-dayNum,
  .dshTodo-meter[data-completed='true']::after,
  .dshTodo-meter[data-completed='true'] .dshTodo-meterFill,
  .dshTodo-reminderToast,
  .dshTodo-cardSun {
    animation: none;
    transition: none;
  }
}
`

export function adoptStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.append(style)
}
