/**
 * This plugin's id inside the shared office active claim. Kept in a neutral
 * module (neither half) because both the host routes and the browser capsule
 * need it, and the client bundle must not pull in the file-I/O module.
 *
 * @module @dsh-app/plugin-pdf/office-format
 */

import type { OfficeActiveFormat } from './office-active.ts'

/** This plugin's format id in `<DSH_HOME>/storages/dsh-app-office/active.json`. */
export const OFFICE_ACTIVE_FORMAT: OfficeActiveFormat = 'pdf'
