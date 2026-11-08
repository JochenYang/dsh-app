/**
 * One provider template from the catalog, plus the catalog's own helpers.
 *
 * Provenance: the catalog data is ported from dsh-provider-studio v1.3.1 (MIT),
 * whose directory comes from [models.dev](https://github.com/sst/models-dev)
 * (MIT). Only the three protocols `llm-pi-ai` speaks are kept; vendors that need
 * a proprietary SDK (Google, Bedrock, Azure, …) are absent by design.
 *
 * Chinese copy lives in this package's dictionary under `tpl.<id>.<field>`; the
 * English text stays in the data so the catalog reads and compares as one list.
 *
 * @module @dsh-app/plugin-client-ui/client/models-advanced/templates/types
 */

/** One provider preset. */
export interface ProviderTemplate {
  /** Route id the preset suggests (also the credential-name stem). */
  readonly id: string
  /** Logo key in the packaged icon set, when the vendor has one. */
  readonly icon?: string
  /** Picker text (English source; Chinese may override through `i18n`). */
  readonly label: string
  /** Display name the preset creates. */
  readonly displayName: string
  /** Picker group id (see the `group*` locale keys). */
  readonly group: string
  /** Wire protocol. */
  readonly api: string
  /** Endpoint the preset fills in. */
  readonly baseURL: string
  /** One-line note shown under the picker card (e.g. the China-site host). */
  readonly note?: string
  /** Dictionary keys for the fields whose Chinese copy differs. */
  readonly i18n?: Partial<Record<'label' | 'displayName' | 'note', string>>
}
