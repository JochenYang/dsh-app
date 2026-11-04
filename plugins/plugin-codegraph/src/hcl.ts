/**
 * Terraform / HCL: the blocks a configuration declares, and what each one reads.
 *
 * Why a scanner. HCL is declarative — a file is a list of labelled blocks
 * (`resource "aws_instance" "web" { … }`) whose bodies are arguments — and that is the
 * same shape this graph stores. It is also the shape a grammar would spend most of its
 * effort NOT helping with: the pinned grammar package has no HCL, and the one question a
 * reader asks ("what does this resource depend on") is answered by the reference syntax,
 * which is `var.name`, `local.name`, `module.name`, `data.type.name` and `type.name`
 * dot-paths rather than an expression tree.
 *
 * Reachability is the point, not completeness. A symbol here is a block ADDRESS
 * (`aws_instance.web`, `var.region`), and a reference is the same address written
 * somewhere else, so `codegraph_impact` answers "what breaks if I change this variable"
 * across every `.tf` file in the project. What it does not do: evaluate expressions,
 * follow `for_each`, or resolve a module's inputs into the child module's variables.
 *
 * @module @dsh-app/plugin-codegraph/host/hcl
 */

import type { ParsedFile } from './parse.ts'
import type { SymbolKind, SymbolRecord } from './store.ts'

/** A block header this scanner knows: the keyword, and how many labels it takes. */
const BLOCKS: readonly { readonly keyword: string, readonly labels: number, readonly kind: SymbolKind }[] = [
  // A resource is a configuration record; `struct` is what the graph calls one, and it
  // keeps `kind:struct` answering "show me the infrastructure" across SQL and Terraform.
  { keyword: 'resource', labels: 2, kind: 'struct' },
  { keyword: 'data', labels: 2, kind: 'struct' },
  { keyword: 'module', labels: 1, kind: 'module' },
  { keyword: 'provider', labels: 1, kind: 'module' },
  { keyword: 'variable', labels: 1, kind: 'variable' },
  { keyword: 'output', labels: 1, kind: 'variable' },
]

/** `resource "aws_instance" "web" {` — the keyword plus its quoted labels. */
const HEADER = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*((?:"[^"]*"\s*)*)\{/u

/** The dot-path forms that name another block, in the order they are checked. */
const REFERENCE_PATTERNS: readonly {
  readonly pattern: RegExp
  readonly name: (match: RegExpExecArray) => string
  /** Blanked from the body before this pattern runs, so its own matches cannot repeat. */
  readonly shadowedBy?: RegExp
}[] = [
  { pattern: /\bvar\.([A-Za-z_][\w-]*)/gu, name: match => `var.${match[1] ?? ''}` },
  { pattern: /\blocal\.([A-Za-z_][\w-]*)/gu, name: match => `local.${match[1] ?? ''}` },
  { pattern: /\bmodule\.([A-Za-z_][\w-]*)/gu, name: match => `module.${match[1] ?? ''}` },
  { pattern: /\bdata\.([\w-]*)\.([A-Za-z_][\w-]*)/gu, name: match => `data.${match[1] ?? ''}.${match[2] ?? ''}` },
  // A resource address: a provider resource type (`aws_instance`, `google_project`) and
  // its local name. The type must contain an underscore — that is the convention HCL
  // enforces, and it is what keeps `module.db.id` or a bare attribute path out.
  {
    pattern: /\b([a-z][a-z0-9]*_[a-z][a-z0-9_]*)\.([A-Za-z_][\w-]*)/gu,
    name: match => `${match[1] ?? ''}.${match[2] ?? ''}`,
    // `data.aws_ami.ubuntu` also looks like a resource address (`aws_ami.ubuntu`) once the
    // `data.` prefix is behind the match. Blanking the data references first keeps one
    // address one reference — otherwise a project that happens to declare a resource of
    // that name would get an edge from a data source.
    shadowedBy: /data\.[\w-]*\.[A-Za-z_][\w-]*/gu,
  },
]

/** One block: where its header starts, and where its closing brace is. */
interface Block {
  readonly keyword: string
  readonly labels: readonly string[]
  readonly start: number
  readonly end: number
  readonly endLine: number
}

/**
 * Blank comments and heredocs, keeping length and newlines.
 *
 * Strings are NOT blanked here, unlike every other scanner in this plugin: an HCL block's
 * identity IS its quoted labels (`resource "aws_instance" "web"`), so hiding them would
 * hide the declaration. What must go is the two things that can hold a brace or a
 * dot-path without meaning it — a comment, and a heredoc body (`<<EOF … EOF`, where shell
 * scripts and JSON policies live).
 *
 * @param source - the file's text.
 * @returns a same-length mask.
 */
function masked(source: string): string {
  const characters = source.split('')
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to && index < characters.length; index++) {
      if (characters[index] !== '\n') characters[index] = ' '
    }
  }
  for (let at = 0; at < characters.length; at++) {
    const rest = source.slice(at, at + 8)
    if (rest.startsWith('#') || rest.startsWith('//')) {
      const end = source.indexOf('\n', at)
      const stop = end === -1 ? characters.length : end
      blank(at, stop)
      at = stop
      continue
    }
    if (rest.startsWith('/*')) {
      const end = source.indexOf('*/', at)
      const stop = end === -1 ? characters.length : end + 2
      blank(at, stop)
      at = stop
      continue
    }
    const heredoc = /^<<-?([A-Za-z_][A-Za-z0-9_]*)/u.exec(rest)
    if (heredoc !== null) {
      // The body runs from the end of this line to a line that is exactly the marker.
      const marker = heredoc[1] ?? ''
      const bodyStart = source.indexOf('\n', at)
      if (bodyStart === -1) break
      const closing = new RegExp(`\\n[ \\t]*${marker}[ \\t]*(?=\\n|$)`, 'u')
      const found = closing.exec(source.slice(bodyStart))
      const stop = found === null ? characters.length : bodyStart + found.index + found[0].length
      blank(bodyStart, stop)
      at = stop
      continue
    }
  }
  return characters.join('')
}

/**
 * Where the block that opens at `from` closes.
 *
 * @param mask - the comment- and heredoc-blanked source.
 * @param from - the offset of the opening brace.
 * @param source - the original text, for line numbers.
 * @returns the offset past the closing brace, and its line.
 */
function blockEnd(mask: string, from: number, source: string): { end: number, endLine: number } {
  let depth = 0
  for (let at = from; at < mask.length; at++) {
    if (mask[at] === '{') depth++
    else if (mask[at] === '}') {
      depth--
      if (depth === 0) {
        let line = 1
        for (let index = 0; index <= at; index++) if (source[index] === '\n') line++
        return { end: at + 1, endLine: line }
      }
    }
  }
  let line = 1
  for (let index = 0; index < source.length; index++) if (source[index] === '\n') line++
  return { end: mask.length, endLine: line }
}

/** The 1-based line of an offset. */
function lineOf(source: string, offset: number): number {
  let line = 1
  for (let at = 0; at < offset && at < source.length; at++) if (source[at] === '\n') line++
  return line
}

/**
 * Read one HCL file.
 *
 * @param source - the file's text.
 * @param path - the project-relative path, for the symbol ids.
 * @returns the blocks the file declares, and the addresses each one reads.
 */
export function parseHcl(source: string, path: string): ParsedFile {
  const mask = masked(source)
  const symbols: SymbolRecord[] = []
  const calls: { name: string, line: number, owner: string | undefined }[] = []
  const blocks: Block[] = []
  /** Which symbol a block's body belongs to, by the block's start offset. */
  const declaredAt = new Map<number, string>()

  for (let at = 0; at < mask.length; at++) {
    // Only a line start can open a block; the header regex is anchored, so a scan per
    // line is enough and cannot match inside a body expression.
    if (at > 0 && mask[at - 1] !== '\n') continue
    const lineEnd = mask.indexOf('\n', at)
    const line = source.slice(at, lineEnd === -1 ? source.length : lineEnd)
    const header = HEADER.exec(line)
    if (header === null) continue
    const keyword = header[1] ?? ''
    const spec = BLOCKS.find(entry => entry.keyword === keyword)
    const labels = [...(header[2] ?? '').matchAll(/"([^"]*)"/gu)].map(match => match[1] ?? '')
    const brace = mask.indexOf('{', at)
    const open = blockEnd(mask, brace, source)
    blocks.push({ keyword, labels, start: at, end: open.end, endLine: open.endLine })
    if (spec !== undefined && labels.length >= spec.labels) {
      // The address, not the labels: `aws_instance.web` is what another file writes, and
      // `var.region` is what a resource reads — one spelling on both sides is what makes
      // the edge resolvable by name.
      const name = spec.keyword === 'variable'
        ? `var.${labels[0] ?? ''}`
        : spec.keyword === 'resource' || spec.keyword === 'data'
          ? `${spec.keyword === 'data' ? 'data.' : ''}${labels.slice(0, 2).join('.')}`
          : `${spec.keyword}.${labels[0] ?? ''}`
      const id = `${path}#${spec.kind}:${name}`
      declaredAt.set(at, id)
      symbols.push({
        id,
        path,
        name,
        kind: spec.kind,
        line: lineOf(source, at),
        endLine: open.endLine,
        parent: undefined,
      })
    }
    at = open.end - 1
  }

  // Every block is scanned for references, including `locals` and `terraform` — they
  // declare nothing addressable, but they read variables and other resources.
  for (const block of blocks) {
    const body = mask.slice(block.start, block.end)
    const owner = declaredAt.get(block.start)
    for (const reference of REFERENCE_PATTERNS) {
      const scanned = reference.shadowedBy === undefined
        ? body
        : body.replace(reference.shadowedBy, match => ' '.repeat(match.length))
      for (const match of scanned.matchAll(reference.pattern)) {
        const name = reference.name(match)
        if (name === '' || name.endsWith('.')) continue
        const before = scanned.slice(0, match.index ?? 0)
        calls.push({ name, line: lineOf(source, block.start) + (before.match(/\n/gu)?.length ?? 0), owner })
      }
    }
  }

  return {
    symbols,
    calls,
    imports: [],
    heritage: [],
    typeRefs: [],
    exports: [],
    hasError: false,
    unsupported: false,
  }
}
