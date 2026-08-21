import type { KernelManager } from '../kernel/manager'
import type { KernelInfoPayload } from '../shared/types'

/**
 * The subset of app control the shell surfaces (tray menu) can drive.
 * Implemented by the controller in src/main/index.ts to avoid circular imports.
 */
export interface AppController {
  kernel: KernelManager
  installKernel: () => Promise<void>
  applyKernelUpdate: () => Promise<void>
  checkKernelUpdate: (manual: boolean) => Promise<void>
  getKernelInfo: () => KernelInfoPayload
}
