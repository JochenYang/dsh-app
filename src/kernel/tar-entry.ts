import path from 'node:path'

/**
 * Tar extraction containment. An archive is untrusted input even when its
 * digest matched the release metadata: the metadata proves the bytes came from
 * the publisher, not that the publisher's build was not tampered with
 * upstream, and a runtime tree holds executables that run with the user's
 * rights. Both checks below are run on every entry of every extraction.
 */

/** A member path must be relative and must not climb out of the extraction root. */
export function isSafeArchivePath(entryPath: string): boolean {
  // A drive-relative path (`C:evil`) is neither absolute nor a `..` climb, and
  // node-tar resolves a link's target with path.resolve — on Windows that
  // lands at the root of another volume, outside the extraction tree. Any
  // colon form is refused for the same reason: it names a device or drive.
  if (/^[A-Za-z]:/.test(entryPath)) return false
  return !path.isAbsolute(entryPath) && !entryPath.split('/').includes('..')
}

/**
 * The `filter` node-tar hands each entry through. On top of the member path it
 * refuses a link entry whose TARGET leaves the extraction root: node-tar does
 * not constrain `linkpath`, so `link -> ../../..` followed by `link/evil`
 * writes outside `cwd` on disk. A link whose target stays inside the archive
 * (the normal case for hardlinked node_modules files) is allowed.
 *
 * The entry argument is typed loosely on purpose: `@types/tar` describes the
 * second filter parameter as an `fs.Stats`-like object, but node-tar passes
 * its own `ReadEntry`, whose `type` is the header string and whose `linkpath`
 * carries the link target. The runtime shape is what is checked here.
 */
export function tarExtractionFilter(
  entryPath: string,
  entry?: { type?: unknown; linkpath?: unknown } | null,
): boolean {
  if (!isSafeArchivePath(entryPath)) return false
  const kind = entry?.type
  if (kind === 'SymbolicLink' || kind === 'Link' || kind === 'HardLink') {
    const target = entry?.linkpath
    // A link without a resolvable target is either malformed or an attempt to
    // dodge the check; treat both as unsafe.
    if (typeof target !== 'string' || target === '') return false
    return isSafeArchivePath(target)
  }
  return true
}
