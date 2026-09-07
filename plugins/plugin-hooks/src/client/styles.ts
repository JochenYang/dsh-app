/**
 * Styles for the Hooks settings section + the self-contained confirmation
 * dialog. Alias-token colors only; id-guarded injection stays idempotent.
 * @module @dsh-app/plugin-hooks/client/styles
 */
const STYLE_ID = 'dsh-app-plugin-hooks-style'
const cssText = `
.dshHk-section { display:flex; flex-direction:column; gap:14px; min-width:0; }
.dshHk-title { margin:0; font-size:15px; line-height:22px; font-weight:650; color:var(--dsw-alias-label-primary); }
.dshHk-hint { margin:0; color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:18px; }
.dshHk-banner { padding:8px 12px; border:1px solid var(--dsw-alias-state-error-secondary); border-radius:8px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-state-error-primary); font-size:13px; line-height:20px; }
.dshHk-noticeOk { padding:8px 12px; border:1px solid var(--dsw-alias-state-success-secondary,rgba(34,197,94,0.35)); border-radius:8px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-state-success-primary,#16a34a); font-size:13px; line-height:20px; }
.dshHk-warning { padding:6px 10px; border:1px solid rgba(234,179,8,0.4); border-radius:8px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-secondary); font-size:12px; line-height:18px; }
.dshHk-toolbar { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.dshHk-toolbarActions { display:flex; align-items:center; gap:8px; }
.dshHk-count { color:var(--dsw-alias-label-tertiary); font-size:12px; }
.dshHk-list { display:flex; flex-direction:column; gap:10px; }
.dshHk-card { display:flex; flex-direction:column; gap:8px; padding:12px; border:1px solid var(--dsw-alias-border-l1); border-radius:10px; background:var(--dsw-alias-bg-layer-1); }
.dshHk-cardHead { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.dshHk-dialect { font-size:13.5px; font-weight:600; color:var(--dsw-alias-label-primary); word-break:break-all; }
.dshHk-badge { padding:1px 8px; border-radius:999px; font-size:11px; background:rgba(148,163,184,0.2); color:var(--dsw-alias-label-secondary); }
.dshHk-badgeOn { background:rgba(34,197,94,0.16); color:var(--dsw-alias-state-success-primary,#16a34a); }
.dshHk-badgeOff { background:rgba(148,163,184,0.14); color:var(--dsw-alias-label-tertiary); }
.dshHk-badgeErr { background:rgba(239,68,68,0.14); color:var(--dsw-alias-state-error-primary,#dc2626); }
.dshHk-meta { color:var(--dsw-alias-label-secondary); font-size:12px; line-height:18px; word-break:break-all; }
.dshHk-cardActions { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.dshHk-button { padding:5px 12px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:none; color:var(--dsw-alias-label-secondary); cursor:pointer; font-size:12px; }
.dshHk-button:disabled { opacity:0.5; cursor:not-allowed; }
.dshHk-buttonPrimary { background:var(--dsw-alias-brand-primary); color:var(--dsw-alias-label-primary-foreground); border-color:transparent; font-weight:600; }
.dshHk-buttonDanger { color:var(--dsw-alias-state-error-primary,#dc2626); }
.dshHk-toggle { position:relative; width:36px; height:20px; flex:none; border:none; border-radius:999px; background:rgba(148,163,184,0.4); cursor:pointer; transition:background 120ms ease; }
.dshHk-toggle[aria-checked="true"] { background:var(--dsw-alias-brand-primary); }
.dshHk-toggle::after { content:""; position:absolute; top:2px; left:2px; width:16px; height:16px; border-radius:50%; background:#fff; transition:transform 120ms ease; }
.dshHk-toggle[aria-checked="true"]::after { transform:translateX(16px); }
.dshHk-toggle:disabled { opacity:0.5; cursor:not-allowed; }
.dshHk-form { display:flex; flex-direction:column; gap:10px; padding:12px; border:1px solid var(--dsw-alias-border-l2); border-radius:10px; background:var(--dsw-alias-bg-layer-1); }
.dshHk-formTitle { margin:0; font-size:13px; font-weight:650; color:var(--dsw-alias-label-primary); }
.dshHk-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.dshHk-field { display:flex; flex-direction:column; gap:4px; min-width:0; }
.dshHk-fieldGrow { flex:1 1 240px; }
.dshHk-label { font-size:12px; color:var(--dsw-alias-label-secondary); }
.dshHk-input { box-sizing:border-box; width:100%; padding:6px 8px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); font-size:12.5px; }
.dshHk-radioGroup { display:flex; gap:14px; }
.dshHk-radioGroup label { display:inline-flex; align-items:center; gap:5px; font-size:12.5px; color:var(--dsw-alias-label-primary); cursor:pointer; }
.dshHk-fieldHint { font-size:11px; color:var(--dsw-alias-label-tertiary); line-height:16px; }
.dshHk-formActions { display:flex; gap:8px; flex-wrap:wrap; }
.dshHk-empty { padding:18px 12px; border:1px dashed var(--dsw-alias-border-l2); border-radius:10px; color:var(--dsw-alias-label-secondary); font-size:12.5px; line-height:20px; text-align:center; }
.dshHk-path { margin:0; color:var(--dsw-alias-label-tertiary); font-size:11px; word-break:break-all; }
/* Confirmation dialog (self-contained, mirrors the shell's in-frame-dialog idiom). */
.dshHk-mask { position:fixed; inset:0; z-index:2147483646; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,.35); font-family:system-ui,-apple-system,"Segoe UI",sans-serif; }
.dshHk-dialogCard { position:relative; width:340px; max-width:calc(100vw - 48px); background:var(--dsw-alias-bg-layer-1,#fff); border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,0.06)); border-radius:12px; padding:20px; box-shadow:0 12px 40px rgba(0,0,0,.28); }
.dshHk-dialogTitle { font-size:15px; font-weight:600; color:var(--dsw-alias-label-primary,#0f172a); margin-bottom:6px; }
.dshHk-dialogMessage { font-size:13px; color:var(--dsw-alias-label-secondary,#475569); line-height:1.6; }
.dshHk-dialogActions { display:flex; gap:8px; justify-content:flex-end; margin-top:16px; }
`
export function adoptStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = cssText
  document.head.append(style)
}
