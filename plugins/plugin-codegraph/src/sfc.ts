/**
 * Component files: their code, at its own line numbers.
 *
 * A `.vue`, `.svelte` or `.astro` file is a container — markup, styles, and one region of
 * code. Nothing in the markup is a declaration this graph can hold, and the code region
 * is already plain TypeScript or JavaScript: a `<script>` block for the first two, the
 * `---` frontmatter for Astro. So the honest way to read one is to hand that region to
 * the grammar the plugin already ships, and the only real question is line numbers: a
 * symbol reported at line 4 of the region would be a lie about a 200-line file.
 *
 * The answer here is a MASK, not a slice. Everything outside the code region is replaced
 * by spaces while every newline is kept, so the code sits at its original row and column
 * and the parser sees it exactly as the author placed it. A slice would need an offset
 * threaded through the whole extraction path; a mask needs no offset at all, because
 * there is nothing to offset.
 *
 * What this does NOT do: template expressions (`{{ item.name }}`, `@click="save"`).
 * They are JavaScript, but they are not declarations, and a click handler that names a
 * method is a *use* — the call graph already gets it from the method's own body.
 *
 * One grammar for every shape: the region is read with the TypeScript grammar whatever
 * `lang` says, because TypeScript is a superset of what a plain `<script>` contains and a
 * second grammar would have to be shipped to gain nothing. The cost is JSX inside a
 * component (`<script lang="tsx">`, an `.astro` template expression), which is not read —
 * rare enough to state rather than to pay for.
 *
 * @module @dsh-app/plugin-codegraph/host/sfc
 */

/**
 * The languages whose files are containers rather than source, and which region holds
 * their code.
 *
 * `script` is a `<script>` block (Vue, Svelte); `frontmatter` is the `---` block at the
 * top of an Astro file, which is TypeScript with no tag around it.
 */
const COMPONENT_LANGUAGES = new Map<string, 'script' | 'frontmatter'>([
  ['vue', 'script'],
  ['svelte', 'script'],
  ['astro', 'frontmatter'],
])

/** A `<script …>` … `</script>` pair, by offsets into the source. */
interface ScriptBlock {
  readonly start: number
  readonly end: number
}

/**
 * Find every top-level `<script>` block.
 *
 * A Vue component may carry two (`<script>` and `<script setup>`) and both are code, so
 * all of them are returned. The search is a plain scan rather than a real parser on
 * purpose: the grammar for the CONTAINER is not something this plugin ships, and adding
 * one to find two tags would be a dependency bought for a string search.
 *
 * @param source - the component's text.
 * @returns the blocks, in source order.
 */
function scriptBlocks(source: string): ScriptBlock[] {
  const blocks: ScriptBlock[] = []
  const opening = /<script\b([^>]*)>/giu
  for (let match = opening.exec(source); match !== null; match = opening.exec(source)) {
    const start = match.index + match[0].length
    // The FIRST `</script>` after the opening tag closes it. A string literal holding
    // that sequence inside the script would truncate the block — accepted, because the
    // alternative is parsing the script to find its own end, and a broken mask shows as
    // missing symbols rather than as wrong ones.
    const close = source.toLowerCase().indexOf('</script>', start)
    if (close === -1) break
    blocks.push({ start, end: close })
    opening.lastIndex = close + '</script>'.length
  }
  return blocks
}

/**
 * The script portions of a single-file component, positioned as written.
 *
 * @param source - the component's text.
 * @returns the masked script text, or `undefined` when there is no script block to read
 *   (a template-only component declares nothing, and saying so is better than parsing
 *   markup as JavaScript).
 */
export function sfcScript(source: string): { readonly text: string } | undefined {
  const blocks = scriptBlocks(source)
  if (blocks.length === 0) return undefined
  // Every character except a newline becomes a space, one space PER CODE UNIT: the mask
  // has to preserve the byte-for-character geometry, or the script lands at wrong offsets
  // and every symbol's line is off. No `u` flag on the character class, because with it
  // the replace matches by CODE POINT and an astral character (an emoji in a template)
  // becomes one space where it occupied two units — measured: one emoji above the script
  // moved a declaration from line 3 to line 4.
  const parts = source.replace(/[^\n]/g, ' ').split('')
  for (const block of blocks) {
    for (let index = block.start; index < block.end; index++) parts[index] = source[index] ?? ' '
  }
  return { text: parts.join('') }
}

/**
 * The `---` frontmatter of an Astro component, positioned as written.
 *
 * The markers are not code, so they are blanked with everything else; what survives is
 * the body between them. Astro requires the block to be the first thing in the file,
 * which is why this looks at the beginning only — a `---` further down is content (a
 * table rule, a horizontal rule), and reading it as code would invent symbols.
 *
 * Blanked by LINE rather than by character: frontmatter starts at column 0, so nothing
 * after it has to keep its column, and whole-line replacement is the version that cannot
 * be off by one.
 *
 * @param source - the component's text.
 * @returns the masked frontmatter, or `undefined` when the file has none.
 */
function frontmatter(source: string): string | undefined {
  const lines = source.split('\n')
  if ((lines[0] ?? '').trim() !== '---') return undefined
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (close === -1) return undefined
  const masked = lines.map((line, index) => (index > 0 && index < close ? line : ''))
  return masked.join('\n')
}

/**
 * The text a grammar should read for this file.
 *
 * One call rather than a branch at the caller: a language that is not a component passes
 * its source through unchanged, a component gets its code region masked into place, and a
 * component with no such region answers `undefined` — which the caller reports as
 * `noShape`, because there is nothing to download and nothing to skip.
 *
 * @param source - the file's text.
 * @param languageId - the language the extension mapped to.
 * @returns text to parse, or `undefined` when there is nothing in the file to parse.
 */
export function textForParse(source: string, languageId: string): string | undefined {
  const kind = COMPONENT_LANGUAGES.get(languageId)
  if (kind === undefined) return source
  return kind === 'frontmatter' ? frontmatter(source) : sfcScript(source)?.text
}
