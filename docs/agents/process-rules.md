# Process rules

The rules that each cost this repository a bad day, with the reason each one
exists. Read the one your change touches; the repository-root `AGENTS.md`
carries a one-line index of them.

- **Gate commands must run bare — never behind a pipe**: `… | tail && git commit` commits on the
  pipe's exit code.
- **Deletes that can follow a link go through `scripts/lib/remove-tree.mjs` (`removeTree`), never a
  sync recursive call** — a profile must never hold a link that NAMES the runtime tree (mirrored in
  as HARDLINKS); `test/recursive-delete-guard.test.mjs` audits every sync recursive delete, and
  plugin store deletes use a private walker copy.
- **Session header hooks go through `installSessionHeaderRules`** — Electron keeps only the LAST
  `onBeforeSendHeaders` listener per session (measured on 44.4.1: a request matched by the first filter
  arrives with neither hook's headers), so a second `install*` call silently disables the first. The
  shell's two jobs (stamp its own action requests, authenticate the client's stream handshake) are both
  RULES behind one install; a rule declines a request it does not own by returning false, and a third
  registration is a bug by construction.
- **The host child runs a real Node, never Electron's own** — an `ELECTRON_RUN_AS_NODE` child dies
  with `unsupported Electron runtime fingerprint`.
- **On the web line the profile patch must not repeat the home layer's rows** — the composer loads
  `$DSH_HOME/cordis.patch.yml` as a LAYER, so a copy is refused (`duplicate loader entry id`); the
  desktop host (frames, dev) reads the profile patch alone, where the copy keeps the user's rows. And
  the `- id: web` overlay row is a PAIR — patch semantics replace the whole object, so naming only
  `searchProvider` drops `fetchProvider` and kills the tree on a duplicate loader entry.
- **A mirror into the profile owns PACKAGES, not a shared scope directory** — `@deepseek-ai` is shared with the
  market; a scope directory goes only with its last package; profile-lockfile names are the market's
  (`lockfileOwnedNames`); a bare `@scope` from an older shell narrows against `marker.runtime`. A removal must be
  WITNESSED by that recorded runtime's own `node_modules`: a name it does not carry, or a runtime that is gone, is
  left in place (`mirrorWitnessGap`) — residue is recoverable, a deleted user package is not. A profile whose
  manifest declares a package that is not installed is repaired before the host starts (`profile-heal.ts`),
  through the kernel CLI's `plugin install` with `DSH_HOME` pinned — the CLI resolves `--profile` as
  `$DSH_HOME/profiles/<name>`, never from its cwd.
- **The window's client state belongs to the kernel LINE that wrote it** — `client-state.ts` clears
  local storage on a line change (a per-line partition cannot work: fixed at window creation).
- **A suite plugin must be linked into the BOOTED PROFILE's `node_modules/@dsh-app`** — the enforcing
  resolver walks the profile's own `node_modules`; the shared link alone yields a silently vanilla
  UI, and `brand-suite.ts` re-links both scopes every start.
- **No backticks inside template-literal CSS/scripts** — `DESKTOP_CHROME_CSS` and the injected
  scripts are backtick literals; an embedded one silently terminates the string.
- **Injected `executeJavaScript` promises must not resolve eagerly** — the chrome-sync loop in
  `src/main/window.ts` re-enters on every resolution (an eager promise = a tight main↔renderer
  round-trip).
- **Upstream API drift**: slices and `as unknown as` casts bypass the type gate — a kernel-deleted
  API leaves tests green while the runtime throws; verify each plugin end-to-end after every
  kernel-line bump (`npm run verify`, `npm run check:plugins`). A name the line STOPPED exporting
  type-checks and is `undefined` at render. `test/plugin-kernel-imports.test.mjs` checks every named
  runtime import against the installed line's real exports (no kernel tree, no network), and
  `scratch/check-third-party-client-imports.mjs` runs the same check over a third-party plugin's
  sources.
- **Proxy: probe before injecting** — a TUN/fake-IP client resolves hostnames into `198.18.0.0/15`;
  the kernel installs its dispatcher once at boot, so a proxy that disappears later points every
  request at a closed port. `proxy-detect.ts` probes first (a TCP connect followed by an HTTP CONNECT
  probe — a bare connect would adopt any squatter on 7897/7890), an explicit user proxy wins, and the
  watchdog restarts only a shell-injected proxy. Injection is otherwise unconditional (a fake-IP
  machine needs it for `web_fetch`'s address validation); `DSH_APP_PROXY_INJECT=off` opts out. **The
  runtime pins `undici` to 8.10.2** (`scripts/build-runtime.mjs`): 8.11.0 narrowed the legacy
  wrapper's HTTP/1.1 downgrade to WebSocket upgrades, so with a proxy installed Node's BUILT-IN
  `fetch` read every provider response as header-less, undecoded bytes and every model list failed.
  Re-verify the pin on every kernel-line bump (`docs/kernel-0.1.7-alpha.1-regression.md` §12.13).
- **Web search is a provider, not a tool** — `web_search` / `web_fetch` stay upstream's; register a
  `ctx.web` provider (one per call), so fallback lives inside it. Both capabilities are the brand
  plugin's now: `plugin-websearch` also serves `web_fetch` (`fetchProvider: dsh-app-fetch`), keeping
  the host provider's contract and adding one thing — a poisoned resolver (TUN/fake-IP) is detected by
  canary and bypassed with DoH, the only way the host's own provider can pass its own public-address
  guard on such a network. It never patches `dns.lookup` process-wide: the host provider reads
  `dns/promises`, and a patch that wide would reach every lookup in the kernel child.
