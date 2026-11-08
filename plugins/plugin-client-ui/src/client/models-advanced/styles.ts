/**
 * Styles of the provider manager page — a port of dsh-provider-studio v1.3.1's
 * panel stylesheet (MIT), with the class prefix renamed and the rules this page
 * does not use removed.
 *
 * Everything is scoped under `.dshAma-root` and built on DSW alias tokens, so the
 * page follows the Harness theme (light and dark) without hard-coded colours.
 * Every token keeps a literal fallback for hosts that do not define it.
 *
 * Scale: 13px body, 12px labels, 12.5px controls, 32px control height, 8px
 * control radius, 12px card radius. Motion uses one out-expo curve and three
 * durations (120/160/240ms) so every transition in the panel feels related.
 *
 * Controls are the kernel's primitives wherever one exists (`Button`, `Input`,
 * `Modal`); `.dshAma-inputWrap` only restates their type scale to this page's
 * 12.5px. The controls the primitives do not provide — the two-state bool, the
 * chip toggle, the add-row, the advanced block's disclosure — carry this page's
 * own class vocabulary, copied from the source design.
 *
 * @module @dsh-app/plugin-client-ui/client/models-advanced/styles
 */

/** The page's stylesheet, injected as one `<style>` by the section. */
export const ADVANCED_CSS = `
/* The token block is shared with .dshAma-scope, the class every portaled
   dialog carries: a body portal leaves .dshAma-root, so without it the dialog
   would silently lose every variable below (unstyled selects, no borders). */
.dshAma-root,.dshAma-scope{
  --dshAma-fg:var(--dsw-alias-label-primary,#17181a);
  --dshAma-fg2:var(--dsw-alias-label-secondary,#5b6070);
  --dshAma-fg3:var(--dsw-alias-label-tertiary,#8a8f9d);
  --dshAma-fg4:color-mix(in srgb,var(--dshAma-fg) 62%,transparent);
  --dshAma-line:var(--dsw-alias-border-l2,#e3e5ea);
  --dshAma-line1:var(--dsw-alias-border-l1,#eceef2);
  --dshAma-line2:var(--dsw-alias-border-l4,#c8ccd5);
  --dshAma-surface:var(--dsw-alias-bg-layer-1,#ffffff);
  --dshAma-surface2:color-mix(in srgb,var(--dshAma-fg) 3%,var(--dshAma-surface));
  --dshAma-fill:color-mix(in srgb,var(--dshAma-fg) 5%,var(--dshAma-surface));
  --dshAma-hover:var(--dsw-alias-interactive-bg-hover,#f2f3f6);
  --dshAma-hoverDanger:var(--dsw-alias-interactive-bg-hover-danger,rgba(198,40,40,.08));
  --dshAma-brand:var(--dsw-alias-button-info-fill,#3b6df5);
  --dshAma-brandSoft:color-mix(in srgb,var(--dshAma-brand) 12%,transparent);
  --dshAma-brandSoft2:color-mix(in srgb,var(--dshAma-brand) 20%,transparent);
  --dshAma-brandFill:var(--dsw-alias-button-primary-fill,#0f1115);
  --dshAma-brandFg:var(--dsw-alias-label-primary-foreground,#ffffff);
  --dshAma-ok:var(--dsw-alias-state-success-primary,#128a4a);
  --dshAma-okLabel:color-mix(in srgb,var(--dshAma-ok) 70%,var(--dshAma-fg));
  --dshAma-okSoft:color-mix(in srgb,var(--dshAma-ok) 12%,transparent);
  --dshAma-bad:var(--dsw-alias-state-error-primary,#c62828);
  --dshAma-badLabel:color-mix(in srgb,var(--dshAma-bad) 72%,var(--dshAma-fg));
  --dshAma-badSoft:color-mix(in srgb,var(--dshAma-bad) 10%,transparent);
  --dshAma-warn:color-mix(in srgb,#f59e0b 62%,var(--dshAma-fg));
  --dshAma-skel:var(--dsw-alias-bg-skeleton,#eceef2);
  --dshAma-shadowSm:0 2px 8px -2px rgba(16,20,30,.12);
  --dshAma-r-lg:12px;--dshAma-r:10px;--dshAma-r-sm:8px;--dshAma-r-xs:6px;
  --dshAma-ease:cubic-bezier(.16,1,.3,1);
  --dshAma-t-fast:.12s;--dshAma-t:.16s;--dshAma-t-slow:.24s;
  color:var(--dshAma-fg);
  font-size:13px;line-height:1.5;
  -webkit-font-smoothing:antialiased;
}
.dshAma-root{max-width:760px;margin:0 auto;padding:2px 0 40px}
.dshAma-root *,.dshAma-scope *{box-sizing:border-box}
.dshAma-root button,.dshAma-root input,.dshAma-root select,
.dshAma-scope button,.dshAma-scope input,.dshAma-scope select{font-family:inherit}
.dshAma-root h2,.dshAma-root h3{font-family:inherit}
.dshAma-root ::selection{background:var(--dshAma-brandSoft2)}
.dshAma-mono{font-size:11.5px;letter-spacing:0}

/* ------------------------------------------------------------------ motion */
@keyframes dshAmaFadeIn{from{opacity:0}}
@keyframes dshAmaViewIn{from{opacity:0;transform:translateY(6px)}}
@keyframes dshAmaRowIn{from{opacity:0;transform:translateY(3px)}}
@keyframes dshAmaSpin{to{transform:rotate(360deg)}}
@keyframes dshAmaShimmer{from{background-position:100% 0}to{background-position:-100% 0}}
.dshAma-spin{animation:dshAmaSpin .8s linear infinite}
.dshAma-view{animation:dshAmaViewIn var(--dshAma-t-slow) var(--dshAma-ease) backwards}

/* ------------------------------------------------------------------ header */
.dshAma-pageHead{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:32px;margin-bottom:12px}
.dshAma-pageTitle{display:flex;align-items:baseline;gap:8px;margin:0;font-size:17px;font-weight:650;letter-spacing:-.02em;line-height:1.3}
.dshAma-pageCount{color:var(--dshAma-fg4);font-size:12px;font-weight:500;letter-spacing:0}
.dshAma-backBtn{display:inline-flex;align-items:center;gap:5px;align-self:flex-start;margin:0 0 10px -6px;padding:4px 6px;border:0;border-radius:6px;background:none;color:var(--dshAma-fg2);font:inherit;font-size:12px;cursor:pointer;transition:background var(--dshAma-t),color var(--dshAma-t)}
.dshAma-backBtn:hover{background:var(--dshAma-hover);color:var(--dshAma-fg)}
.dshAma-backBtn:focus-visible{outline:2px solid var(--dshAma-brand);outline-offset:2px}

/* ----------------------------------------------------------------- buttons */
.dshAma-iconAction{width:26px;height:26px;padding:0;border-radius:7px}
.dshAma-iconDanger:hover:not(:disabled){background:var(--dshAma-hoverDanger);color:var(--dshAma-bad)}
.dshAma-linkBtn{border:0;background:none;padding:0;color:var(--dshAma-brand);font:inherit;font-size:12px;cursor:pointer;transition:opacity var(--dshAma-t)}
.dshAma-linkBtn:hover{text-decoration:underline}
.dshAma-linkBtn:disabled{opacity:.45;cursor:not-allowed}

/* ------------------------------------------------------------------ inputs */
.dshAma-input{width:100%;height:32px;padding:0 10px;border:1px solid var(--dshAma-line);border-radius:var(--dshAma-r-sm);background:var(--dshAma-surface);color:var(--dshAma-fg);font:inherit;font-size:12.5px;line-height:normal;transition:border-color var(--dshAma-t),box-shadow var(--dshAma-t),background var(--dshAma-t)}
.dshAma-input::placeholder{color:var(--dshAma-fg4)}
.dshAma-input:hover:not(:disabled):not(:focus){border-color:var(--dshAma-line2)}
.dshAma-input:focus{outline:0;border-color:var(--dshAma-brand);box-shadow:0 0 0 3px var(--dshAma-brandSoft)}
.dshAma-input:disabled{background:var(--dshAma-surface2);color:var(--dshAma-fg3);cursor:not-allowed}
.dshAma-input.is-invalid{border-color:var(--dshAma-bad);box-shadow:0 0 0 3px var(--dshAma-badSoft)}
/* The kernel's Input carries no type scale of its own on this page. */
.dshAma-inputWrap{width:100%;min-width:0;padding:0 10px;border-radius:var(--dshAma-r-sm);font-size:12.5px;box-sizing:border-box}
.dshAma-inputWrap input{font-size:12.5px;line-height:normal}
.dshAma-readonly{display:flex;align-items:center;min-height:32px;padding:0 10px;border:1px solid var(--dshAma-line1);border-radius:var(--dshAma-r-sm);background:var(--dshAma-surface2);color:var(--dshAma-fg2);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshAma-selectWrap{position:relative;display:block}
.dshAma-selectWrap::after{content:'';position:absolute;right:11px;top:50%;width:5px;height:5px;border-right:1px solid var(--dshAma-fg3);border-bottom:1px solid var(--dshAma-fg3);transform:translateY(-70%) rotate(45deg);pointer-events:none}
.dshAma-select{appearance:none;-webkit-appearance:none;padding-right:28px;cursor:pointer}
.dshAma-select:disabled{cursor:not-allowed}
.dshAma-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.dshAma-field.is-wide{grid-column:1/-1}
.dshAma-fieldLabel{display:flex;align-items:center;gap:8px;color:var(--dshAma-fg2);font-size:12px;font-weight:500;letter-spacing:.01em}
.dshAma-fieldLabelInline{justify-content:flex-start}
.dshAma-fieldHint{color:var(--dshAma-fg4);font-weight:400;font-size:11.5px;line-height:1.5}
.dshAma-fieldHead{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:26px;flex-wrap:wrap}
.dshAma-fieldHeadActions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end;margin-left:auto}
.dshAma-count{display:inline-flex;align-items:center;height:16px;padding:0 5px;border-radius:5px;background:var(--dshAma-fill);color:var(--dshAma-fg3);font-size:10.5px;font-weight:500;font-family:inherit;letter-spacing:0}
.dshAma-formGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px 14px}
.dshAma-inline{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dshAma-inline > .dshAma-field{flex:1 1 200px}
.dshAma-hint{margin:0;color:var(--dshAma-fg3);font-size:11.5px;line-height:1.55}
.dshAma-error{margin:0;color:var(--dshAma-badLabel);font-size:12px;line-height:1.5}
.dshAma-notice{margin:0;color:var(--dshAma-okLabel);font-size:12px;line-height:1.5}
.dshAma-muted{color:var(--dshAma-fg3);font-size:11.5px}
.dshAma-invalid{color:var(--dshAma-badLabel)}

/** ----------------------------------------------------------------- choices */
.dshAma-searchRow{display:flex;align-items:center;margin:0 0 6px}
.dshAma-tplGroup{margin-top:16px}
.dshAma-tplGroupTitle{display:flex;align-items:center;gap:6px;margin:0 0 8px;font-size:12px;font-weight:600;color:var(--dshAma-fg2)}
.dshAma-tplCount{display:inline-flex;align-items:center;height:16px;padding:0 5px;border-radius:5px;background:var(--dshAma-fill);color:var(--dshAma-fg4);font-size:10.5px;font-weight:500}
.dshAma-tplGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(228px,1fr));gap:6px}
.dshAma-tplCard{display:flex;align-items:center;gap:10px;min-height:54px;padding:8px 10px;border:1px solid var(--dshAma-line);border-radius:var(--dshAma-r);background:var(--dshAma-surface);color:var(--dshAma-fg);font:inherit;text-align:left;cursor:pointer;animation:dshAmaRowIn var(--dshAma-t) var(--dshAma-ease) backwards;transition:border-color var(--dshAma-t),box-shadow var(--dshAma-t),transform var(--dshAma-t)}
.dshAma-tplCard:hover{border-color:var(--dshAma-line2);box-shadow:var(--dshAma-shadowSm);transform:translateY(-1px)}
.dshAma-tplCard:active{transform:translateY(0) scale(.995)}
.dshAma-tplCard:focus-visible{outline:2px solid var(--dshAma-brand);outline-offset:1px}
.dshAma-tplBody{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.dshAma-tplName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:500}
.dshAma-tplHost{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dshAma-fg4)}
.dshAma-tplCustom{margin-top:12px;width:100%}
.dshAma-tplMore{display:block;margin:8px auto 0}

/* ------------------------------------------------------------------- cards */
.dshAma-card{border:1px solid var(--dshAma-line);border-radius:var(--dshAma-r-lg);background:var(--dshAma-surface);box-shadow:0 1px 2px rgba(16,20,30,.035)}
.dshAma-cardHead{display:flex;align-items:flex-start;gap:10px;padding:16px 12px 0 18px}
.dshAma-titleBlock{flex:1;min-width:0;padding-top:1px}
.dshAma-title{display:inline-flex;align-items:center;gap:6px;max-width:100%;margin:0;padding:0;border:0;background:none;color:var(--dshAma-fg);font:inherit;font-size:15px;font-weight:600;letter-spacing:-.015em;line-height:1.35;text-align:left;border-radius:4px}
.dshAma-titleText{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshAma-providerMeta{display:flex;align-items:center;gap:8px;margin-top:3px;color:var(--dshAma-fg3);font-size:11.5px;min-width:0;overflow:hidden;white-space:nowrap}
.dshAma-metaDot{width:3px;height:3px;border-radius:50%;background:var(--dshAma-line2);flex:none}
.dshAma-tag{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:5px;background:var(--dshAma-fill);color:var(--dshAma-fg3);font-size:10.5px;font-weight:500;letter-spacing:.01em}
.dshAma-cardBody{display:flex;flex-direction:column;gap:14px;padding:16px 18px 18px}
.dshAma-cardFoot{display:flex;align-items:center;gap:8px;padding:12px 16px;border-top:1px solid var(--dshAma-line1)}
.dshAma-dirty{margin-right:auto;color:var(--dshAma-fg4);font-size:11.5px;opacity:0;transition:opacity var(--dshAma-t),color var(--dshAma-t)}
.dshAma-dirty.is-on{opacity:1;color:var(--dshAma-warn)}

/* ------------------------------------------------------------------- marks */
.dshAma-mark{display:inline-flex;align-items:center;justify-content:center;flex:none;border-radius:6px;overflow:hidden;background:transparent}
.dshAma-mark img{display:block;width:100%;height:100%;object-fit:contain}
.dshAma-root[data-scheme="dark"] .dshAma-mark.is-onLight{background:#f4f5f7;box-shadow:inset 0 0 0 1px rgba(15,17,21,.08)}
.dshAma-root[data-scheme="light"] .dshAma-mark.is-onDark{background:#26272b;box-shadow:inset 0 0 0 1px rgba(255,255,255,.1)}
.dshAma-mark.is-solid{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dshAma-fg) 18%,transparent)}
.dshAma-markMask{display:block;background-color:var(--dshAma-fg2);-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-position:center;mask-position:center;-webkit-mask-size:contain;mask-size:contain}
.dshAma-markFallback{background:var(--dshAma-fill);color:var(--dshAma-fg2);box-shadow:inset 0 0 0 1px var(--dshAma-line1)}
.dshAma-markInitial{font-weight:600;line-height:1;letter-spacing:0}
.dshAma-markAdd{background:var(--dshAma-brandSoft);color:var(--dshAma-brand);box-shadow:none}

/* -------------------------------------------------------------------- list */
.dshAma-listSection{display:flex;align-items:center;gap:6px;margin:16px 0 4px;color:var(--dshAma-fg3);font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase}
.dshAma-listSection:first-of-type{margin-top:4px}
.dshAma-list{display:flex;flex-direction:column;gap:2px;margin:0 -8px}
.dshAma-row{display:flex;align-items:center;gap:2px;padding:0 6px 0 8px;border-radius:var(--dshAma-r);animation:dshAmaRowIn var(--dshAma-t-slow) var(--dshAma-ease) backwards;transition:background var(--dshAma-t)}
.dshAma-row:hover{background:var(--dshAma-hover)}
.dshAma-rowMain{display:flex;align-items:center;gap:10px;flex:1;min-width:0;min-height:44px;padding:0;border:0;background:none;color:var(--dshAma-fg);font:inherit;font-size:13.5px;font-weight:500;text-align:left;cursor:pointer}
.dshAma-rowMain:active{opacity:.85}
.dshAma-rowMain:focus-visible{outline:2px solid var(--dshAma-brand);outline-offset:-2px;border-radius:8px}
.dshAma-pin{color:var(--dshAma-fg4);flex:none;opacity:.6;transition:opacity var(--dshAma-t),color var(--dshAma-t)}
.dshAma-row:hover .dshAma-pin{opacity:1}
.dshAma-pin.is-on{color:var(--dshAma-brand);opacity:1}
.dshAma-rowName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshAma-rowChevron{color:var(--dshAma-fg4);transition:transform var(--dshAma-t) var(--dshAma-ease),color var(--dshAma-t)}
.dshAma-row:hover .dshAma-rowChevron{color:var(--dshAma-fg3);transform:translateX(2px)}

/* ------------------------------------------------------------------- empty */
.dshAma-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:40px 20px 44px;text-align:center}
.dshAma-emptyTitle{font-size:13.5px;font-weight:600}
.dshAma-emptyHint{max-width:340px;margin-bottom:8px;font-size:12px;line-height:1.6;color:var(--dshAma-fg3)}

/* ------------------------------------------------------------------ alerts */
.dshAma-alert{display:flex;align-items:flex-start;gap:8px;margin:0;padding:9px 11px;border-radius:var(--dshAma-r-sm);background:var(--dshAma-fill);color:var(--dshAma-fg2);font-size:12px;line-height:1.55;animation:dshAmaFadeIn var(--dshAma-t) var(--dshAma-ease)}
.dshAma-alert.is-err{background:var(--dshAma-badSoft);color:var(--dshAma-badLabel)}

/* --------------------------------------------------------------- skeletons */
.dshAma-skelRow{display:flex;align-items:center;gap:10px;height:44px;padding:0 8px}
.dshAma-skel{display:block;height:11px;border-radius:5px;background:linear-gradient(90deg,var(--dshAma-skel) 25%,var(--dshAma-fill) 37%,var(--dshAma-skel) 63%);background-size:400% 100%;animation:dshAmaShimmer 1.4s ease infinite}
.dshAma-skelMark{width:22px;height:22px;border-radius:6px;flex:none}

/* ------------------------------------------------------------------ badges */
.dshAma-badge{display:inline-flex;align-items:center;height:20px;padding:0 6px;border-radius:5px;background:var(--dshAma-fill);color:var(--dshAma-fg2);font-size:10.5px;font-weight:500;letter-spacing:.01em;white-space:nowrap}
.dshAma-badgeMono{font-size:10px;letter-spacing:0;color:var(--dshAma-fg3)}
.dshAma-result{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 6px;border-radius:5px;font-size:10.5px;font-weight:500;white-space:nowrap;animation:dshAmaFadeIn var(--dshAma-t) var(--dshAma-ease)}
.dshAma-result.is-ok{background:var(--dshAma-okSoft);color:var(--dshAma-okLabel)}
.dshAma-result.is-err{background:var(--dshAma-badSoft);color:var(--dshAma-badLabel)}

/* ------------------------------------------------------------------- key UI */
.dshAma-keyState{margin-left:auto;display:inline-flex;align-items:center;gap:5px;color:var(--dshAma-fg4);font-size:11px;font-weight:400;transition:color var(--dshAma-t)}
.dshAma-keyDot{width:5px;height:5px;border-radius:50%;background:var(--dshAma-line2);transition:background var(--dshAma-t),box-shadow var(--dshAma-t)}
.dshAma-keyState.is-on{color:var(--dshAma-okLabel)}
.dshAma-keyState.is-on .dshAma-keyDot{background:var(--dshAma-ok);box-shadow:0 0 0 2px var(--dshAma-okSoft)}

/* --------------------------------------------------------------- model list */
.dshAma-modelBox{border:1px solid var(--dshAma-line);border-radius:var(--dshAma-r);overflow:hidden;background:var(--dshAma-surface)}
.dshAma-modelRow{display:flex;align-items:center;gap:8px;min-height:40px;padding:0 6px 0 10px;animation:dshAmaRowIn var(--dshAma-t) var(--dshAma-ease) backwards;transition:background var(--dshAma-t-fast)}
.dshAma-modelRow + .dshAma-modelRow{border-top:1px solid var(--dshAma-line1)}
.dshAma-modelRow:hover{background:var(--dshAma-hover)}
.dshAma-modelName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0;border:0;background:none;color:var(--dshAma-fg);font-size:12.5px;letter-spacing:0;text-align:left;cursor:pointer;transition:color var(--dshAma-t)}
.dshAma-modelName:hover:not(:disabled){color:var(--dshAma-brand)}
.dshAma-modelName:disabled{cursor:default}
.dshAma-modelBadges{display:flex;align-items:center;gap:4px;flex:none}
.dshAma-modelActions{display:flex;align-items:center;gap:1px;flex:none;margin-left:2px}
.dshAma-modelEmpty{display:flex;align-items:center;gap:8px;min-height:52px;padding:0 12px;border:1px dashed var(--dshAma-line);border-radius:var(--dshAma-r);color:var(--dshAma-fg3);font-size:12px}
.dshAma-overrideAdd{display:flex;align-items:center;gap:8px;min-width:0}
.dshAma-overrideAdd .dshAma-inputWrap{flex:1 1 auto;min-width:0;width:auto}
.dshAma-emptyNote{margin:2px 0;color:var(--dshAma-fg3);font-size:12px;line-height:1.55}
.dshAma-inputSearch{padding-left:10px}

/* ------------------------------------------------------------------- chips */
.dshAma-chipRow{display:flex;flex-wrap:wrap;gap:6px}
.dshAma-chip{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border:1px solid var(--dshAma-line);border-radius:999px;background:var(--dshAma-surface);color:var(--dshAma-fg2);font:inherit;font-size:12px;cursor:pointer;transition:background var(--dshAma-t),border-color var(--dshAma-t),color var(--dshAma-t)}
.dshAma-chip:hover:not(:disabled){border-color:var(--dshAma-line2);color:var(--dshAma-fg)}
.dshAma-chip.is-on{border-color:transparent;background:var(--dshAma-brandSoft);color:var(--dshAma-brand);font-weight:500}
.dshAma-chip:focus-visible{outline:2px solid var(--dshAma-brand);outline-offset:2px}
.dshAma-chip:disabled{opacity:.5;cursor:not-allowed}

/* --------------------------------------------------------- advanced block */
.dshAma-advBlock{margin:2px -18px -18px;border-top:1px solid var(--dshAma-line1)}
.dshAma-advHead{display:flex;align-items:center;gap:7px;width:100%;height:42px;padding:0 18px;border:0;background:transparent;color:var(--dshAma-fg2);font:inherit;font-size:12.5px;font-weight:500;text-align:left;cursor:pointer;transition:background var(--dshAma-t),color var(--dshAma-t)}
.dshAma-advHead:hover{background:var(--dshAma-hover);color:var(--dshAma-fg)}
.dshAma-advHead:focus-visible{outline:2px solid var(--dshAma-brand);outline-offset:-2px}
.dshAma-advChevron{color:var(--dshAma-fg4);transition:transform var(--dshAma-t) var(--dshAma-ease)}
.dshAma-advTitle{letter-spacing:.01em}
.dshAma-advBody{display:flex;flex-direction:column;gap:18px;padding:2px 18px 18px;animation:dshAmaViewIn var(--dshAma-t) var(--dshAma-ease) backwards}
.dshAma-advSection{display:flex;flex-direction:column;gap:10px}
.dshAma-advSection + .dshAma-advSection{border-top:1px solid var(--dshAma-line1);padding-top:16px}
.dshAma-advBody .dshAma-advSection:first-child{padding-top:0}
.dshAma-advLabel{color:var(--dshAma-fg3);font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase}
.dshAma-advToggle{display:flex;align-items:center;gap:6px;align-self:flex-start;height:26px;padding:0 4px;border:0;border-radius:var(--dshAma-r-xs);background:transparent;color:var(--dshAma-fg2);font:inherit;font-size:12px;font-weight:500;cursor:pointer;transition:background var(--dshAma-t),color var(--dshAma-t)}
.dshAma-advToggle:hover{background:var(--dshAma-hover);color:var(--dshAma-fg)}
.dshAma-advToggle:focus-visible{outline:2px solid var(--dshAma-brand);outline-offset:1px}
.dshAma-advPanel{display:flex;flex-direction:column;gap:12px;padding-top:2px;animation:dshAmaViewIn var(--dshAma-t) var(--dshAma-ease) backwards}
.dshAma-advPanel > .dshAma-field + .dshAma-field{border-top:1px solid var(--dshAma-line1);padding-top:12px}
.dshAma-thinking{display:flex;flex-direction:column;gap:8px}
.dshAma-effList{display:flex;flex-direction:column;gap:6px}
.dshAma-rowError{color:var(--dshAma-badLabel);font-size:11.5px;line-height:1.5}

/* ------------------------------------------------------- key/value tables */
.dshAma-kvList{display:flex;flex-direction:column;gap:6px}
.dshAma-kvRow{display:grid;grid-template-columns:minmax(88px,120px) minmax(0,1fr) 28px;align-items:center;column-gap:10px;min-height:30px}
.dshAma-kvRow > .dshAma-iconAction{justify-self:end}
.dshAma-kvRow.is-wide{grid-template-columns:minmax(0,1fr)}
.dshAma-kvLabel{color:var(--dshAma-fg2);font-size:12px;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshAma-kvValue{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-width:0}
.dshAma-kvValue > .dshAma-selectWrap,.dshAma-kvValue > .dshAma-inputWrap,.dshAma-kvValue > .dshAma-input{flex:1 1 auto;min-width:0}
.dshAma-effLevel{width:100%;min-width:0;flex:none}
.dshAma-kvRow .dshAma-input{height:30px}
.dshAma-kvRow .dshAma-inputWrap{height:30px}

/* ------------------------------------------------------------------- bools */
.dshAma-bool{display:inline-flex;align-items:center;height:30px;padding:2px;border:1px solid var(--dshAma-line);border-radius:var(--dshAma-r-sm);background:var(--dshAma-surface2)}
.dshAma-boolBtn{display:inline-flex;align-items:center;justify-content:center;height:24px;min-width:38px;padding:0 10px;border:0;border-radius:var(--dshAma-r-xs);background:transparent;color:var(--dshAma-fg3);font:inherit;font-size:12px;font-weight:500;cursor:pointer;transition:background var(--dshAma-t),color var(--dshAma-t)}
.dshAma-boolBtn:hover:not(:disabled):not(.is-on){color:var(--dshAma-fg)}
.dshAma-boolBtn.is-on{background:var(--dshAma-surface);color:var(--dshAma-fg);box-shadow:var(--dshAma-shadowSm)}
.dshAma-boolBtn:disabled{opacity:.5;cursor:not-allowed}

/* ------------------------------------------------------------------ add row */
.dshAma-addRow{display:flex;align-items:center;gap:10px;height:32px;margin-top:2px;padding:0 8px;border:0;border-radius:var(--dshAma-r-sm);background:transparent;color:var(--dshAma-fg2);font:inherit;font-size:12px;cursor:pointer;transition:background var(--dshAma-t),color var(--dshAma-t)}
.dshAma-addRow:hover:not(:disabled){background:var(--dshAma-hover);color:var(--dshAma-fg)}
.dshAma-addRow:focus-visible{outline:2px solid var(--dshAma-brand);outline-offset:-2px}
.dshAma-addRow:disabled{opacity:.45;cursor:not-allowed}
.dshAma-addRow.is-compact{height:32px;gap:8px;font-size:12px;border:1px dashed var(--dshAma-line);padding:0 10px}
.dshAma-addRow.is-compact:hover:not(:disabled){border-color:var(--dshAma-brand);color:var(--dshAma-brand);background:var(--dshAma-brandSoft)}
.dshAma-addRowIcon{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:var(--dshAma-fill);color:var(--dshAma-fg2);transition:background var(--dshAma-t),color var(--dshAma-t)}
.dshAma-addRow:hover:not(:disabled) .dshAma-addRowIcon{background:var(--dshAma-brandSoft);color:var(--dshAma-brand)}

/* ----------------------------------------------------------------- dialogs */
.dshAma-modelForm{display:flex;flex-direction:column;gap:16px}
.dshAma-modelForm > .dshAma-thinking{border-top:1px solid var(--dshAma-line1);padding-top:14px}
.dshAma-modelModal{width:min(560px,calc(100vw - 40px));max-height:100%}
.dshAma-modalScroll{display:flex;flex-direction:column;min-height:0;overflow-y:auto}
.dshAma-footGap{flex:1}
.dshAma-importModal{width:min(560px,calc(100vw - 48px));max-height:100%}
.dshAma-providerList{display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto}
.dshAma-providerRow{display:flex;flex-direction:column;gap:2px;align-items:flex-start;padding:6px 10px;border:1px solid var(--dshAma-line1);border-radius:var(--dshAma-r-sm);background:none;cursor:pointer;text-align:left;color:inherit}
.dshAma-providerRowActive{border-color:var(--dshAma-brand)}
.dshAma-providerId{font-weight:600;font-size:12.5px}
.dshAma-providerMeta{color:var(--dshAma-fg3);font-size:11.5px}
.dshAma-candidateBlock{display:flex;flex-direction:column;gap:6px}
.dshAma-candidateList{display:flex;flex-direction:column;gap:4px;margin:0;padding:0 0 0 4px;list-style:none;max-height:200px;overflow:auto}
.dshAma-candidate{display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-size:12.5px}
.dshAma-footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshAma-discoveryModal{width:min(640px,calc(100vw - 48px));max-height:100%}
.dshAma-discoverySource{display:flex;gap:8px;align-items:center;min-width:0}
.dshAma-discoverySourceLabel{color:var(--dshAma-fg2);font-size:12px}
.dshAma-discoverySource code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshAma-discoveryToolbar{display:flex;gap:8px;align-items:center}
.dshAma-discoveryToolbar .dshAma-inputWrap{flex:1;min-width:0}
.dshAma-discoveryList{display:flex;flex-direction:column;gap:4px;max-height:320px;overflow:auto}
.dshAma-discoveryRow{display:flex;gap:8px;align-items:flex-start;padding:7px 8px;border:1px solid var(--dshAma-line1);border-radius:6px;cursor:pointer}
.dshAma-discoveryRow:hover{background:var(--dshAma-hover)}
.dshAma-discoveryModel{display:flex;flex:1;min-width:0;flex-direction:column;gap:2px}
.dshAma-discoveryModel strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px}
.dshAma-discoveryModel small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dshAma-fg3);font-size:11.5px}

/* ------------------------------------------------------------ reduced motion */
@media (prefers-reduced-motion: reduce){
  .dshAma-root *,.dshAma-root *::before,.dshAma-root *::after{
    animation-duration:.01ms !important;
    animation-iteration-count:1 !important;
    animation-delay:0ms !important;
    transition-duration:.01ms !important;
  }
}
`
