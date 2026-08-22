/**
 * DSH APP sidebar dock — browser entry (loader-facing).
 *
 * The dsh client module loader resolves this file via the package's
 * `./client` export; the real client half lives in ./client/index.tsx.
 */
export { inject, apply } from './client/index.tsx'
