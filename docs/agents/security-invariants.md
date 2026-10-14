# Security invariants

The rules a change must not weaken. Design context is `docs/ARCHITECTURE.md` §7.

These are invariants, not preferences; a change that weakens one needs a security
review, not a fixup. The repository-root `AGENTS.md` carries a one-line index of
them; this file carries each one's reasoning.

- **Main window**: `contextIsolation`, `sandbox`, `nodeIntegration:false`, and a preload exposing
  **exactly one frozen marker** (`window.dshDesktop`, `src/main/account-preload.ts`) — the kernel's
  account UI registers only when that key is present, and nothing else needs a bridge. A second
  preload serves the embedded Platform view (`src/main/platform-preload.ts`), its own `WebContentsView`
  in its own partition, not exposed to the app document. **Neither may grow a channel without a
  security review.**
- **Navigation** is confined to `dsh-app://app` plus the shell's own splash `file:` document (`src/main/nav-policy.ts`
  compares protocol + hostname — a custom scheme's URL `origin` is the literal string `"null"` in every realm).
  Everything else goes to `shell.openExternal` (http/https only).
- **No port — on the frames line**: the kernel child's web surface travels fd3/fd4 byte pipes; the
  window loads `dsh-app://app/index.html`, a scheme registered privileged **before** `app.ready` and
  served only by forwarding to that child (other host → 404, no host → 503). A `0.1.6-alpha.2+` host
  binds its own loopback port instead and the shell forwards with a cookie.
- **An app-origin document never goes into a sandbox frame** — the action route trusts the top
  frame's stamped initiator alone, while a sandboxed iframe reports the app's URL from an opaque
  origin (`src/main/shell-actions.ts`).
- **Plugin `/api` routes** are fenced by the Connection carrier (Host/Origin check **plus** browser
  auth before a handler runs); a suite plugin registers with `ctx.connection.fetch.register(...)` and
  answers `/api/plugins/dsh-app/<plugin>/<name>` (no `@` in a segment, GET/HEAD/POST only); the host's
  `webserver` row stays disabled.
- **Kernel downloads** are sha512-verified before activation, with metadata from the official host first so a mirror
  cannot swap content. Bytes come official → the ModelScope copy → the public proxies (`assetCandidates`): the mirror
  is a file this project itself publishes, while ghfast.top / gh-proxy.com are third-party transports. Tar extraction
  treats every archive as untrusted — absolute paths, `..` segments and link entries whose target leaves the
  extraction root are all refused.
- **Never hardcode secrets.** dsh's credential store is the store; plugin keys support `$ENV:NAME`
  and are masked on read.
- **Redact credential-looking fragments** (`api[key|_key]`, `authorization`, `token`, `secret`, `password`) in child
  logs, and cap line length. The shareable `dsh-events.jsonl` records derived fields only — never a raw error
  message, which can hold a feed URL, a command line, a path or a credential.
