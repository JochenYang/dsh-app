# Catalog source format

A **catalog source** is an https URL that answers a JSON document listing dsh
plugins the market panel can browse. This is the adapter contract: what a source
may publish, which fields the host reads, and which of them decide whether a row
is installable.

Two artefacts make up the contract, and they must be changed together:

- [`catalog-source.schema.json`](./catalog-source.schema.json) — the
  machine-readable half (JSON Schema 2020-12). Validate a document against it
  before publishing. Its `$id` is the raw URL of that same file on `main`, so an
  external tool can `$ref` it:
  `https://raw.githubusercontent.com/JochenYang/dsh-app/main/plugins/plugin-market/docs/catalog-source.schema.json`
- this file — the semantics the schema cannot express: id derivation, the
  install/update rules, and where the schema is deliberately stricter than the
  parser.

Both are bound to the implementation by
[`../tests/catalog-contract.test.ts`](../tests/catalog-contract.test.ts). That
suite parses the whole `src/` tree with the TypeScript compiler
(`../tests/catalog-drift-scan.ts`) and extracts every key read off a catalog
document or one of its rows — property access, index access, `'x' in record`,
destructuring, `Object.keys`, and reads moved into a helper — then requires that
set to equal the fields the schema declares, the fields this file documents, and
the fields the parser's fixture engine can exercise. A parse field that reaches
only one of the three fails `npm test` in `plugins/plugin-market`, not just a
review. The same suite validates unedited excerpts of the two live sources
(`../tests/fixtures/`), so the schema is checked against bytes this project did
not author.

The parser itself is `src/catalog.ts` (`parseCatalogDocument` is the entry point
both a fetched body and the bundled offline snapshot flow through).

## 1. The document

- The body parses as a JSON **object** with a `plugins` **array**
  (`src/catalog.ts:396`). Anything else yields zero rows; on the fetched path a
  non-JSON body is refused with `catalog.notJson` and a non-object document with
  `catalog.notObject`.
- Documents are capped at 8 MB per source, 5000 entries per source and 8000
  entries after merging (`MAX_BYTES_PER_SOURCE`, `MAX_ENTRIES_PER_SOURCE`,
  `MAX_ENTRIES_TOTAL`).
- Transport is separate from the document: the default enabled source is
  `npm:<package>@<registry base>`, which reads the same document out of a
  published npm tarball entry (`package/plugins.json`). A source's URL — https
  only, no credentials, no private host — is validated by `validateSourceUrl`
  and is **not** part of this schema.

## 2. Document shapes and how they are sniffed

The shape is decided by the **first object row** of `plugins`, in this order
(`src/catalog.ts:359`, `:378`, `:406`):

| Shape | Recognized by | Decided at |
| --- | --- | --- |
| store document | top-level `categories` is an **array** AND the first object row carries an `install` string starting with `dsh plugin ` | `isStoreDocument` |
| aggregated document | otherwise, the first object row has an `npm` **or** `category` key | `isAggregatedDocument` |
| custom document | otherwise (a first row with neither key) | fallback |

Store is sniffed first because store rows also carry `category`, which would
otherwise route them into the aggregated path and strip their npm identity. The
`categories` shape is decisive, not the install command: the primary
aggregated directory ships install commands on its rows too.

Consequences for an author: keep the document **homogeneous** (one shape for all
rows), and do not add `npm` or `category` to a custom-schema row — a single such
key on the first row moves the whole document to the aggregated path, where the
custom rows' `package` field is not read and every row degrades to a
non-installable entry. Mis-sniffing never produces a *wrong* install target, only
a lost one (`src/catalog.ts:356`).

Shape-specific fields follow. `Required` is what a conforming row must carry
(`yes` = always, `conditional` = one of the row's routing keys, `no` = optional)
and `Type` is the schema's own type at that field, both checked against the
schema by the suite. The parser's exact tolerance is in §7.

## 3. Custom schema

Every row names a real npm package; the row is installable with no further
qualification. Document keys: `plugins` (required); extra keys are ignored.

### Row fields: custom schema

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | string (≤400) | no | Stable entry id. Falls back to `package`. |
| `name` | string (≤400) | yes | Display name. |
| `description` | string (≤400) | yes | One-line description. A plain string only — an `{en, zh}` object is not localized in this shape and drops the row. |
| `package` | npm name (≤214) | yes | Install target, merge/dedupe key, and the fallback id. |
| `version` | string (≤100) or null | no | Source-declared version. Display only — never installed verbatim (§6). `null` means the source carries none. |
| `homepage` | http(s) URL | no | Source-declared homepage. Must be an http(s) URL or the whole row is dropped. |

## 4. Aggregated directory schema

Large community directories. Document keys: `plugins` (required), `categories`
(optional, an **object** map `id → {en, zh}`); extra keys are ignored. A row's
npm identity is optional, and a row without one stays browsable.

Derived values:

- **entry id** = `page` → `url` → `name` (first usable one).
- **merge key / `package`** = the usable `npm` name, else the same
  `page`/`url`/`name` chain.
- **display name** = `name`, except when `name` contains `#` (a repository path
  used as an id, e.g. `archify#integrations/deepseek-harness`): the row is
  dropped unless a usable `npm` name exists, and that name becomes the title.
- **category**: `categoryId` is the filter key when present, otherwise the raw
  `category` value is both key and (fallback) label; the label comes from the
  document map's `zh`, else its `en`, else that raw value. The empty string means
  uncategorized.

### Row fields: aggregated directory

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `name` | string (≤400) | yes | Display name (see the `#` rule above). |
| `description` | string or {en, zh} | yes | Display copy; `zh` wins, `en` is the fallback. Over-length copy is truncated for display. |
| `page` | string (≤400) | no | The directory's own page for the row; the stable id. |
| `url` | http(s) URL | no | Repository/homepage; also where the install chain derives the repository identity from. |
| `npm` | npm name (≤214) or null | conditional | The npm identity. `null` (or an unusable name) means the row ships from a repository instead of npm. A row must carry `npm` or `category` to route the document here. |
| `install` | install command | no | `dsh plugin … add <target>`; only the trailing token is read. |
| `version` | string (≤100) or null | no | Display only — never installed verbatim (§6). `null` is this source's way of saying it carries none. |
| `owner` | string (≤100) or null | no | Maintainer handle. Display only. |
| `stars` | integer ≥ 0 or null | no | Display and search-ranking only. |
| `downloads` | integer ≥ 0 or null | no | npm downloads over the source's reporting window. Display and search-ranking only; `null` or absent means untracked, never zero. |
| `category` | string (≤100) | conditional | Category id (`''` = uncategorized). Needed when the row has no `npm`. |
| `categoryId` | string (≤100) | no | Explicit stable category key; wins over `category` as the filter key. |

## 5. Store directory schema

The paged community store. Document keys: `plugins` (required) and `categories`
(required, an **array** of `{id, en, zh, count}` objects); extra keys — the real
store's `page`, `limit`, `total`, `installCount` — are ignored. The npm identity
is not a field: it is extracted from the row's install command.

Derived values:

- **entry id** = `id` → `url` → `name`. The store id is unique per row (several
  rows may share one repository URL), so it is the fallback id and the dedupe key
  for rows with no npm target.
- **merge key / `package`** = the npm name extracted from `install`, else the
  entry id.
- **category**: as in §4, resolved through the `categories` ARRAY.
- A row with no usable description keeps an empty description; the panel renders
  its own placeholder.

### Row fields: store directory

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | string (≤200) | no | Store entry id; the fallback id and dedupe key. |
| `name` | string (≤400) | yes | Display name. A row without one is dropped. |
| `description` | string or {en, zh} | no | Display copy; missing stays empty. |
| `url` | http(s) URL | no | Repository/homepage; the fallback id, and where the repository identity comes from. |
| `category` | string (≤100) | no | Category id (`''` = uncategorized). |
| `categoryId` | string (≤100) | no | Explicit stable category key; wins over `category`. |
| `install` | install command | yes | `dsh plugin … add <target>`; the trailing token is the row's install target. |
| `installs30d` | integer ≥ 0 or null | no | Store-declared 30-day install count. Display only. |
| `owner` | string (≤100) or null | no | Maintainer handle. Display only. |
| `stars` | integer ≥ 0 or null | no | Display only. |

### Category label fields: aggregated document

Top-level `categories` **object**: id → label.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `en` | string (≤400) | no | English label. |
| `zh` | string (≤400) | no | Chinese label; preferred when both are present. |

### Category label fields: store document

Top-level `categories` **array** item.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | string (≤100) | yes | Category key rows refer to. Its being an array is what identifies the store shape. |
| `en` | string (≤400) | no | English label. |
| `zh` | string (≤400) | no | Chinese label; preferred when both are present. |

## 6. Installability, updates and identity

**`installable`** — the flag the panel shows and the install route refuses on
(`entry.installable === false` → `install.notInstallable`):

- custom row: always installable (the shape emits no flag at all).
- aggregated row: a usable `npm` name, **or** an accepted git target in
  `install`. Otherwise the row is source-only: browsable, not installable.
- store row: the `install` command names either an npm package or an accepted
  git target.

**The declared `version` is never installed verbatim.** It is display metadata:
the install chain resolves the version from the npm registry (`latest`, or a
user-specified exact version that is then verified against the registry
manifest — `src/npm.ts`). An update check therefore compares the installed
version against the registry's, not against what the source declares.

**Install commands.** The published `installCommand` pattern is not hand-written:
it is the parser's own two target grammars spliced into an install-target
alternative — `PACKAGE_NAME_PATTERN` (with the optional npm version suffix the
parser strips, scope-aware: `@scope/pkg@1.2.3` → `@scope/pkg`, `pkg@1.2.3` →
`pkg`) and `GIT_TARGET_PATTERN` — anchored so the **last** whitespace-separated
token is the target. A command the pattern accepts therefore names a target the
install chain could act on; the command itself is never retained and never
executed.

**Git-shaped rows.** The one accepted grammar is a GitHub shortcut with an
optional immutable pin — `GIT_TARGET_PATTERN`, `src/catalog.ts:555`:

```
github:<owner>/<repo>            # up to 39 / 100 characters
github:<owner>/<repo>#<40-hex>   # commit pin, preserved verbatim
```

Everything else stays source-only: other hosts, `git+https://`, branch or tag
selectors, and `#path:` monorepo fragments are refused rather than re-pinned,
because a selector the parser would rewrite is a target the install chain cannot
verify. A pinned row also has to **prove its repository identity**: the install
intent derives the repo key (`host/owner/repo`, lowercase) from the entry's
`homepage` — one of `github.com`, `gitlab.com`, `gitee.com` — and refuses a git
row that proves none with `install.gitTargetInvalid` (`src/install-intent.ts:378`).
A git row therefore needs a `url`/`homepage` pointing at its repository, even
though the install target itself is the `github:` shorthand.

**Display-only fields**: `version`, `owner`, `stars`, `downloads`,
`installs30d`, and the category *label*. None of them can make a row installable
or change which version is installed.

**Dedupe**: the merged catalog keys on `package` with first-source-wins, then
source order, then row order.

## 7. Strictness: where the schema differs from the parser

The schema describes a **conforming** source. The parser is deliberately more
tolerant in one direction — it degrades an unusable field instead of refusing a
whole document — so a document that fails the schema is not necessarily refused:

- **`null` on a display field is accepted** (`version`, `owner`, `stars`,
  `downloads`, `installs30d`) — *aligned with the parser*, not a convenience
  loosening: the parser reads every one of them through a helper that folds an
  unusable value into "absent", and the primary directory publishes
  `"version": null` on 2177 of its 4527 rows and `"downloads": null` on 2179 of
  them (`"npm": null` on 2177, which the schema already allowed). A `null` on a
  REQUIRED or structural field (`name`, `package`, `install`, `plugins`, …) is
  still refused: neither live source publishes one, and there the parser's
  fold-to-absent really does drop the row (`description` included — see below).
- **`install` values naming no usable target are refused**, while the parser
  keeps the row browsable and not installable. This is the *only* remaining
  class of real, published data the schema rejects: 388 of the primary
  directory's 4527 rows (167 `github:…#path:` monorepo fragments, 221 quoted
  release-tarball URLs) and 28 of the store page's 100. For every one of them
  the parser extracts no target either — the schema's refusal is not stricter
  than the parser's ability, it is a statement that such a row is not a
  conforming row. The published pattern is also case-sensitive where the parser
  is not: `GitHub:owner/repo` (an upper-case scheme prefix) and an upper-case
  commit pin are accepted by the parser and refused by the schema, because a
  JSON Schema `pattern` carries no `i` flag. The suite pins both cases.
- One real store row names a target the schema accepts and the parser cannot
  extract: `dsh plugin --profile web add --allow-build=@dsh-external/… github:yjh051108/dsh-routing-suite`
  (row 39, index 38, of the store's first page). The trailing token is a valid
  GitHub shortcut, so the command is well-formed; the parser's extraction
  requires the token right before the target to be `add`, so the row stays
  source-only. The suite pins that exact pair of verdicts (`contract
  conformance: the documents the live sources serve`).
- A required field that the parser cannot use **drops the row** (a custom row
  with a bad `package`, any row without a usable `name`, an aggregated row
  without usable `description`, a store row without `name`). These are schema
  errors too.
- An unusable **optional** field is ignored: `npm: "not a package name"` makes
  the row source-only, `stars: 1.5` or `installs30d: "12"` simply leaves the
  count off, an over-cap `owner` reads as absent. The schema rejects all of them,
  because publishing one is a mistake even when it is survivable.
- `description: ""` is rejected by the schema; a store row keeps it as an empty
  description (an aggregated row is dropped for it, being required there). A
  `null` description is rejected too, though the parser would fold it to absent
  and then drop the aggregated row anyway.
- A custom row must not carry `npm`/`category`: the schema refuses to call such a
  row a custom row, and the document itself validates as an *aggregated*
  document — which is what the parser does with it, silently turning a declared
  `package` into an entry id and losing the install target (§2).
- Extra keys are legal at the document and row level in both places; the parser
  ignores them, and so does the schema (`additionalProperties`). The top-level
  keys the bundled snapshot adds beyond the schema's own fields — `name`,
  `generatedAt`, `sourceUrl` — are legal for that reason; `generatedAt` is the
  only one anything reads (`src/snapshot.ts`).
- The bundled offline snapshot is an aggregated document and validates against
  the schema; so the schema covers both a fetched source and the shipped
  fallback.

## 8. Field length caps

Lengths are JavaScript string lengths (UTF-16 code units), which is the unit the
parser's caps use. Over-cap **required** values drop the row; over-cap
**optional** values read as absent; over-cap *descriptions* in the aggregated and
store shapes are truncated to 400 characters with a trailing `…` instead of
dropping anything.

| Cap | Fields |
| --- | --- |
| 214 | `package`, `npm` |
| 200 | store `id` |
| 100 | `version`, `owner`, `category`, `categoryId` |
| 400 | `name`, `description` (custom), `page`, `url`, custom `id` |

## 9. Conformance fixtures

`tests/fixtures/` holds three unedited excerpts of the two live sources, so the
suite can assert the contract against bytes this project did not author:

| File | Source | Rows |
| --- | --- | --- |
| `real-aggregated-rows.json` | `dsh-plugin-catalog` (npm tarball `package/plugins.json`, sha256 `859ef38fce5abf82f05be90622ebec730c423370eebd97b2a65dc59840907f0b`, 4527 rows, fetched 2026-10-13) | 3: a `#`-named row with an npm name, an ordinary npm row, and a `npm: null` row carrying `"version": null` / `"downloads": null` |
| `real-refused-rows.json` | same source | 2: rows the schema refuses and the parser cannot install from either (§7) |
| `real-store-rows.json` | `https://deepseek1024.com/api/v2/plugins?page=1&limit=100` (sha256 `51feef412190ea1fed3c3064a3dcdef6529ff0c61f3c9f27ea7f2b16b1669b10`, 100 rows, fetched 2026-10-13) | 2: the `--allow-build=…` row and an ordinary npm row |

Row-level fields are verbatim; the documents' `categories` maps keep only the
ids those rows name. The suite asserts each row's schema verdict and the parser's
own projection of it.
