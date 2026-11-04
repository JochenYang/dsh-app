/**
 * Extraction contract, driven by REAL parses.
 *
 * These cases run tree-sitter over source text rather than hand-built node
 * objects. The hand-built version would test the walk against a shape this
 * author imagined; a real parse tests it against the grammar that ships. The one
 * thing hand-built nodes are still used for is the edge-resolution rule, which
 * has no syntax of its own.
 *
 * **Where the on-demand cases run.** A bundled grammar is in the repository, so
 * its cases run everywhere. The on-demand ones (`rust`, `ruby`, `php`, `bash`,
 * `powershell` and the three symbol-less formats) are downloaded into a user's
 * storage at run time, and the repository deliberately does not ship a second
 * copy — that is the whole point of "on demand". Their cases therefore SKIP by
 * name on a machine without them (18 skips, visible in the count, never silent).
 * CI does not accept that: it runs `scripts/fetch-ci-grammars.mjs` first and
 * points `DSH_APP_CODEGRAPH_GRAMMARS` at the result, so the same 125 cases
 * execute there. A local run reproduces CI with that variable set to any
 * directory holding the downloaded wasm.
 *
 * @module plugin-codegraph/tests/parse
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Parser, Language } from 'web-tree-sitter'
import { GRAMMAR_SHAPES, callEdges, extractSymbols, relationEdges, symbolId, unsupportedFor, type SyntaxNode } from '../src/parse.ts'
import { LANGUAGES } from '../src/languages.ts'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const grammarDir = join(pluginRoot, 'grammars')

let initialised: Promise<void> | undefined
const parsers = new Map<string, Parser>()

/** Load the runtime once; each language's grammar is cached per id. */
async function parserFor(languageId: string): Promise<Parser> {
  initialised ??= Parser.init({
    locateFile: () => join(pluginRoot, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
  })
  await initialised
  const cached = parsers.get(languageId)
  if (cached !== undefined) return cached
  const spec = LANGUAGES.find(language => language.id === languageId)
  assert.ok(spec !== undefined, `no language table entry for ${languageId}`)
  // A bundled grammar lives in the plugin; an ON-DEMAND one (rust, ruby, php,
  // bash, css, ini, regex) is downloaded at run time into the user's storage, so a
  // test machine may not have it. `DSH_APP_CODEGRAPH_GRAMMARS` points the suite at
  // a download directory; without it those ids are skipped by name rather than
  // failing, because "the grammar was never downloaded" and "the table is wrong"
  // are different facts and only the second is a defect.
  const bundled = join(grammarDir, `tree-sitter-${spec.grammar}.wasm`)
  // The six grammars this plugin builds but does not ship (Scala, Elixir, Zig, Julia,
  // Haskell, Groovy) are downloaded from the app's kernel release at run time. The
  // repository keeps those exact bytes under `grammars-optional/`, so a test run reads
  // them from there: same bytes a user's download installs, and `languages.test.ts`
  // holds the recorded digest against this file name for file.
  const optional = join(pluginRoot, 'grammars-optional', `tree-sitter-${spec.grammar}.wasm`)
  const downloaded = process.env.DSH_APP_CODEGRAPH_GRAMMARS === undefined
    ? undefined
    : join(process.env.DSH_APP_CODEGRAPH_GRAMMARS, `tree-sitter-${spec.grammar}.wasm`)
  const file = [bundled, optional, downloaded].find(candidate => existsSync(candidate))
  assert.ok(file !== undefined,
    `no grammar for ${languageId} — neither ${bundled} nor ${optional} exists, and DSH_APP_CODEGRAPH_GRAMMARS is ${process.env.DSH_APP_CODEGRAPH_GRAMMARS ?? 'unset'}`)
  const grammar = await Language.load(file)
  const parser = new Parser()
  parser.setLanguage(grammar)
  parsers.set(languageId, parser)
  return parser
}

/** Whether this machine can run a language's real-grammar cases. */
function grammarAvailable(languageId: string): boolean {
  const spec = LANGUAGES.find(language => language.id === languageId)
  if (spec === undefined) return false
  if (existsSync(join(grammarDir, `tree-sitter-${spec.grammar}.wasm`))) return true
  if (existsSync(join(pluginRoot, 'grammars-optional', `tree-sitter-${spec.grammar}.wasm`))) return true
  return process.env.DSH_APP_CODEGRAPH_GRAMMARS !== undefined
    && existsSync(join(process.env.DSH_APP_CODEGRAPH_GRAMMARS, `tree-sitter-${spec.grammar}.wasm`))
}

/** Parse a source string and extract through the real tree. */
async function parse(source: string, languageId: string, path: string) {
  const parser = await parserFor(languageId)
  const tree = parser.parse(source)
  assert.ok(tree !== null)
  // The tree-sitter Node type is structurally the SyntaxNode this module reads;
  // the cast is at the boundary where a real parse becomes our own contract.
  return extractSymbols(tree.rootNode as unknown as SyntaxNode, path, languageId)
}

describe('extractSymbols — TypeScript', () => {
  it('counts a constructor call as a call, because that is how a class is used', async () => {
    // Measured in a real session on a TypeScript monorepo: `codegraph_find` answered
    // "0 call site(s)" for the repository's most-used class, and the model then read
    // twenty files to find the sixty-six `new Agent(...)` sites by hand. The extractor
    // only knew `call_expression`, and `new Foo()` is a `new_expression` — a whole
    // language's constructor calls, invisible.
    const source = [
      'class Widget { constructor(readonly size: number) {} }',
      'function make() { return new Widget(1) }',
    ].join('\n')
    const parsed = await parse(source, 'typescript', 'src/a.ts')
    assert.deepEqual(parsed.calls.map(call => call.name), ['Widget'], 'the constructor call names its class')
    assert.equal(parsed.calls[0]?.line, 2)
  })

  it('finds functions, classes, methods and interfaces with their lines', async () => {
    const source = [
      'export function topLevel(a: number) { return a }',
      'class Box {',
      '  open() { return helper() }',
      '}',
      'interface Shape { area(): number }',
    ].join('\n')
    const parsed = await parse(source, 'typescript', 'src/a.ts')

    const byName = new Map(parsed.symbols.map(symbol => [symbol.name, symbol]))
    assert.equal(byName.get('topLevel')?.kind, 'function')
    assert.equal(byName.get('topLevel')?.line, 1)
    assert.equal(byName.get('Box')?.kind, 'class')
    assert.equal(byName.get('open')?.kind, 'method')
    assert.equal(byName.get('open')?.parent, 'Box', 'a method carries its class as parent')
    assert.equal(byName.get('Shape')?.kind, 'interface')
  })

  it('derives a method id from its class, not its line', async () => {
    const source = 'class Box {\n  open() {}\n}'
    const parsed = await parse(source, 'typescript', 'a.ts')
    const open = parsed.symbols.find(symbol => symbol.name === 'open')
    assert.equal(open?.id, 'a.ts#method:Box.open')
  })

  it('finds call sites', async () => {
    const parsed = await parse('function a() { return b() + c() }', 'typescript', 'a.ts')
    assert.deepEqual(parsed.calls.map(call => call.name).sort(), ['b', 'c'])
  })

  it('finds import specifiers, and the local names each one binds', async () => {
    // The names are what the import-guided resolution keys on, so a name the parse
    // forgets is a name that resolves project-wide. Measured: a DEFAULT import's
    // identifier lives inside `import_clause`, one level below the statement — reading
    // only the statement's own children bound `x` and lost `y`, which silenced the
    // import layer for every class imported the usual way.
    const parsed = await parse("import { x, z as w } from './x.ts'\nimport y from 'y'", 'typescript', 'a.ts')
    assert.deepEqual(parsed.imports.map(entry => entry.specifier).sort(), ['./x.ts', 'y'])
    const names = new Map(parsed.imports.map(entry => [entry.specifier, [...entry.names].sort()]))
    assert.deepEqual(names.get('./x.ts'), ['w', 'x'], 'the LOCAL names: a specifier alias, not the exported one')
    assert.deepEqual(names.get('y'), ['y'], 'a default import binds its own name')
  })
})

describe('extractSymbols — Python', () => {
  it('finds functions and classes, with methods nested under their class', async () => {
    const source = [
      'def top():',
      '    return helper()',
      '',
      'class Thing:',
      '    def method(self):',
      '        return top()',
    ].join('\n')
    const parsed = await parse(source, 'python', 'a.py')
    const names = parsed.symbols.map(symbol => `${symbol.kind}:${symbol.name}`)
    assert.ok(names.includes('function:top'))
    assert.ok(names.includes('class:Thing'))
    const method = parsed.symbols.find(symbol => symbol.name === 'method')
    assert.equal(method?.parent, 'Thing')
    assert.deepEqual(parsed.calls.map(call => call.name).sort(), ['helper', 'top'])
  })
})

describe('extractSymbols — Go', () => {
  it('finds functions and methods', async () => {
    const source = [
      'package main',
      'func Add(a int, b int) int { return a + b }',
      'func (r Recv) Do() int { return Add(1, 2) }',
    ].join('\n')
    const parsed = await parse(source, 'go', 'a.go')
    const names = parsed.symbols.map(symbol => symbol.name)
    assert.ok(names.includes('Add'), `got ${names.join(',')}`)
    assert.ok(names.includes('Do'), `got ${names.join(',')}`)
    assert.ok(parsed.calls.some(call => call.name === 'Add'))
  })
})

describe('extractSymbols — C through the C++ grammar', () => {
  it('reads a C translation unit with no ERROR node', async () => {
    const source = [
      '#include <stdio.h>',
      'int add(int a, int b) { return a + b; }',
      'struct Point { int x; int y; };',
      'int main(void) { return add(1, 2); }',
    ].join('\n')
    const parsed = await parse(source, 'c', 'a.c')
    assert.equal(parsed.hasError, false, 'C must parse cleanly through the cpp grammar')
    const names = parsed.symbols.map(symbol => symbol.name)
    assert.ok(names.includes('add'), `got ${names.join(',')}`)
    assert.ok(names.includes('main'), `got ${names.join(',')}`)
    assert.ok(parsed.calls.some(call => call.name === 'add'))
  })
})

describe('extractSymbols — Java', () => {
  it('finds classes and methods, and records invocations', async () => {
    const source = [
      'class Service {',
      '  int run() { return helper(); }',
      '  int helper() { return 1; }',
      '}',
    ].join('\n')
    const parsed = await parse(source, 'java', 'Service.java')
    const names = parsed.symbols.map(symbol => symbol.name)
    assert.ok(names.includes('Service'))
    assert.ok(names.includes('run'))
    assert.ok(names.includes('helper'))
    assert.ok(parsed.calls.some(call => call.name === 'helper'))
  })
})

describe('extractSymbols — Kotlin', () => {
  it('finds classes, objects, functions and properties, with members under their class', async () => {
    // The whole shape in one case: Kotlin names NOTHING through a `name` field, so
    // this is the test that would go red if a row fell back to `nameField: 'name'`.
    const source = [
      'import kotlinx.coroutines.launch',
      '',
      'interface Shape {',
      '    fun area(): Double',
      '}',
      '',
      'class Square(val side: Double) : Shape {',
      '    override fun area(): Double = side * side',
      '    fun helper() { println(area()) }',
      '}',
      '',
      'object Registry {',
      '    fun register() {}',
      '}',
      '',
      'val top = 1',
      'typealias Handler = (Int) -> Unit',
    ].join('\n')
    const parsed = await parse(source, 'kotlin', 'src/A.kt')
    assert.equal(parsed.hasError, false, 'Kotlin must parse cleanly through its own grammar')
    const ids = new Set(parsed.symbols.map(symbol => symbol.id))
    for (const expected of [
      'src/A.kt#class:Shape',
      'src/A.kt#function:Shape.area',
      'src/A.kt#class:Square',
      'src/A.kt#variable:Square.side',
      'src/A.kt#function:Square.area',
      'src/A.kt#function:Square.helper',
      'src/A.kt#class:Registry',
      'src/A.kt#function:Registry.register',
      'src/A.kt#variable:top',
      'src/A.kt#type:Handler',
    ]) {
      assert.ok(ids.has(expected), `missing ${expected}; got ${[...ids].join(',')}`)
    }
    // Two calls, both owned by the function that makes them: `call_expression` has
    // no fields, so this is what proves the `field: ''` child convention works.
    assert.deepEqual(parsed.calls.map(call => call.name).sort(), ['area', 'println'])
    assert.deepEqual([...new Set(parsed.calls.map(call => call.owner))], ['src/A.kt#function:Square.helper'])
    assert.deepEqual(parsed.imports.map(entry => entry.specifier), ['kotlinx.coroutines.launch'])
    // A superclass and its interfaces share one `delegation_specifier` list.
    assert.deepEqual(parsed.heritage.map(row => [row.kind, row.name]), [['extends', 'Shape']])
  })
})

describe('extractSymbols — Swift', () => {
  it('finds classes, protocols and functions, and reads a protocol requirement', async () => {
    const source = [
      'import Foundation',
      '',
      'protocol Shape {',
      '    func area() -> Double',
      '}',
      '',
      'struct Point {',
      '    var x: Double',
      '}',
      '',
      'class Square: Shape {',
      '    var side: Double',
      '    init(side: Double) { self.side = side }',
      '    func area() -> Double { return helper(x: side) }',
      '}',
      '',
      'func helper(x: Double) -> Double { return x * 2 }',
      'typealias Handler = (Int) -> Void',
    ].join('\n')
    const parsed = await parse(source, 'swift', 'src/A.swift')
    assert.equal(parsed.hasError, false, 'Swift must parse cleanly through its own grammar')
    const ids = new Set(parsed.symbols.map(symbol => symbol.id))
    for (const expected of [
      'src/A.swift#interface:Shape',
      // A protocol requirement has no body and its own node type; without its row
      // a protocol's entire surface would be missing.
      'src/A.swift#method:Shape.area',
      // `struct` is a `class_declaration` in this grammar — pinned deliberately,
      // because a grammar that grew a `struct_declaration` must not go unnoticed.
      'src/A.swift#class:Point',
      'src/A.swift#variable:Point.x',
      'src/A.swift#class:Square',
      'src/A.swift#variable:Square.side',
      'src/A.swift#method:Square.init',
      'src/A.swift#function:Square.area',
      'src/A.swift#function:helper',
      'src/A.swift#type:Handler',
    ]) {
      assert.ok(ids.has(expected), `missing ${expected}; got ${[...ids].join(',')}`)
    }
    assert.deepEqual(parsed.calls.map(call => call.name), ['helper'])
    assert.deepEqual([...new Set(parsed.calls.map(call => call.owner))], ['src/A.swift#function:Square.area'])
    assert.deepEqual(parsed.imports.map(entry => entry.specifier), ['Foundation'])
    assert.deepEqual(parsed.heritage.map(row => [row.kind, row.name]), [['extends', 'Shape']])
  })
})

describe('extractSymbols — Dart', () => {
  it('finds classes, mixins, enums, extensions and functions', async () => {
    const source = [
      "import 'dart:math';",
      '',
      'abstract class Shape {',
      '  double area();',
      '}',
      '',
      'class Square extends Shape {',
      '  final double side;',
      '  Square(this.side);',
      '  double area() => side * side;',
      '}',
      '',
      'mixin Logger {',
      '  void log(String message) {}',
      '}',
      '',
      'enum Color { red, green }',
      '',
      'extension PointMath on double {',
      '  double squared() => this * this;',
      '}',
      '',
      'int topLevel(int x) => x + 1;',
      '',
      'typedef Callback = void Function(int);',
    ].join('\n')
    const parsed = await parse(source, 'dart', 'src/a.dart')
    assert.equal(parsed.hasError, false, 'Dart must parse cleanly through its own grammar')
    const ids = new Set(parsed.symbols.map(symbol => symbol.id))
    for (const expected of [
      'src/a.dart#class:Shape',
      'src/a.dart#function:Shape.area',
      'src/a.dart#class:Square',
      // A field WITHOUT an initialiser is a different node from one WITH it, which
      // is why the shape carries both `initialized_*` rows.
      'src/a.dart#variable:Square.side',
      'src/a.dart#method:Square.Square',
      'src/a.dart#function:Square.area',
      'src/a.dart#class:Logger',
      'src/a.dart#function:Logger.log',
      'src/a.dart#enum:Color',
      'src/a.dart#class:PointMath',
      'src/a.dart#function:PointMath.squared',
      'src/a.dart#function:topLevel',
      'src/a.dart#type:Callback',
    ]) {
      assert.ok(ids.has(expected), `missing ${expected}; got ${[...ids].join(',')}`)
    }
    assert.deepEqual(parsed.imports.map(entry => entry.specifier), ['dart:math'])
    assert.deepEqual(parsed.heritage.map(row => [row.kind, row.name]), [['extends', 'Shape']])
    // Dart has NO call node: an invocation is an `identifier` plus a `selector` that
    // holds only the arguments, so the callee is outside the node a `call` entry
    // could name. Recorded as a known gap, not as a property of the language — the
    // day the grammar grows a call node this assertion is what says so.
    assert.deepEqual(parsed.calls, [])
  })
})

describe('extractSymbols — Scala', () => {
  it('finds classes, traits, enums, objects, defs and vals, with members under their owner', async () => {
    // Scala names every construct with its OWN node type, and `case class` is only a
    // `case` MODIFIER on `class_definition` — not a node of its own. This sample spells
    // each of them once, so a dropped row produces a named failure rather than a shape
    // that looks supported and answers nothing.
    const source = [
      'package example.core',
      '',
      'import scala.collection.mutable.ListBuffer',
      'import example.math.{ Vector, Matrix as M }',
      '',
      'trait Shape {',
      '  def area(): Double',
      '}',
      '',
      'abstract class Base(val name: String) extends Shape',
      '',
      'case class Point(x: Double, y: Double)',
      '',
      'class Square(val side: Double) extends Base("square") with Shape {',
      '  override def area(): Double = helper(side) * side',
      '',
      '  def helper(value: Double): Double = value',
      '}',
      '',
      'object Registry {',
      '  val entries: Int = 0',
      '',
      '  def register(item: String): Unit = {',
      '    println(item)',
      '    square.area()',
      '  }',
      '}',
      '',
      'enum Color {',
      '  case Red, Green',
      '}',
      '',
      'given ordering: Ordering[Point] = Ordering.by(_.x)',
      '',
      'type Handler = Int => Unit',
      '',
      'val top: Int = 1',
      '',
      'def main(args: Array[String]): Unit = {',
      '  Registry.register("x")',
      '}',
    ].join('\n')
    const parsed = await parse(source, 'scala', 'src/Sample.scala')
    assert.equal(parsed.hasError, false, 'Scala must parse cleanly through its own grammar')
    const ids = new Set(parsed.symbols.map(symbol => symbol.id))
    for (const expected of [
      // A trait is a contract, so it is an `interface`.
      'src/Sample.scala#interface:Shape',
      // A body-less `def` is its own node type; without its row a trait's surface is
      // missing entirely.
      'src/Sample.scala#method:Shape.area',
      // `abstract class` and `case class` are both `class_definition`; the constructor
      // `val` is what makes their fields addressable.
      'src/Sample.scala#class:Base',
      'src/Sample.scala#variable:Base.name',
      'src/Sample.scala#class:Point',
      'src/Sample.scala#variable:Point.x',
      'src/Sample.scala#variable:Point.y',
      'src/Sample.scala#class:Square',
      'src/Sample.scala#variable:Square.side',
      'src/Sample.scala#function:Square.area',
      'src/Sample.scala#function:Square.helper',
      // A Scala `object` is recorded as a class, the same reading Kotlin's `object` gets.
      'src/Sample.scala#class:Registry',
      // `val` names itself through a `pattern` field, not `name`.
      'src/Sample.scala#variable:Registry.entries',
      'src/Sample.scala#function:Registry.register',
      'src/Sample.scala#enum:Color',
      'src/Sample.scala#variable:ordering',
      'src/Sample.scala#type:Handler',
      'src/Sample.scala#variable:top',
      'src/Sample.scala#function:main',
    ]) {
      assert.ok(ids.has(expected), `missing ${expected}; got ${[...ids].join(',')}`)
    }
    // `call_expression` carries a `function` field here, so a member call resolves
    // through the callee's own `field` — `square.area()` yields `area`, not nothing.
    assert.deepEqual(parsed.calls.map(call => call.name).sort(), ['area', 'by', 'helper', 'println', 'register'])
    assert.deepEqual(
      [...new Set(parsed.calls.map(call => call.owner))].sort(),
      ['src/Sample.scala#function:Registry.register', 'src/Sample.scala#function:Square.area', 'src/Sample.scala#function:main', 'src/Sample.scala#variable:ordering'],
      'each call belongs to the declaration that makes it',
    )
    // A dotted import is one `path` field PER SEGMENT, so the recorded specifier is the
    // first one. Asserted rather than glossed: `resolveImport` only resolves
    // `./`-relative specifiers, so no Scala import produces an edge either way, and the
    // day that changes this assertion is what says the row needs a longer specifier.
    assert.deepEqual(parsed.imports.map(entry => entry.specifier), ['scala', 'example'])
    // `extends Base(...) with Shape` is ONE node with one repeated `type` field, so the
    // superclass and the trait cannot be told apart — both are `extends`.
    assert.deepEqual(
      parsed.heritage.map(row => [row.kind, row.name, row.from]),
      [
        ['extends', 'Shape', 'src/Sample.scala#class:Base'],
        ['extends', 'Base', 'src/Sample.scala#class:Square'],
        ['extends', 'Shape', 'src/Sample.scala#class:Square'],
      ],
    )
  })
})

describe('extractSymbols — an unsupported language', () => {
  it('answers nothing rather than throwing, so the file is still counted', () => {
    const root: SyntaxNode = {
      type: 'program',
      text: '',
      startPosition: { row: 0 },
      endPosition: { row: 0 },
      namedChildren: [],
      childForFieldName: () => null,
    }
    const parsed = extractSymbols(root, 'a.rb', 'ruby')
    assert.deepEqual(parsed.symbols, [])
    assert.deepEqual(parsed.calls, [])
  })
})

describe('extractSymbols — the declaration extent', () => {
  it('records the declaration’s LAST line, which is the half a source slice needs', async () => {
    // A source slice is `line`..`endLine` off the disk. Without the second end the
    // only truthful answer a tool could give is "the declaration starts here", which
    // is what every other tool already says — so the extent is extracted here and
    // never derived from the children at query time.
    const source = [
      'export function alpha() {',
      '  const x = 1',
      '  return x',
      '}',
      '',
      'export class Beta {',
      '  run(): void {',
      '    alpha()',
      '  }',
      '}',
    ].join('\n')
    const parsed = await parse(source, 'typescript', 'a.ts')
    const byName = new Map(parsed.symbols.map(symbol => [symbol.name, symbol]))

    assert.deepEqual([byName.get('alpha')?.line, byName.get('alpha')?.endLine], [1, 4], 'a function ends where its body ends')
    assert.deepEqual([byName.get('Beta')?.line, byName.get('Beta')?.endLine], [6, 10], 'a class spans its own body, not only the name line')
    assert.deepEqual([byName.get('run')?.line, byName.get('run')?.endLine], [7, 9], 'a nested method spans its own body')
  })

  it('reports a one-line declaration as one line', async () => {
    const parsed = await parse('export function one(): number { return 1 }', 'typescript', 'a.ts')
    const one = parsed.symbols.find(symbol => symbol.name === 'one')
    assert.ok(one !== undefined)
    assert.deepEqual([one.line, one.endLine], [1, 1])
  })
})

describe('unsupportedFor — a download that cannot help', () => {
  it('tells the user to download only when the language has extraction rules', () => {
    // The settings page turns `missing` into "download it below" and `noShape` into
    // "nothing here declares a symbol". Measured on a real project: ten `.css` files were
    // reported as missing a grammar, and downloading the CSS grammar changed nothing —
    // its extraction table is empty by design.
    assert.equal(unsupportedFor('typescript', false), 'missing', 'a bundled language that is somehow absent is worth downloading')
    assert.equal(unsupportedFor('rust', false), 'missing', 'an on-demand language with rules is exactly what the download is for')
    assert.equal(unsupportedFor('css', false), 'noShape', 'a stylesheet declares nothing, so no download helps')
    assert.equal(unsupportedFor('ini', false), 'noShape')
  })

  it('leaves an installed grammar to the parser', () => {
    // With the wasm present the parser is the only thing that can say whether the table
    // declares anything, and it answers `noShape` itself.
    assert.equal(unsupportedFor('css', true), false)
    assert.equal(unsupportedFor('typescript', true), false)
  })
})

describe('symbolId', () => {
  it('never includes a line number, so re-formatting keeps references valid', () => {
    assert.equal(symbolId('a.ts', 'function', 'f', undefined), 'a.ts#function:f')
    assert.equal(symbolId('a.ts', 'method', 'm', 'C'), 'a.ts#method:C.m')
    assert.doesNotMatch(symbolId('a.ts', 'function', 'f', undefined), /@\d+/u)
  })
})

describe('callEdges', () => {
  it('links a shared name to every declaration of it, and only skips a missing one', () => {
    // This case used to assert that an ambiguous name produced NO edge, with the
    // reasoning "under-reporting is visible, guessing is not". The reasoning was
    // wrong about which failure is visible: a missing edge is invisible.
    //
    // Measured on a real project: `streamWithDeltas` is declared in production code
    // and in a test harness, so all thirteen of its call sites produced no edge, and
    // `codegraph_impact` answered `referencing: []` — indistinguishable from "nobody
    // calls this". 53.2% of the project's reference edges hung off file nodes for the
    // same reason.
    //
    // Linking to every declaration is not a guess: it is the fact "this name is used
    // here, and these are the declarations it could mean", which is precisely what
    // the tool's candidates list exists to disambiguate. Only a name with NO
    // declaration produces no edge.
    const parsed = {
      symbols: [],
      calls: [
        { name: 'unique', line: 1 },
        { name: 'shared', line: 2 },
        { name: 'missing', line: 3 },
      ],
      imports: [],
      hasError: false,
    }
    const resolve = (name: string): readonly string[] => {
      if (name === 'unique') return ['b.ts#function:unique']
      if (name === 'shared') return ['x.ts#function:shared', 'y.ts#function:shared']
      return []
    }
    const edges = callEdges(parsed, 'a.ts#function:caller', resolve)
    assert.deepEqual(
      edges.map(edge => [edge.to, edge.line]),
      [
        ['b.ts#function:unique', 1],
        ['x.ts#function:shared', 2],
        ['y.ts#function:shared', 2],
      ],
      'a shared name reaches both declarations; a name with none reaches nothing',
    )
  })

  it('prefers a declaration in the same file over a project-wide count', () => {
    // The first layer, and the one that would have saved `streamWithDeltas`: it was
    // declared in the file that calls it AND in a test harness. The project-wide
    // uniqueness rule dropped all thirteen call sites, even though the local
    // declaration was right there and is the only thing a module-private name can
    // mean.
    const parsed = {
      symbols: [
        { id: 'a.ts#function:shared', path: 'a.ts', name: 'shared', kind: 'function', line: 1, endLine: 1, parent: undefined },
      ],
      calls: [{ name: 'shared', line: 9 }],
      imports: [],
      heritage: [],
      typeRefs: [],
      exports: [],
      hasError: false,
    }
    // The name is declared in four files; one of them is this one.
    const all = [
      'a.ts#function:shared',
      'b.ts#function:shared',
      'c.ts#function:shared',
      'd.ts#function:shared',
    ]
    const edges = callEdges(parsed, 'a.ts#function:caller', () => all)
    assert.deepEqual(edges.map(edge => edge.to), ['a.ts#function:shared'], 'the local declaration wins outright')
  })

  it('stops linking a name the codebase reuses for locals', () => {
    // Why this bound exists. Names shared by a handful are worth linking to both;
    // names shared by the thousand are not names. Measured on a real project,
    // `result` had **1325** declarations, and expanding it produced 200,000+ edges —
    // the index pass went from 17.9s to 124.6s, and every real caller was buried
    // under unrelated `const result` rows from other files.
    const parsed = { symbols: [], calls: [{ name: 'result', line: 1 }], imports: [], hasError: false }
    const many = Array.from({ length: 1325 }, (_, i) => `f${String(i)}.ts#variable:result`)
    const edges = callEdges(parsed, 'a.ts#function:caller', () => many)
    assert.deepEqual(edges, [], 'a name shared by 1325 declarations links to none of them')

    // The boundary is inclusive: ten targets still link, eleven do not.
    const ten = Array.from({ length: 10 }, (_, i) => `f${String(i)}.ts#variable:shared`)
    assert.equal(callEdges(parsed, 'a.ts#function:caller', () => ten).length, 10)
    const eleven = Array.from({ length: 11 }, (_, i) => `f${String(i)}.ts#variable:shared`)
    assert.deepEqual(callEdges(parsed, 'a.ts#function:caller', () => eleven), [])
  })

  it('keeps a self-recursive call as a real reference', () => {
    const parsed = { symbols: [], calls: [{ name: 'recur', line: 1 }], imports: [], hasError: false }
    const edges = callEdges(parsed, 'a.ts#function:recur', () => ['a.ts#function:recur'])
    assert.equal(edges.length, 1)
    assert.equal(edges[0]?.from, 'a.ts#function:recur')
    assert.equal(edges[0]?.to, 'a.ts#function:recur')
  })
})

describe('GRAMMAR_SHAPES — every declaration entry really produces a symbol', () => {
  /**
   * One source snippet per declaration ENTRY, per language.
   *
   * This is the test that would have caught three shipped defects: a
   * `nameField` naming a field the grammar does not have fails silently (the
   * declaration is simply never produced), and a per-language happy-path case
   * does not notice. Every row of every table must appear here.
   */
  const SAMPLES: Record<string, Record<string, string>> = {
    typescript: {
      function_declaration: 'function f() {}',
      class_declaration: 'class C {}',
      method_definition: 'class C { m() {} }',
      interface_declaration: 'interface I {}',
      type_alias_declaration: 'type T = string',
      enum_declaration: 'enum E { A }',
      variable_declarator: 'const v = 1',
      public_field_definition: 'class C { field = () => {} }',
    },
    tsx: {
      function_declaration: 'function f() { return null }',
      class_declaration: 'class C {}',
      method_definition: 'class C { m() {} }',
      interface_declaration: 'interface I {}',
      type_alias_declaration: 'type T = string',
      enum_declaration: 'enum E { A }',
      variable_declarator: 'const v = 1',
      public_field_definition: 'class C { field = () => {} }',
    },
    javascript: {
      function_declaration: 'function f() {}',
      class_declaration: 'class C {}',
      method_definition: 'class C { m() {} }',
      variable_declarator: 'const v = 1',
      field_definition: 'class C { field = 1 }',
    },
    python: {
      function_definition: 'def f():\n    pass',
      class_definition: 'class C:\n    pass',
    },
    go: {
      function_declaration: 'package m\nfunc F() {}',
      method_declaration: 'package m\ntype R struct{}\nfunc (r R) M() {}',
      type_spec: 'package m\ntype T struct{}',
    },
    java: {
      method_declaration: 'class C { void m() {} }',
      class_declaration: 'class C {}',
      interface_declaration: 'interface I {}',
      enum_declaration: 'enum E { A }',
    },
    c: {
      function_definition: 'int f(void) { return 0; }',
      class_specifier: 'class C {};',
      struct_specifier: 'struct S { int x; };',
      enum_specifier: 'enum E { A };',
    },
    cpp: {
      function_definition: 'int f() { return 0; }',
      class_specifier: 'class C {};',
      struct_specifier: 'struct S { int x; };',
      enum_specifier: 'enum E { A };',
    },
    c_sharp: {
      method_declaration: 'class C { void M() {} }',
      class_declaration: 'class C {}',
      interface_declaration: 'interface I {}',
      struct_declaration: 'struct S {}',
      enum_declaration: 'enum E { A }',
      property_declaration: 'class C { int P { get; set; } }',
    },
    // The four added in W13, each sample run against the REAL grammar by this
    // suite: a node name this grammar does not produce yields no symbol and the
    // case above fails, which is the only durable check on a table written from a
    // probe.
    rust: {
      function_item: 'fn f() {}',
      struct_item: 'struct S;',
      enum_item: 'enum E { A }',
      trait_item: 'trait T {}',
      function_signature_item: 'trait T { fn m(&self); }',
      field_declaration: 'struct S { x: i32 }',
    },
    ruby: {
      method: 'def f; end',
      singleton_method: 'def self.f; end',
      class: 'class C; end',
      module: 'module M; end',
    },
    php: {
      function_definition: '<?php function f() {}',
      method_declaration: '<?php class C { public function m() {} }',
      class_declaration: '<?php class C {}',
      interface_declaration: '<?php interface I {}',
      trait_declaration: '<?php trait T {}',
    },
    bash: {
      function_definition: 'f() { echo 1; }',
    },
    // The two declarations whose names are CHILD NODES rather than fields — the
    // reason the shape grew `nameChild`. A `nameField` here yields no symbol and
    // the case below would report it.
    powershell: {
      function_statement: 'function Get-Thing { Write-Host 1 }',
      class_statement: 'class Widget { [string] $Name }',
    },
    // The three grammars this plugin BUILDS itself (`tree-sitter build --wasm`
    // over the upstream sources) and ships in `grammars/`. Every name below was
    // read off a real parse rather than a grammar reference: Kotlin names nothing
    // through a `name` FIELD, so most of its rows are `nameChild` rows, and a
    // `nameField` there would have yielded an empty table that looked supported.
    kotlin: {
      class_declaration: 'class C {}',
      object_declaration: 'object O {}',
      function_declaration: 'fun f() {}',
      property_declaration: 'val v = 1',
      class_parameter: 'class C(val p: Int)',
      type_alias: 'typealias T = Int',
    },
    // Swift spells `class`, `struct`, `enum` and `extension` with one node type,
    // so `class_declaration` is the only row that can carry any of them.
    swift: {
      class_declaration: 'class C {}',
      protocol_declaration: 'protocol P {}',
      function_declaration: 'func f() {}',
      protocol_function_declaration: 'protocol P { func m() }',
      init_declaration: 'class C { init() {} }',
      property_declaration: 'class C { let x: Int = 0 }',
      typealias_declaration: 'typealias T = Int',
    },
    // A field WITH an initialiser and one WITHOUT are different node types here,
    // which is why both `initialized_*` rows exist.
    dart: {
      class_definition: 'class C {}',
      mixin_declaration: 'mixin M {}',
      enum_declaration: 'enum E { a }',
      extension_declaration: 'extension X on int {}',
      function_signature: 'void f() {}',
      initialized_variable_definition: 'void f() { final x = 1; }',
      initialized_identifier: 'class C { final int x; }',
      constructor_signature: 'class C { C(); }',
      type_alias: 'typedef T = void Function(int);',
    },
    // Scala spells each construct with its own node type, and `case class` is a MODIFIER
    // on `class_definition` rather than a type of its own — so these ten rows are one
    // per node the grammar produces, not one per keyword Scala has.
    scala: {
      class_definition: 'class C {}',
      trait_definition: 'trait T {}',
      enum_definition: 'enum E { case A }',
      object_definition: 'object O {}',
      function_definition: 'def f(): Int = 1',
      // A body-less `def` in a trait: a different node from a `def` with a body.
      function_declaration: 'trait T { def m(): Int }',
      class_parameter: 'class C(val p: Int)',
      // `nameField: 'pattern'` — a `nameField: 'name'` here yields NO symbol, silently.
      val_definition: 'val v = 1',
      given_definition: 'given ordering: Ordering[Int] = ???',
      type_definition: 'type T = Int',
    },
    // Parseable, downloadable, and deliberately NOT symbol-producing: a selector,
    // a config key and a regex fragment name nothing a caller can reference. The
    // gate below requires an entry for every shape, so these three are stated as
    // EMPTY rather than omitted — an omission would read as an oversight.
    css: {},
    ini: {},
    regex: {},
    lua: {
      function_declaration: "local utils = require(\"example.utils\")\nlocal inspect = require(\"inspect\")\n\n-- A \"class\" in Lua is a table plus a metatable; there is no class syntax.\nlocal Animal = {}\nAnimal.__index = Animal\n\nfunction Animal.new(name, sound)\n  local self = setmetatable({}, Animal)\n  self.name = name\n  self.sound = sound\n  return self\nend\n\nfunction Animal:speak()\n  return self.name .. \" says \" .. self.sound\nend\n\nlocal Dog = setmetatable({}, { __index = Animal })\nDog.__index = Dog\n\nfunction Dog.new(name)\n  local self = Animal.new(name, \"woof\")\n  setmetatable(self, Dog)\n  return self\nend\n\nfunction Dog:fetch(item)\n  print(inspect(item))\n  return utils.trim(item)\nend\n\nlocal function helper(value)\n  return value\nend\n\nreturn {\n  Animal = Animal,\n  Dog = Dog,\n  helper = helper,\n}\n",
      variable_declaration: "local utils = require(\"example.utils\")\nlocal inspect = require(\"inspect\")\n\n-- A \"class\" in Lua is a table plus a metatable; there is no class syntax.\nlocal Animal = {}\nAnimal.__index = Animal\n\nfunction Animal.new(name, sound)\n  local self = setmetatable({}, Animal)\n  self.name = name\n  self.sound = sound\n  return self\nend\n\nfunction Animal:speak()\n  return self.name .. \" says \" .. self.sound\nend\n\nlocal Dog = setmetatable({}, { __index = Animal })\nDog.__index = Dog\n\nfunction Dog.new(name)\n  local self = Animal.new(name, \"woof\")\n  setmetatable(self, Dog)\n  return self\nend\n\nfunction Dog:fetch(item)\n  print(inspect(item))\n  return utils.trim(item)\nend\n\nlocal function helper(value)\n  return value\nend\n\nreturn {\n  Animal = Animal,\n  Dog = Dog,\n  helper = helper,\n}\n",
      field: "local utils = require(\"example.utils\")\nlocal inspect = require(\"inspect\")\n\n-- A \"class\" in Lua is a table plus a metatable; there is no class syntax.\nlocal Animal = {}\nAnimal.__index = Animal\n\nfunction Animal.new(name, sound)\n  local self = setmetatable({}, Animal)\n  self.name = name\n  self.sound = sound\n  return self\nend\n\nfunction Animal:speak()\n  return self.name .. \" says \" .. self.sound\nend\n\nlocal Dog = setmetatable({}, { __index = Animal })\nDog.__index = Dog\n\nfunction Dog.new(name)\n  local self = Animal.new(name, \"woof\")\n  setmetatable(self, Dog)\n  return self\nend\n\nfunction Dog:fetch(item)\n  print(inspect(item))\n  return utils.trim(item)\nend\n\nlocal function helper(value)\n  return value\nend\n\nreturn {\n  Animal = Animal,\n  Dog = Dog,\n  helper = helper,\n}\n",
      method_index_expression: "local utils = require(\"example.utils\")\nlocal inspect = require(\"inspect\")\n\n-- A \"class\" in Lua is a table plus a metatable; there is no class syntax.\nlocal Animal = {}\nAnimal.__index = Animal\n\nfunction Animal.new(name, sound)\n  local self = setmetatable({}, Animal)\n  self.name = name\n  self.sound = sound\n  return self\nend\n\nfunction Animal:speak()\n  return self.name .. \" says \" .. self.sound\nend\n\nlocal Dog = setmetatable({}, { __index = Animal })\nDog.__index = Dog\n\nfunction Dog.new(name)\n  local self = Animal.new(name, \"woof\")\n  setmetatable(self, Dog)\n  return self\nend\n\nfunction Dog:fetch(item)\n  print(inspect(item))\n  return utils.trim(item)\nend\n\nlocal function helper(value)\n  return value\nend\n\nreturn {\n  Animal = Animal,\n  Dog = Dog,\n  helper = helper,\n}\n",
    },
    zig: {
      function_declaration: "const std = @import(\"std\");\nconst utils = @import(\"utils.zig\");\n\npub const Shape = struct {\n    sides: u32,\n    name: []const u8,\n\n    pub fn area(self: Shape) f64 {\n        return helper(@floatFromInt(self.sides));\n    }\n};\n\npub const Color = enum { red, green, blue };\n\npub const Payload = union(enum) {\n    circle: f64,\n    square: Shape,\n};\n\npub const Point = struct {\n    x: f64,\n    y: f64,\n};\n\npub fn describe(shape: *const Shape) []const u8 {\n    const label = shape.name;\n    std.debug.print(\"{s}\\n\", .{label});\n    return utils.trim(label);\n}\n\nfn helper(value: f64) f64 {\n    return value * 2.0;\n}\n\ntest \"describe\" {\n    const s = Shape{ .sides = 3, .name = \"tri\" };\n    try std.testing.expect(s.sides == 3);\n}\n",
      variable_declaration: "const std = @import(\"std\");\nconst utils = @import(\"utils.zig\");\n\npub const Shape = struct {\n    sides: u32,\n    name: []const u8,\n\n    pub fn area(self: Shape) f64 {\n        return helper(@floatFromInt(self.sides));\n    }\n};\n\npub const Color = enum { red, green, blue };\n\npub const Payload = union(enum) {\n    circle: f64,\n    square: Shape,\n};\n\npub const Point = struct {\n    x: f64,\n    y: f64,\n};\n\npub fn describe(shape: *const Shape) []const u8 {\n    const label = shape.name;\n    std.debug.print(\"{s}\\n\", .{label});\n    return utils.trim(label);\n}\n\nfn helper(value: f64) f64 {\n    return value * 2.0;\n}\n\ntest \"describe\" {\n    const s = Shape{ .sides = 3, .name = \"tri\" };\n    try std.testing.expect(s.sides == 3);\n}\n",
      container_field: "const std = @import(\"std\");\nconst utils = @import(\"utils.zig\");\n\npub const Shape = struct {\n    sides: u32,\n    name: []const u8,\n\n    pub fn area(self: Shape) f64 {\n        return helper(@floatFromInt(self.sides));\n    }\n};\n\npub const Color = enum { red, green, blue };\n\npub const Payload = union(enum) {\n    circle: f64,\n    square: Shape,\n};\n\npub const Point = struct {\n    x: f64,\n    y: f64,\n};\n\npub fn describe(shape: *const Shape) []const u8 {\n    const label = shape.name;\n    std.debug.print(\"{s}\\n\", .{label});\n    return utils.trim(label);\n}\n\nfn helper(value: f64) f64 {\n    return value * 2.0;\n}\n\ntest \"describe\" {\n    const s = Shape{ .sides = 3, .name = \"tri\" };\n    try std.testing.expect(s.sides == 3);\n}\n",
    },
    elixir: {
      call: "defmodule Example.Core do\n  @moduledoc \"A sample module.\"\n\n  alias Example.Math.Vector\n  alias Example.Math.{ Matrix, Point }\n  import Enum, only: [map: 2]\n  require Logger\n  use GenServer\n\n  defstruct name: \"x\", size: 0\n\n  @type t :: %__MODULE__{name: String.t(), size: integer()}\n\n  def area(shape) do\n    helper(shape.side) * shape.side\n  end\n\n  defp helper(value) do\n    Logger.debug(\"helper\")\n    value\n  end\n\n  def handle_call(:ping, _from, state) do\n    {:reply, :pong, state}\n  end\nend\n\ndefmodule Example.Square do\n  defstruct side: 1.0\n\n  def describe(shape) do\n    Vector.new(shape.side)\n  end\nend\n\ndefimpl String.Chars, for: Example.Core do\n  def to_string(_), do: \"core\"\nend\n",
    },
    julia: {
      module_definition: "module Example\n\nusing LinearAlgebra\nimport Base: show, +\nusing Statistics: mean\n\nexport Shape, area\n\nabstract type AbstractShape end\n\nstruct Point <: AbstractShape\n    x::Float64\n    y::Float64\nend\n\nmutable struct Square <: AbstractShape\n    side::Float64\nend\n\nconst DEFAULT_SIDE = 1.0\n\nfunction area(s::Square)::Float64\n    helper(s.side) * s.side\nend\n\nhelper(value) = value * 2\n\nfunction Base.show(io::IO, p::Point)\n    print(io, \"Point(\", p.x, \", \", p.y, \")\")\nend\n\nend # module\n",
      struct_definition: "module Example\n\nusing LinearAlgebra\nimport Base: show, +\nusing Statistics: mean\n\nexport Shape, area\n\nabstract type AbstractShape end\n\nstruct Point <: AbstractShape\n    x::Float64\n    y::Float64\nend\n\nmutable struct Square <: AbstractShape\n    side::Float64\nend\n\nconst DEFAULT_SIDE = 1.0\n\nfunction area(s::Square)::Float64\n    helper(s.side) * s.side\nend\n\nhelper(value) = value * 2\n\nfunction Base.show(io::IO, p::Point)\n    print(io, \"Point(\", p.x, \", \", p.y, \")\")\nend\n\nend # module\n",
      abstract_definition: "module Example\n\nusing LinearAlgebra\nimport Base: show, +\nusing Statistics: mean\n\nexport Shape, area\n\nabstract type AbstractShape end\n\nstruct Point <: AbstractShape\n    x::Float64\n    y::Float64\nend\n\nmutable struct Square <: AbstractShape\n    side::Float64\nend\n\nconst DEFAULT_SIDE = 1.0\n\nfunction area(s::Square)::Float64\n    helper(s.side) * s.side\nend\n\nhelper(value) = value * 2\n\nfunction Base.show(io::IO, p::Point)\n    print(io, \"Point(\", p.x, \", \", p.y, \")\")\nend\n\nend # module\n",
      function_definition: "module Example\n\nusing LinearAlgebra\nimport Base: show, +\nusing Statistics: mean\n\nexport Shape, area\n\nabstract type AbstractShape end\n\nstruct Point <: AbstractShape\n    x::Float64\n    y::Float64\nend\n\nmutable struct Square <: AbstractShape\n    side::Float64\nend\n\nconst DEFAULT_SIDE = 1.0\n\nfunction area(s::Square)::Float64\n    helper(s.side) * s.side\nend\n\nhelper(value) = value * 2\n\nfunction Base.show(io::IO, p::Point)\n    print(io, \"Point(\", p.x, \", \", p.y, \")\")\nend\n\nend # module\n",
      assignment: "module Example\n\nusing LinearAlgebra\nimport Base: show, +\nusing Statistics: mean\n\nexport Shape, area\n\nabstract type AbstractShape end\n\nstruct Point <: AbstractShape\n    x::Float64\n    y::Float64\nend\n\nmutable struct Square <: AbstractShape\n    side::Float64\nend\n\nconst DEFAULT_SIDE = 1.0\n\nfunction area(s::Square)::Float64\n    helper(s.side) * s.side\nend\n\nhelper(value) = value * 2\n\nfunction Base.show(io::IO, p::Point)\n    print(io, \"Point(\", p.x, \", \", p.y, \")\")\nend\n\nend # module\n",
      const_statement: "module Example\n\nusing LinearAlgebra\nimport Base: show, +\nusing Statistics: mean\n\nexport Shape, area\n\nabstract type AbstractShape end\n\nstruct Point <: AbstractShape\n    x::Float64\n    y::Float64\nend\n\nmutable struct Square <: AbstractShape\n    side::Float64\nend\n\nconst DEFAULT_SIDE = 1.0\n\nfunction area(s::Square)::Float64\n    helper(s.side) * s.side\nend\n\nhelper(value) = value * 2\n\nfunction Base.show(io::IO, p::Point)\n    print(io, \"Point(\", p.x, \", \", p.y, \")\")\nend\n\nend # module\n",
    },
    haskell: {
      function: "module Example.Core\n  ( Shape(..)\n  , area\n  ) where\n\nimport qualified Data.List as List\nimport Data.Maybe (fromMaybe)\nimport Control.Monad\n\ntype Radius = Double\n\ndata Shape\n  = Circle Radius\n  | Square Radius\n  deriving (Show, Eq)\n\nnewtype Wrapper = Wrapper { unwrap :: Int }\n\nclass Describable a where\n  describe :: a -> String\n\ninstance Describable Shape where\n  describe shape = helper 1.0\n\narea :: Shape -> Double\narea shape = helper 1.0\n\nhelper :: Double -> Double\nhelper value = value * 2\n\nmain :: IO ()\nmain = do\n  print (area (Circle 1.0))\n",
      data_type: "module Example.Core\n  ( Shape(..)\n  , area\n  ) where\n\nimport qualified Data.List as List\nimport Data.Maybe (fromMaybe)\nimport Control.Monad\n\ntype Radius = Double\n\ndata Shape\n  = Circle Radius\n  | Square Radius\n  deriving (Show, Eq)\n\nnewtype Wrapper = Wrapper { unwrap :: Int }\n\nclass Describable a where\n  describe :: a -> String\n\ninstance Describable Shape where\n  describe shape = helper 1.0\n\narea :: Shape -> Double\narea shape = helper 1.0\n\nhelper :: Double -> Double\nhelper value = value * 2\n\nmain :: IO ()\nmain = do\n  print (area (Circle 1.0))\n",
      newtype: "module Example.Core\n  ( Shape(..)\n  , area\n  ) where\n\nimport qualified Data.List as List\nimport Data.Maybe (fromMaybe)\nimport Control.Monad\n\ntype Radius = Double\n\ndata Shape\n  = Circle Radius\n  | Square Radius\n  deriving (Show, Eq)\n\nnewtype Wrapper = Wrapper { unwrap :: Int }\n\nclass Describable a where\n  describe :: a -> String\n\ninstance Describable Shape where\n  describe shape = helper 1.0\n\narea :: Shape -> Double\narea shape = helper 1.0\n\nhelper :: Double -> Double\nhelper value = value * 2\n\nmain :: IO ()\nmain = do\n  print (area (Circle 1.0))\n",
      type_synonym: "module Example.Core\n  ( Shape(..)\n  , area\n  ) where\n\nimport qualified Data.List as List\nimport Data.Maybe (fromMaybe)\nimport Control.Monad\n\ntype Radius = Double\n\ndata Shape\n  = Circle Radius\n  | Square Radius\n  deriving (Show, Eq)\n\nnewtype Wrapper = Wrapper { unwrap :: Int }\n\nclass Describable a where\n  describe :: a -> String\n\ninstance Describable Shape where\n  describe shape = helper 1.0\n\narea :: Shape -> Double\narea shape = helper 1.0\n\nhelper :: Double -> Double\nhelper value = value * 2\n\nmain :: IO ()\nmain = do\n  print (area (Circle 1.0))\n",
      class: "module Example.Core\n  ( Shape(..)\n  , area\n  ) where\n\nimport qualified Data.List as List\nimport Data.Maybe (fromMaybe)\nimport Control.Monad\n\ntype Radius = Double\n\ndata Shape\n  = Circle Radius\n  | Square Radius\n  deriving (Show, Eq)\n\nnewtype Wrapper = Wrapper { unwrap :: Int }\n\nclass Describable a where\n  describe :: a -> String\n\ninstance Describable Shape where\n  describe shape = helper 1.0\n\narea :: Shape -> Double\narea shape = helper 1.0\n\nhelper :: Double -> Double\nhelper value = value * 2\n\nmain :: IO ()\nmain = do\n  print (area (Circle 1.0))\n",
    },
    r: {
      binary_operator: "library(dplyr)\nlibrary(stats)\n\nPoint <- R6::R6Class(\"Point\",\n  public = list(\n    x = NULL,\n    y = NULL,\n    initialize = function(x = 0, y = 0) {\n      self$x <- x\n      self$y <- y\n    },\n    area = function() {\n      helper(self$x) * self$y\n    }\n  )\n)\n\nShape <- setRefClass(\"Shape\",\n  fields = list(name = \"character\"),\n  methods = list(\n    describe = function() {\n      paste(\"shape\", .self$name)\n    }\n  )\n)\n\narea <- function(shape, ...) {\n  stopifnot(!missing(shape))\n  shape$area()\n}\n\nhelper <- function(value) {\n  message(\"helper: \", value)\n  value * 2\n}\n\nmain <- function() {\n  p <- Point$new(1, 2)\n  print(area(p))\n}\n",
      argument: "library(dplyr)\nlibrary(stats)\n\nPoint <- R6::R6Class(\"Point\",\n  public = list(\n    x = NULL,\n    y = NULL,\n    initialize = function(x = 0, y = 0) {\n      self$x <- x\n      self$y <- y\n    },\n    area = function() {\n      helper(self$x) * self$y\n    }\n  )\n)\n\nShape <- setRefClass(\"Shape\",\n  fields = list(name = \"character\"),\n  methods = list(\n    describe = function() {\n      paste(\"shape\", .self$name)\n    }\n  )\n)\n\narea <- function(shape, ...) {\n  stopifnot(!missing(shape))\n  shape$area()\n}\n\nhelper <- function(value) {\n  message(\"helper: \", value)\n  value * 2\n}\n\nmain <- function() {\n  p <- Point$new(1, 2)\n  print(area(p))\n}\n",
      parameter: "library(dplyr)\nlibrary(stats)\n\nPoint <- R6::R6Class(\"Point\",\n  public = list(\n    x = NULL,\n    y = NULL,\n    initialize = function(x = 0, y = 0) {\n      self$x <- x\n      self$y <- y\n    },\n    area = function() {\n      helper(self$x) * self$y\n    }\n  )\n)\n\nShape <- setRefClass(\"Shape\",\n  fields = list(name = \"character\"),\n  methods = list(\n    describe = function() {\n      paste(\"shape\", .self$name)\n    }\n  )\n)\n\narea <- function(shape, ...) {\n  stopifnot(!missing(shape))\n  shape$area()\n}\n\nhelper <- function(value) {\n  message(\"helper: \", value)\n  value * 2\n}\n\nmain <- function() {\n  p <- Point$new(1, 2)\n  print(area(p))\n}\n",
    },
    objc: {
      class_interface: "#import <Foundation/Foundation.h>\n#include \"Local.h\"\n\n@protocol Describable\n- (NSString *)describe;\n@end\n\n@interface Shape : NSObject <Describable> {\n  double _side;\n}\n@property (nonatomic, assign) double side;\n- (double)area;\n+ (instancetype)shapeWithSide:(double)side;\n@end\n\n@implementation Shape\n@synthesize side = _side;\n\n- (double)area {\n  return helper(self.side) * self.side;\n}\n\n+ (instancetype)shapeWithSide:(double)side {\n  Shape *shape = [[Shape alloc] init];\n  shape.side = side;\n  return shape;\n}\n\n- (NSString *)describe {\n  return [NSString stringWithFormat:@\"%f\", [self area]];\n}\n@end\n\n@interface Square : Shape\n@end\n\n@implementation Square\n@end\n\nstatic double helper(double value) {\n  return value * 2;\n}\n",
      class_implementation: "#import <Foundation/Foundation.h>\n#include \"Local.h\"\n\n@protocol Describable\n- (NSString *)describe;\n@end\n\n@interface Shape : NSObject <Describable> {\n  double _side;\n}\n@property (nonatomic, assign) double side;\n- (double)area;\n+ (instancetype)shapeWithSide:(double)side;\n@end\n\n@implementation Shape\n@synthesize side = _side;\n\n- (double)area {\n  return helper(self.side) * self.side;\n}\n\n+ (instancetype)shapeWithSide:(double)side {\n  Shape *shape = [[Shape alloc] init];\n  shape.side = side;\n  return shape;\n}\n\n- (NSString *)describe {\n  return [NSString stringWithFormat:@\"%f\", [self area]];\n}\n@end\n\n@interface Square : Shape\n@end\n\n@implementation Square\n@end\n\nstatic double helper(double value) {\n  return value * 2;\n}\n",
      protocol_declaration: "#import <Foundation/Foundation.h>\n#include \"Local.h\"\n\n@protocol Describable\n- (NSString *)describe;\n@end\n\n@interface Shape : NSObject <Describable> {\n  double _side;\n}\n@property (nonatomic, assign) double side;\n- (double)area;\n+ (instancetype)shapeWithSide:(double)side;\n@end\n\n@implementation Shape\n@synthesize side = _side;\n\n- (double)area {\n  return helper(self.side) * self.side;\n}\n\n+ (instancetype)shapeWithSide:(double)side {\n  Shape *shape = [[Shape alloc] init];\n  shape.side = side;\n  return shape;\n}\n\n- (NSString *)describe {\n  return [NSString stringWithFormat:@\"%f\", [self area]];\n}\n@end\n\n@interface Square : Shape\n@end\n\n@implementation Square\n@end\n\nstatic double helper(double value) {\n  return value * 2;\n}\n",
      method_definition: "#import <Foundation/Foundation.h>\n#include \"Local.h\"\n\n@protocol Describable\n- (NSString *)describe;\n@end\n\n@interface Shape : NSObject <Describable> {\n  double _side;\n}\n@property (nonatomic, assign) double side;\n- (double)area;\n+ (instancetype)shapeWithSide:(double)side;\n@end\n\n@implementation Shape\n@synthesize side = _side;\n\n- (double)area {\n  return helper(self.side) * self.side;\n}\n\n+ (instancetype)shapeWithSide:(double)side {\n  Shape *shape = [[Shape alloc] init];\n  shape.side = side;\n  return shape;\n}\n\n- (NSString *)describe {\n  return [NSString stringWithFormat:@\"%f\", [self area]];\n}\n@end\n\n@interface Square : Shape\n@end\n\n@implementation Square\n@end\n\nstatic double helper(double value) {\n  return value * 2;\n}\n",
      method_declaration: "#import <Foundation/Foundation.h>\n#include \"Local.h\"\n\n@protocol Describable\n- (NSString *)describe;\n@end\n\n@interface Shape : NSObject <Describable> {\n  double _side;\n}\n@property (nonatomic, assign) double side;\n- (double)area;\n+ (instancetype)shapeWithSide:(double)side;\n@end\n\n@implementation Shape\n@synthesize side = _side;\n\n- (double)area {\n  return helper(self.side) * self.side;\n}\n\n+ (instancetype)shapeWithSide:(double)side {\n  Shape *shape = [[Shape alloc] init];\n  shape.side = side;\n  return shape;\n}\n\n- (NSString *)describe {\n  return [NSString stringWithFormat:@\"%f\", [self area]];\n}\n@end\n\n@interface Square : Shape\n@end\n\n@implementation Square\n@end\n\nstatic double helper(double value) {\n  return value * 2;\n}\n",
      property_declaration: "#import <Foundation/Foundation.h>\n#include \"Local.h\"\n\n@protocol Describable\n- (NSString *)describe;\n@end\n\n@interface Shape : NSObject <Describable> {\n  double _side;\n}\n@property (nonatomic, assign) double side;\n- (double)area;\n+ (instancetype)shapeWithSide:(double)side;\n@end\n\n@implementation Shape\n@synthesize side = _side;\n\n- (double)area {\n  return helper(self.side) * self.side;\n}\n\n+ (instancetype)shapeWithSide:(double)side {\n  Shape *shape = [[Shape alloc] init];\n  shape.side = side;\n  return shape;\n}\n\n- (NSString *)describe {\n  return [NSString stringWithFormat:@\"%f\", [self area]];\n}\n@end\n\n@interface Square : Shape\n@end\n\n@implementation Square\n@end\n\nstatic double helper(double value) {\n  return value * 2;\n}\n",
      instance_variable: "#import <Foundation/Foundation.h>\n#include \"Local.h\"\n\n@protocol Describable\n- (NSString *)describe;\n@end\n\n@interface Shape : NSObject <Describable> {\n  double _side;\n}\n@property (nonatomic, assign) double side;\n- (double)area;\n+ (instancetype)shapeWithSide:(double)side;\n@end\n\n@implementation Shape\n@synthesize side = _side;\n\n- (double)area {\n  return helper(self.side) * self.side;\n}\n\n+ (instancetype)shapeWithSide:(double)side {\n  Shape *shape = [[Shape alloc] init];\n  shape.side = side;\n  return shape;\n}\n\n- (NSString *)describe {\n  return [NSString stringWithFormat:@\"%f\", [self area]];\n}\n@end\n\n@interface Square : Shape\n@end\n\n@implementation Square\n@end\n\nstatic double helper(double value) {\n  return value * 2;\n}\n",
      function_definition: "#import <Foundation/Foundation.h>\n#include \"Local.h\"\n\n@protocol Describable\n- (NSString *)describe;\n@end\n\n@interface Shape : NSObject <Describable> {\n  double _side;\n}\n@property (nonatomic, assign) double side;\n- (double)area;\n+ (instancetype)shapeWithSide:(double)side;\n@end\n\n@implementation Shape\n@synthesize side = _side;\n\n- (double)area {\n  return helper(self.side) * self.side;\n}\n\n+ (instancetype)shapeWithSide:(double)side {\n  Shape *shape = [[Shape alloc] init];\n  shape.side = side;\n  return shape;\n}\n\n- (NSString *)describe {\n  return [NSString stringWithFormat:@\"%f\", [self area]];\n}\n@end\n\n@interface Square : Shape\n@end\n\n@implementation Square\n@end\n\nstatic double helper(double value) {\n  return value * 2;\n}\n",
    },
    groovy: {
      class_definition: "package example.core\n\nimport groovy.transform.CompileStatic\nimport java.util.List\n\ninterface Describable {\n    String describe()\n}\n\n@CompileStatic\nclass Shape extends Base {\n    double side\n\n    Shape(side) {\n        this.side = side\n    }\n\n    double area() {\n        return helper(side) * side\n    }\n\n    String describe() {\n        return \"shape\"\n    }\n}\n\nclass Square extends Shape {\n    Square(side) {\n        super(side)\n    }\n}\n\ndef helper(value) {\n    println \"helper ${value}\"\n    return value\n}\n",
      function_definition: "package example.core\n\nimport groovy.transform.CompileStatic\nimport java.util.List\n\ninterface Describable {\n    String describe()\n}\n\n@CompileStatic\nclass Shape extends Base {\n    double side\n\n    Shape(side) {\n        this.side = side\n    }\n\n    double area() {\n        return helper(side) * side\n    }\n\n    String describe() {\n        return \"shape\"\n    }\n}\n\nclass Square extends Shape {\n    Square(side) {\n        super(side)\n    }\n}\n\ndef helper(value) {\n    println \"helper ${value}\"\n    return value\n}\n",
      function_declaration: "package example.core\n\nimport groovy.transform.CompileStatic\nimport java.util.List\n\ninterface Describable {\n    String describe()\n}\n\n@CompileStatic\nclass Shape extends Base {\n    double side\n\n    Shape(side) {\n        this.side = side\n    }\n\n    double area() {\n        return helper(side) * side\n    }\n\n    String describe() {\n        return \"shape\"\n    }\n}\n\nclass Square extends Shape {\n    Square(side) {\n        super(side)\n    }\n}\n\ndef helper(value) {\n    println \"helper ${value}\"\n    return value\n}\n",
      declaration: "package example.core\n\nimport groovy.transform.CompileStatic\nimport java.util.List\n\ninterface Describable {\n    String describe()\n}\n\n@CompileStatic\nclass Shape extends Base {\n    double side\n\n    Shape(side) {\n        this.side = side\n    }\n\n    double area() {\n        return helper(side) * side\n    }\n\n    String describe() {\n        return \"shape\"\n    }\n}\n\nclass Square extends Shape {\n    Square(side) {\n        super(side)\n    }\n}\n\ndef helper(value) {\n    println \"helper ${value}\"\n    return value\n}\n",
    },
  }

  for (const [languageId, entries] of Object.entries(SAMPLES)) {
    for (const [nodeType, source] of Object.entries(entries)) {
      it(`${languageId}: ${nodeType} produces a symbol`, async (t) => {
        const shape = GRAMMAR_SHAPES[languageId]
        assert.ok(shape !== undefined, `no shape for ${languageId}`)
        const entry = shape.declarations[nodeType]
        assert.ok(entry !== undefined, `${nodeType} is not in ${languageId}'s declarations table`)
        // A node type may carry an ORDERED LIST of rules when the grammar spells several
        // constructs the same way (Elixir's `call`), so the case asserts that any of the
        // row's kinds came out.
        const expectedKinds = (Array.isArray(entry) ? entry : [entry]).map(rule => rule.kind)
        // An ON-DEMAND grammar is downloaded at run time, so a test machine may
        // not have it. Skipping by NAME is honest: the alternative is a case that
        // passes because it never ran, or a failure that reports a wrong table
        // when the truth is "not downloaded".
        if (!grammarAvailable(languageId)) {
          t.skip(`${languageId}'s grammar is not installed; set DSH_APP_CODEGRAPH_GRAMMARS to a download directory to run it`)
          return
        }
        const parsed = await parse(source, languageId, `a.${languageId}`)
        assert.ok(parsed.symbols.length > 0,
          `${nodeType} produced NO symbol from ${JSON.stringify(source)} — its nameField names a field the grammar does not have`)
        assert.ok(parsed.symbols.some(symbol => expectedKinds.includes(symbol.kind)),
          `${nodeType} produced no ${expectedKinds.join('/')} symbol; got ${parsed.symbols.map(s => `${s.kind}:${s.name}`).join(',')}`)
      })
    }
  }

  it('covers every declaration entry in every shape (no untested row)', () => {
    for (const [languageId, shape] of Object.entries(GRAMMAR_SHAPES)) {
      // An ALIAS introduces no rows: Vue and Svelte share the TypeScript table because
      // their code is TypeScript, so demanding a second set of samples would test the
      // same table twice. The identity is asserted rather than assumed — an alias that
      // quietly became its own table must not be able to skip this check.
      if (Object.values(GRAMMAR_SHAPES).filter(other => other === shape).length > 1) continue
      const samples = SAMPLES[languageId]
      assert.ok(samples !== undefined, `${languageId} has a shape but no samples — add one per declaration entry`)
      for (const nodeType of Object.keys(shape.declarations)) {
        assert.ok(samples[nodeType] !== undefined,
          `${languageId}.${nodeType} has no sample; a wrong nameField there would ship silently`)
      }
    }
  })
})

describe('GRAMMAR_SHAPES — every call and import entry is reachable', () => {
  it('attributes each call to the declaration that contains it', async () => {
    // W11b's core contract. Before it, every call edge started at the FILE, so
    // `codegraph_context` answered "what does this file call" for every symbol in
    // it — which for a 40-function file is 40 identical lists.
    const parsed = await parse([
      'function outer() {',
      '  inner()',
      '  return deep()',
      '}',
      'function inner() {',
      '  deep()',
      '}',
      'function deep() { return 1 }',
      'top()',
    ].join('\n'), 'typescript', 'a.ts')

    const owner = (name: string): string | undefined => parsed.calls.find(call => call.name === name)?.owner
    assert.equal(owner('inner'), 'a.ts#function:outer', 'a call inside outer belongs to outer')
    assert.equal(owner('top'), undefined, 'a call at file scope belongs to no symbol')
    // `deep` is called from two declarations, so there are two calls with two
    // different owners — not one edge shared by the file.
    const deepOwners = parsed.calls.filter(call => call.name === 'deep').map(call => call.owner)
    assert.deepEqual(deepOwners, ['a.ts#function:outer', 'a.ts#function:inner'])
  })

  it('gives each overload its own ownership, so two overloads are two callers', async () => {
    // The id carries the ordinal, and the ordinal is what tells two same-named
    // declarations apart. Using the NAME here would merge their call edges.
    const parsed = await parse([
      'class C {',
      '  m(a: number) { helper() }',
      '  m(a: string) { helper() }',
      '  helper() {}',
      '}',
    ].join('\n'), 'typescript', 'a.ts')
    const owners = parsed.calls.filter(call => call.name === 'helper').map(call => call.owner)
    assert.equal(new Set(owners).size, 2, `two overloads must be two owners, got ${JSON.stringify(owners)}`)
  })

  it('attributes a nested function call to the innermost declaration', async () => {
    // The walk replaces the owner on entering a declaration and restores it on
    // leaving, so a closure's call belongs to the closure.
    const parsed = await parse([
      'function outer() {',
      '  function inner() {',
      '    target()',
      '  }',
      '}',
    ].join('\n'), 'typescript', 'a.ts')
    assert.equal(parsed.calls.find(call => call.name === 'target')?.owner, 'a.ts#function:outer.inner')
  })

  it('captures a bare call, a member call, a Go selector call and a Java invocation', async () => {
    const bare = await parse('function a() { return b() }', 'typescript', 'a.ts')
    assert.ok(bare.calls.some(call => call.name === 'b'), 'bare call')

    // The defect this pins: `leafName` had no `property` branch, so every
    // `this.foo()` / `obj.method()` produced no edge at all.
    const member = await parse('class C { m() { this.helper() } helper() {} }', 'typescript', 'a.ts')
    assert.ok(member.calls.some(call => call.name === 'helper'), `member call, got ${member.calls.map(c => c.name).join(',')}`)

    const go = await parse('package m\nfunc F() { pkg.G() }', 'go', 'a.go')
    assert.ok(go.calls.some(call => call.name === 'G'), `go selector, got ${go.calls.map(c => c.name).join(',')}`)

    const java = await parse('class C { void m() { helper(); } void helper() {} }', 'java', 'C.java')
    assert.ok(java.calls.some(call => call.name === 'helper'), 'java invocation')
  })

  it('captures imports for every language with an import entry', async () => {
    const ts = await parse("import x from './x.ts'", 'typescript', 'a.ts')
    assert.deepEqual(ts.imports.map(entry => entry.specifier), ['./x.ts'])

    const py = await parse('import os', 'python', 'a.py')
    assert.ok(py.imports.some(entry => entry.specifier === 'os'), `python import, got ${JSON.stringify(py.imports)}`)

    // Java's `import_declaration` has no fields at all; the fallback is what
    // makes this reachable.
    const java = await parse('import java.util.List;', 'java', 'C.java')
    assert.ok(java.imports.some(entry => entry.specifier.includes('List')), `java import, got ${JSON.stringify(java.imports)}`)

    const c = await parse('#include <stdio.h>', 'c', 'a.c')
    assert.ok(c.imports.some(entry => entry.specifier.includes('stdio')), `c include, got ${JSON.stringify(c.imports)}`)
  })
})

describe('extractSymbols — overloads', () => {
  it('keeps two same-named methods addressable instead of colliding on the id', async () => {
    // A duplicate id is the symbols table's PRIMARY KEY, so before the ordinal
    // this file's ENTIRE write failed and the graph kept its previous snapshot.
    const parsed = await parse('class C { void m() {} void m(int x) {} }', 'java', 'C.java')
    const methods = parsed.symbols.filter(symbol => symbol.name === 'm')
    assert.equal(methods.length, 2, `got ${parsed.symbols.map(s => s.id).join(',')}`)
    assert.notEqual(methods[0]?.id, methods[1]?.id)
    assert.ok(methods[0]?.id.endsWith('#method:C.m'))
    assert.ok(methods[1]?.id.endsWith('#method:C.m#1'))
  })
})

describe('extractSymbols — unsupported', () => {
  it('flags a language with a grammar but no shape, instead of reporting an empty file', async () => {
    const root: SyntaxNode = {
      type: 'program',
      text: '',
      startPosition: { row: 0 },
      endPosition: { row: 0 },
      namedChildren: [],
      childForFieldName: () => null,
    }
    // `css` parses and downloads but declares nothing a caller can reference — a
    // selector is not a symbol. It must report `unsupported`, not an empty file:
    // the two are different facts and only one means this language works.
    const parsed = extractSymbols(root, 'a.css', 'css')
    assert.equal(parsed.unsupported, 'noShape')
    assert.deepEqual(parsed.symbols, [])
  })
})

describe('extractSymbols — relationships the call walk cannot see', () => {
  it('records extends and implements as different kinds', async () => {
    // A class that implements an interface does not CALL it, so no call edge exists.
    // Before these two kinds, `impact` on an interface answered only the places that
    // NAME it — never the classes that implement it, which is the question a reader
    // has about an interface.
    const source = [
      'class Base {}',
      'interface Shape { area(): number }',
      'class Square extends Base implements Shape {',
      '  area() { return 1 }',
      '}',
    ].join('\n')
    const parsed = await parse(source, 'typescript', 'src/a.ts')
    const square = 'src/a.ts#class:Square'
    assert.deepEqual(
      parsed.heritage.map(row => [row.kind, row.name, row.from]),
      [['extends', 'Base', square], ['implements', 'Shape', square]],
      'both are recorded, and kept apart',
    )
  })

  it('records a type named in a signature, which is never a call', async () => {
    // `function f(x: Foo)` does not call Foo. Without this edge, changing Foo breaks
    // f and `impact` says nothing.
    const source = 'function takes(x: SomeParam): SomeReturn { return x }'
    const parsed = await parse(source, 'typescript', 'src/a.ts')
    assert.deepEqual(
      parsed.typeRefs.map(row => [row.name, row.owner]),
      [['SomeParam', 'src/a.ts#function:takes'], ['SomeReturn', 'src/a.ts#function:takes']],
    )
  })

  it('ignores builtin type names, which resolve to nothing', async () => {
    // An edge for `string` would be noise in every answer, forever.
    const source = 'function f(a: string, b: number): void {}'
    const parsed = await parse(source, 'typescript', 'src/a.ts')
    assert.deepEqual(parsed.typeRefs, [])
  })

  it('records what a module publishes, including a star re-export', async () => {
    // A module's public surface is not derivable from references: an exported symbol
    // with no internal caller is still the API. `export * from './x'` has no name of
    // its own, so it is recorded as an `all` row carrying the source.
    const source = [
      'export const value = 1',
      'export function fn() {}',
      'export { inner } from \'./inner\'',
      'export * from \'./star\'',
    ].join('\n')
    const parsed = await parse(source, 'typescript', 'src/a.ts')
    assert.deepEqual(
      parsed.exports.map(row => [row.all, row.name]),
      [[false, 'value'], [false, 'fn'], [false, 'inner'], [true, './star']],
    )
  })
})

describe('extractSymbols — heritage beyond TypeScript', () => {
  it('reads Python base classes from the class header only, never from a call', () => {
    // Python spells both a class header and a call with `argument_list`, so the
    // node type alone would read `foo(bar)` as "foo derives from bar". The `parent`
    // guard is the whole reason this row is safe.
    const source = [
      'class A(Base, Mixin):',
      '  def m(self):',
      '    helper(thing)',
    ].join('\n')
    return parse(source, 'python', 'src/a.py').then((parsed) => {
      assert.deepEqual(
        parsed.heritage.map(row => [row.kind, row.name]),
        [['extends', 'Base'], ['extends', 'Mixin']],
        'the class header yields both bases, and the call yields none',
      )
    })
  })

  it('keeps Java superclass and implemented interfaces apart', () => {
    // Java names them with two different node types, and a reader asking about an
    // interface means `implements` — merging the two answers with the wrong set.
    const source = 'class A extends B implements I, J { }'
    return parse(source, 'java', 'src/A.java').then((parsed) => {
      assert.deepEqual(
        parsed.heritage.map(row => [row.kind, row.name]),
        [['extends', 'B'], ['implements', 'I'], ['implements', 'J']],
      )
    })
  })

  it('records C# base types, which the grammar does not split by relationship', () => {
    // C# puts bases and interfaces in one `base_list`, so the distinction is not
    // available. Recorded as `extends` rather than guessed into `implements`,
    // because a wrong `implements` answers "who implements this" with derivations.
    const source = 'class A : B, I { }'
    return parse(source, 'c_sharp', 'src/A.cs').then((parsed) => {
      assert.deepEqual(
        parsed.heritage.map(row => [row.kind, row.name]),
        [['extends', 'B'], ['extends', 'I']],
      )
    })
  })
})

describe('relationEdges — import-guided resolution', () => {
  // `Model` is declared in two OTHER files, so this file has no local declaration to
  // shadow it and the import clause is the only thing that can narrow the answer.
  const symbols = [
    { id: 'lib/a.ts#interface:Model', path: 'lib/a.ts', name: 'Model', kind: 'interface', line: 1, endLine: 1, parent: undefined },
    { id: 'lib/b.ts#interface:Model', path: 'lib/b.ts', name: 'Model', kind: 'interface', line: 1, endLine: 1, parent: undefined },
    { id: 'app.ts#class:Uses', path: 'app.ts', name: 'Uses', kind: 'class', line: 5, endLine: 9, parent: undefined },
  ]
  const resolve = (name: string): readonly string[] => symbols.filter(s => s.name === name).map(s => s.id)

  it('resolves a type to the module its import names, not to every same-named one', () => {
    // The failure this pins, measured: `Model` is declared in two files, so every
    // signature naming it produced TWO edges and the count read about double the
    // truth. `import { Model } from './lib/a'` states which one this file means.
    const parsed = {
      symbols,
      calls: [],
      imports: [{ specifier: './lib/a', line: 1, names: ['Model'] }],
      heritage: [],
      typeRefs: [{ name: 'Model', line: 7, owner: 'app.ts#class:Uses' }],
      exports: [],
      hasError: false,
    }
    const resolveModule = (spec: string): string | undefined => (spec === './lib/a' ? 'lib/a.ts' : undefined)
    const edges = relationEdges(parsed, 'file:app.ts', resolve, resolveModule)
    assert.deepEqual(edges.map(edge => edge.to), ['lib/a.ts#interface:Model'], 'one edge, to the imported one')
  })

  it('falls back to every declaration when no import names the type', () => {
    // Without an import clause there is nothing to narrow by, so the shared-name rule
    // applies — both are linked, and the reader picks. Under-reporting here would be
    // the failure that changes code silently.
    const parsed = {
      symbols,
      calls: [],
      imports: [],
      heritage: [],
      typeRefs: [{ name: 'Model', line: 7, owner: 'app.ts#class:Uses' }],
      exports: [],
      hasError: false,
    }
    const edges = relationEdges(parsed, 'file:app.ts', resolve)
    assert.equal(edges.length, 2, 'both declarations are linked when nothing narrows it')
  })
})

describe('callEdges — import-guided resolution', () => {
  // The call walk and the relationship walk share ONE layering (parse.ts), because two
  // copies of "which declaration does this name mean" would eventually disagree — and
  // the symptom would be a symbol whose callers and whose implementers are drawn from
  // different files.
  const symbols = [
    { id: 'lib/a.ts#function:shared', path: 'lib/a.ts', name: 'shared', kind: 'function', line: 1, endLine: 1, parent: undefined },
    { id: 'lib/b.ts#function:shared', path: 'lib/b.ts', name: 'shared', kind: 'function', line: 1, endLine: 1, parent: undefined },
  ]
  const resolve = (name: string): readonly string[] => symbols.filter(symbol => symbol.name === name).map(symbol => symbol.id)

  it('links a call to the declaration in the module the file imports it from', () => {
    const parsed = {
      symbols: [],
      calls: [{ name: 'shared', line: 5 }],
      imports: [{ specifier: './a', line: 1, names: ['shared'] }],
      heritage: [],
      typeRefs: [],
      exports: [],
      hasError: false,
    }
    const edges = callEdges(parsed, 'file:app.ts', resolve, spec => (spec === './a' ? 'lib/a.ts' : undefined))
    assert.deepEqual(edges.map(edge => edge.to), ['lib/a.ts#function:shared'], 'one edge, to the imported one')
  })

  it('links every same-named declaration when no import names it', () => {
    const parsed = {
      symbols: [],
      calls: [{ name: 'shared', line: 5 }],
      imports: [],
      heritage: [],
      typeRefs: [],
      exports: [],
      hasError: false,
    }
    // No clause means nothing narrows it, so the shared-name rule applies and both are
    // linked: under-reporting callers is the failure that changes code silently.
    assert.equal(callEdges(parsed, 'file:app.ts', resolve).length, 2)
  })

  it('falls back to the project-wide rule when the imported module only re-exports the name', () => {
    // The barrel shape: `import { shared } from './barrel'` where `barrel.ts` does
    // `export * from './impl'`. The clause names a module that declares nothing, so it
    // carries no information — and reading "not in that file" as "not called anywhere"
    // would delete a real caller and make `impact` answer "nothing calls this".
    const parsed = {
      symbols: [],
      calls: [{ name: 'shared', line: 5 }],
      imports: [{ specifier: './barrel', line: 1, names: ['shared'] }],
      heritage: [],
      typeRefs: [],
      exports: [],
      hasError: false,
    }
    const edges = callEdges(parsed, 'file:app.ts', resolve, spec => (spec === './barrel' ? 'lib/barrel.ts' : undefined))
    assert.equal(edges.length, 2, 'the same-name rule applies, because the import could not answer')
  })
})

describe('constructor calls across grammars', () => {
  // `new Foo()` is not a call in most grammars, so the extraction table needs a second
  // row per language. Each case below runs the REAL grammar: a node type that is wrong
  // produces no call and fails here, which is the only way to know the field name too.
  const CASES: readonly (readonly [string, string, string])[] = [
    ['java', 'class T { void f() { Widget w = new Widget(); } }', 'java'],
    ['c_sharp', 'class T { void F() { var w = new Widget(); } }', 'csharp'],
    ['scala', 'object T { def f(): Unit = { val w = new Widget() } }', 'scala'],
  ]

  for (const [languageId, source, label] of CASES) {
    it(`records the constructed type in ${label}`, async () => {
      const parsed = await parse(source, languageId, `src/a.${label}`)
      assert.deepEqual(parsed.calls.map(call => call.name), ['Widget'],
        `${languageId}: a constructor call must name the type it constructs`)
    })
  }
})
