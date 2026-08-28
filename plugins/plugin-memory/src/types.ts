/**
 * Shared shapes of the memory plugin (host ↔ client wire types + entry model).
 *
 * @module @dsh-app/plugin-memory/types
 */

/** Entry categories the save tool accepts. Small by design: five buckets
 * cover what actually deserves cross-session persistence, and a closed set
 * keeps the file greppable and the tool schema honest. */
export const MEMORY_CATEGORIES = ['preference', 'convention', 'decision', 'lesson', 'fact'] as const

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number]

/** One project's memory summary in the settings page. */
export interface MemoryProjectSummary {
  /** Directory slug under projects/ (basename + 8-hex of the cwd). */
  slug: string
  /** Full workspace path (from project.json; '' when unreadable). */
  cwd: string
  entries: number
  sizeBytes: number
}

/** One background-distill run's trace entry (settings-page transparency). */
export interface MemoryDistillActivity {
  /** Unix epoch ms when the distill ran. */
  at: number
  /** Short session id (first 8 hex) the run distilled. */
  session: string
  /** Entries the run persisted (0 = it ran but nothing new qualified). */
  saved: number
}

/** Response of GET api/status — the settings section's whole world. */
export interface MemoryStatus {
  /** Whether memory injection + tools are active (master toggle). */
  enabled: boolean
  /** Whether the background distiller pass is active (sub-toggle). */
  distill: boolean
  /** GLOBAL file entry count. */
  entries: number
  /** GLOBAL file size in bytes. */
  sizeBytes: number
  /** GLOBAL memory file path, shown so the user can edit it by hand. */
  filePath: string
  /** Per-project summaries, largest first. */
  projects: MemoryProjectSummary[]
  /** Recent background-distill traces, newest first (bounded list). */
  activity: MemoryDistillActivity[]
}
