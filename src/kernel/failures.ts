/**
 * Failure wording for a kernel download that ran out of sources.
 *
 * A user staring at "download failed (4 sources tried): fetch failed" cannot
 * tell whether to fix their network, wait for a release to finish, or stop
 * trusting the machine's route to the internet — and those need three different
 * actions. The classification below is deliberately based on what we ourselves
 * threw (the integrity message) plus the only other shape that matters (an HTTP
 * answer versus no answer at all), so it stays true without inspecting error
 * types across a fetch boundary.
 *
 * The wording is localized (`shared/locale.ts`), and so are the two own-message
 * patterns the classifier looks for: they are derived from the SAME keys the
 * kernel's throwers use (`messageHead`), because a copied literal would only
 * match the language it was copied in. The HTTP status is language-neutral and
 * stays a regex.
 */
import { messageHead, t } from '../shared/locale'

/** Why every candidate failed. */
export type DownloadFailureKind =
  /** Content arrived but matched neither the tarball nor the layer digest. */
  | 'integrity'
  /** A source answered HTTP, but never with the artifact (404 while CI uploads). */
  | 'missing'
  /** Nothing answered: offline, blocked, or a proxy that is not forwarding. */
  | 'network'

/**
 * Classify the last error seen after exhausting every candidate.
 *
 * The two own-message patterns are the constant head of the messages this
 * repo's kernel downloader throws (`manager.ts`, in the locale in effect): a
 * digest mismatch it detects itself, and its "no runtime artifact" report. The
 * head is read per call rather than cached at module load — the table resolves
 * its locale lazily (see the locale module header), so a module-level copy could
 * freeze the default language into the pattern.
 */
export function classifyDownloadFailure(lastError: Error | null): DownloadFailureKind {
  const message = lastError?.message ?? ''
  // Ours, and the one failure a user must NOT be told to simply retry: a digest
  // mismatch means something in the path changed the bytes.
  if (message.includes(messageHead('kernel.integrityFailed'))) return 'integrity'
  // 404/410 are the "published on npm, artifacts not built yet" window the shell
  // already probes for, so it deserves its own wording here too.
  if (/HTTP (?:404|410)\b/u.test(message) || message.includes(messageHead('kernel.artifactMissing'))) return 'missing'
  return 'network'
}

/**
 * One actionable line plus the raw cause, which the failure card renders under
 * it. The cause is kept because support needs it and it carries no secret — it
 * is a URL-less HTTP status or a fetch error.
 * @param kind - the classification.
 * @param candidates - how many sources were tried (reassures that failover ran).
 * @param detail - the last raw error message, when there was one.
 */
export function describeDownloadFailure(kind: DownloadFailureKind, candidates: number, detail: string | null): string {
  const sources = t('downloadFailure.sources', { count: candidates })
  const reason = detail === null || detail === '' ? '' : t('downloadFailure.reason', { detail })
  switch (kind) {
    case 'integrity':
      return t('downloadFailure.integrity') + reason
    case 'missing':
      return t('downloadFailure.missing', { sources }) + reason
    case 'network':
      return t('downloadFailure.network', { sources }) + reason
  }
}
