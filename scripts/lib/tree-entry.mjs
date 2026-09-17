// One entry of a packaged tree, and the walk that records a tree of them.
//
// Why the classification is a function of its own: the build host's platform
// decides what pnpm leaves in `node_modules/.bin` — symlinks on POSIX, real
// `.cmd`/`.ps1` files on Windows — so the runtime inventory only ever met a link
// on the four POSIX CI cells, where it failed the whole build with "runtime tree
// holds a non-file entry" while both Windows cells stayed green on the same
// commit (run 35189579648). The classifier is pure logic over a dirent/lstat
// shape, so a Windows machine can test the shape only a POSIX build produces.
//
// A symlink is RECORDED, not rejected: pnpm's `.bin` shims are links into the
// tree, they are what a POSIX artifact has always carried, and the artifact
// itself is self-contained as long as the target stays inside it. A link that
// leaves the tree is still a build failure — that one would dangle on the user's
// machine, which is what the strictness was protecting against.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readlink, stat } from 'node:fs/promises'
import path from 'node:path'

/** A regular file: the only kind that carries bytes, a size, a mode and a hash. */
export const TREE_ENTRY_FILE = 'file'
/** A directory: the walk descends into it and records nothing for it. */
export const TREE_ENTRY_DIR = 'dir'
/** A symlink (or Windows junction): recorded as a target, never followed. */
export const TREE_ENTRY_LINK = 'link'
/**
 * Anything else — a FIFO, a socket, a device node. No archive describes these
 * portably and no runtime needs one, so a caller must not treat one as content.
 */
export const TREE_ENTRY_OTHER = 'other'

/**
 * Which of the four kinds one entry is.
 *
 * Takes a `readdir({ withFileTypes: true })` Dirent or an `lstat` Stats — both
 * answer the same three questions. The link test comes first: a `stat` (not
 * `lstat`) shape reports a symlink to a directory as `isDirectory()` too, and
 * what the artifact carries is the link, not what it points at.
 * @param entry - dirent or lstat-shaped object.
 * @returns one of TREE_ENTRY_FILE / TREE_ENTRY_DIR / TREE_ENTRY_LINK / TREE_ENTRY_OTHER.
 */
export function classifyTreeEntry(entry) {
  if (entry.isSymbolicLink()) return TREE_ENTRY_LINK
  if (entry.isDirectory()) return TREE_ENTRY_DIR
  if (entry.isFile()) return TREE_ENTRY_FILE
  return TREE_ENTRY_OTHER
}

/**
 * The recordable target of a symlink, or null when the link leaves `treeRoot`.
 *
 * Recordable means relative to the link's own directory and inside the tree: an
 * absolute target or a `../..` escape would name the build host's own tree,
 * which is not where the artifact lands, so such a link would be dangling for
 * the user. An absolute target that does resolve inside the tree is accepted and
 * rewritten relative, which is what keeps the inventory a pure function of the
 * content rather than of the machine that built it.
 * @param treeRoot - absolute path of the tree being recorded.
 * @param linkPath - absolute path of the link itself.
 * @param target - the raw `readlink` value.
 * @returns the relative, forward-slashed target; null when the link escapes.
 */
export function linkTargetWithinTree(treeRoot, linkPath, target) {
  const linkDir = path.dirname(linkPath)
  const resolved = path.resolve(linkDir, target)
  const fromRoot = path.relative(path.resolve(treeRoot), resolved)
  if (path.isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`)) return null
  const relative = path.isAbsolute(target) ? path.relative(linkDir, resolved) : target
  return relative.split(path.sep).join('/')
}

/**
 * Walk a tree and record every file and every link in it.
 *
 * The files list is what the artifact's reproducibility and layer checks read,
 * so it stays exactly what it always was: regular files only, path/size/mode/
 * sha256, sorted. Links come back as a group of their own — they carry no bytes
 * of their own, and folding one into the files list would put an entry without a
 * size or a hash in front of code that expects both.
 *
 * Strictness kept from the caller it was factored out of: a hard-linked file and
 * a special entry both fail the walk. A shared inode becomes a tar hard-link
 * entry that GNU tar refuses to extract when the target comes later in the
 * stream, and a socket or FIFO cannot be described by any inventory at all.
 * @param treeRoot - absolute path of the tree to record.
 * @param options.skip - relative POSIX paths to leave out (the caller's own output file).
 * @returns `{ files, links }`, both sorted by path; files carry size/mode/sha256.
 */
export async function collectTreeEntries(treeRoot, { skip = [] } = {}) {
  const skipped = new Set(skip)
  const files = []
  const links = []
  async function walk(current, relative) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (skipped.has(next)) continue
      const full = path.join(current, entry.name)
      const kind = classifyTreeEntry(entry)
      if (kind === TREE_ENTRY_DIR) {
        await walk(full, next)
        continue
      }
      if (kind === TREE_ENTRY_LINK) {
        const target = await readlink(full)
        const recorded = linkTargetWithinTree(treeRoot, full, target)
        if (recorded === null) {
          throw new Error(`runtime tree holds a link that leaves it: ${next} -> ${target} — the artifact must be self-contained`)
        }
        links.push({ path: next, target: recorded })
        continue
      }
      if (kind !== TREE_ENTRY_FILE) {
        throw new Error(`runtime tree holds a non-file entry: ${next} (neither a file, a directory nor a link)`)
      }
      const stats = await stat(full)
      if (stats.nlink > 1) {
        throw new Error(`runtime tree holds a hard-linked file: ${next} (nlink=${stats.nlink}) — the artifact must be independent files`)
      }
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(full)) hash.update(chunk)
      files.push({
        path: next,
        size: stats.size,
        // Git-style mode: the exec bit is the only permission that survives
        // packaging, and the kernel's node/node[.exe] must keep it.
        mode: (stats.mode & 0o111) === 0 ? '100644' : '100755',
        sha256: hash.digest('hex'),
      })
    }
  }
  await walk(treeRoot, '')
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  links.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { files, links }
}
