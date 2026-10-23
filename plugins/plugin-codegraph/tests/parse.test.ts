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
 * and the three symbol-less formats) are downloaded into a user's storage at run
 * time, and the repository deliberately does not ship a second copy — that is the
 * whole point of "on demand". Their cases therefore SKIP by name on a machine
 * without them (16 skips, visible in the count, never silent). CI does not accept
 * that: it runs `scripts/fetch-ci-grammars.mjs` first and points
 * `DSH_APP_CODEGRAPH_GRAMMARS` at the result, so the same 233 cases execute
 * there. A local run reproduces CI with that variable set to any directory
 * holding the downloaded wasm.
 *
 * @module plugin-codegraph/tests/parse
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Parser, Language } from 'web-tree-sitter'
import { GRAMMAR_SHAPES, callEdges, extractSymbols, symbolId, type SyntaxNode } from '../src/parse.ts'
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
  const downloaded = process.env.DSH_APP_CODEGRAPH_GRAMMARS === undefined
    ? undefined
    : join(process.env.DSH_APP_CODEGRAPH_GRAMMARS, `tree-sitter-${spec.grammar}.wasm`)
  const file = existsSync(bundled) ? bundled : downloaded
  assert.ok(file !== undefined && existsSync(file),
    `no grammar for ${languageId} — bundled path ${bundled} is absent and DSH_APP_CODEGRAPH_GRAMMARS is ${process.env.DSH_APP_CODEGRAPH_GRAMMARS ?? 'unset'}`)
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

  it('finds import specifiers', async () => {
    const parsed = await parse("import { x } from './x.ts'\nimport y from 'y'", 'typescript', 'a.ts')
    assert.deepEqual(parsed.imports.map(entry => entry.specifier).sort(), ['./x.ts', 'y'])
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

describe('extractSymbols — an unsupported language', () => {
  it('answers nothing rather than throwing, so the file is still counted', () => {
    const root: SyntaxNode = {
      type: 'program',
      text: '',
      startPosition: { row: 0 },
      namedChildren: [],
      childForFieldName: () => null,
    }
    const parsed = extractSymbols(root, 'a.rb', 'ruby')
    assert.deepEqual(parsed.symbols, [])
    assert.deepEqual(parsed.calls, [])
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
  it('resolves an unambiguous name and drops an ambiguous one', () => {
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
    // Ambiguous and missing both answer no edge: under-reporting is visible,
    // guessing is not.
    assert.deepEqual(edges.map(edge => [edge.to, edge.line]), [['b.ts#function:unique', 1]])
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
    // Parseable, downloadable, and deliberately NOT symbol-producing: a selector,
    // a config key and a regex fragment name nothing a caller can reference. The
    // gate below requires an entry for every shape, so these three are stated as
    // EMPTY rather than omitted — an omission would read as an oversight.
    css: {},
    ini: {},
    regex: {},
  }

  for (const [languageId, entries] of Object.entries(SAMPLES)) {
    for (const [nodeType, source] of Object.entries(entries)) {
      it(`${languageId}: ${nodeType} produces a symbol`, async (t) => {
        const shape = GRAMMAR_SHAPES[languageId]
        assert.ok(shape !== undefined, `no shape for ${languageId}`)
        const expected = shape.declarations[nodeType]
        assert.ok(expected !== undefined, `${nodeType} is not in ${languageId}'s declarations table`)
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
        assert.ok(parsed.symbols.some(symbol => symbol.kind === expected.kind),
          `${nodeType} produced no '${expected.kind}' symbol; got ${parsed.symbols.map(s => `${s.kind}:${s.name}`).join(',')}`)
      })
    }
  }

  it('covers every declaration entry in every shape (no untested row)', () => {
    for (const [languageId, shape] of Object.entries(GRAMMAR_SHAPES)) {
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
