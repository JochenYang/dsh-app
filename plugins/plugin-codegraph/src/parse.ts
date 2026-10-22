/**
 * Parsing: one source file into the symbols it declares and the calls it makes.
 *
 * tree-sitter is a syntax tree, not a type checker. What that means concretely,
 * because it decides what the tools may claim:
 *
 *   - A **symbol** is a declaration node the grammar names: a function, a class,
 *     a method, a struct. Its id is derived from the path, kind, parent and
 *     name — never from a line, so re-formatting a file does not invalidate the
 *     references other files hold to it (see `store.ts`).
 *   - A **call edge** is `call_expression`-shaped: something was invoked under a
 *     name. It resolves to a symbol declared in THIS project when exactly one
 *     symbol carries that name, and is dropped otherwise. Guessing among several
 *     same-named symbols would produce an `impact` answer that is wrong in a way
 *     the reader cannot see; dropping it makes the graph under-report, which a
 *     reader can notice by finding no callers.
 *
 * The per-language node names live in a table rather than in a query file (`.scm`)
 * for one reason: a query file is a second language to write, and a wrong one
 * fails silently by matching nothing. A table of node type names is checkable by
 * a test that parses a real file and asserts what came out.
 *
 * @module @dsh-app/plugin-codegraph/host/parse
 */

import type { EdgeRecord, SymbolKind, SymbolRecord } from './store.ts'

/**
 * How one grammar names the things this plugin looks for.
 *
 * `declarations` maps a tree-sitter node type to the symbol kind it declares and
 * the field that carries its name. A grammar that names the same construct
 * differently is a new row, not a new code path.
 */
export interface GrammarShape {
  /** Node type → the symbol it declares. */
  readonly declarations: Readonly<Record<string, { kind: SymbolKind, nameField: string }>>
  /** Node types that wrap a body whose declarations belong to the enclosing symbol. */
  readonly scopes: readonly string[]
  /** Node type used for a call, and the field naming the callee. */
  readonly call: { readonly type: string, readonly field: string } | undefined
  /** Node type used for an import statement, and the field naming the target. */
  readonly import: { readonly type: string, readonly field: string } | undefined
}

/**
 * The shapes this plugin knows, keyed by language id.
 *
 * A language with no entry parses to nothing rather than throwing: the file is
 * still counted (so the graph says "this file is not understood" by having no
 * symbols, not by disappearing), and `LANGUAGE_UNSUPPORTED` is what the tools
 * report. Adding a language is a row here plus a test.
 */
/**
 * The shapes this plugin knows, keyed by language id.
 *
 * A language with no entry parses to nothing rather than throwing, and reports
 * `unsupported` so the tools can say why (see {@link ParsedFile}). Adding a
 * language is a row here plus a test — and the test must feed REAL source for
 * every row, because a `nameField` that names a field the grammar does not have
 * fails silently: the declaration is simply never produced. That is exactly how
 * `lexical_declaration` (TS/JS `const`) and Go's `type_declaration` shipped
 * broken once, and why `tests/parse.test.ts` now has one case per declaration
 * kind rather than one case per language.
 */
export const GRAMMAR_SHAPES: Readonly<Record<string, GrammarShape>> = {
  typescript: typescriptShape(),
  tsx: typescriptShape(),
  // JavaScript has no `interface` / `type` / `enum` declarations, so it gets its
  // own table rather than a copy of TypeScript's: a row the grammar cannot
  // produce is a row that silently never fires.
  javascript: javascriptShape(),
  python: {
    declarations: {
      function_definition: { kind: 'function', nameField: 'name' },
      class_definition: { kind: 'class', nameField: 'name' },
    },
    scopes: ['block'],
    call: { type: 'call', field: 'function' },
    import: { type: 'import_statement', field: 'name' },
  },
  go: {
    declarations: {
      function_declaration: { kind: 'function', nameField: 'name' },
      method_declaration: { kind: 'method', nameField: 'name' },
      // The name lives on the `type_spec` child; `type_declaration` itself has
      // no fields at all, which is how every Go type once went missing.
      type_spec: { kind: 'type', nameField: 'name' },
    },
    scopes: ['block'],
    call: { type: 'call_expression', field: 'function' },
    import: { type: 'import_spec', field: 'path' },
  },
  java: {
    declarations: {
      method_declaration: { kind: 'method', nameField: 'name' },
      class_declaration: { kind: 'class', nameField: 'name' },
      interface_declaration: { kind: 'interface', nameField: 'name' },
      enum_declaration: { kind: 'enum', nameField: 'name' },
    },
    scopes: ['class_body', 'interface_body', 'block'],
    call: { type: 'method_invocation', field: 'name' },
    // `import_declaration` has no fields; the target is a child node. The
    // `field` is empty and the extractor falls back to the first scoped name.
    import: { type: 'import_declaration', field: '' },
  },
  // C and C++ share ONE shape: they are parsed by the same `cpp` grammar, so a
  // narrower C table would only lose declarations that grammar does produce
  // (`class_specifier` in a `.h`, for instance) without gaining accuracy.
  c: cppShape(),
  cpp: cppShape(),
  c_sharp: {
    declarations: {
      method_declaration: { kind: 'method', nameField: 'name' },
      class_declaration: { kind: 'class', nameField: 'name' },
      interface_declaration: { kind: 'interface', nameField: 'name' },
      struct_declaration: { kind: 'struct', nameField: 'name' },
      enum_declaration: { kind: 'enum', nameField: 'name' },
      property_declaration: { kind: 'variable', nameField: 'name' },
    },
    scopes: ['declaration_list', 'block'],
    call: { type: 'invocation_expression', field: 'function' },
    import: { type: 'using_directive', field: 'name' },
  },
}

/** The TypeScript shape, shared by the three JS-family ids. */
function typescriptShape(): GrammarShape {
  return {
    declarations: {
      function_declaration: { kind: 'function', nameField: 'name' },
      class_declaration: { kind: 'class', nameField: 'name' },
      method_definition: { kind: 'method', nameField: 'name' },
      interface_declaration: { kind: 'interface', nameField: 'name' },
      type_alias_declaration: { kind: 'type', nameField: 'name' },
      enum_declaration: { kind: 'enum', nameField: 'name' },
      // `lexical_declaration` has NO `name` field: the name sits on each
      // `variable_declarator` child. Matching the declarator is what makes
      // `export const f = () => {}` a symbol at all.
      variable_declarator: { kind: 'variable', nameField: 'name' },
      // Class fields holding arrow functions (`onClick = () => {}`). The TS
      // grammar names this `public_field_definition`; `field_definition` is not
      // a node it produces.
      public_field_definition: { kind: 'variable', nameField: 'name' },
    },
    scopes: ['class_body', 'object', 'statement_block'],
    call: { type: 'call_expression', field: 'function' },
    import: { type: 'import_statement', field: 'source' },
  }
}

/**
 * The JavaScript shape.
 *
 * TypeScript-only declarations are absent on purpose: the JS grammar has no
 * `interface_declaration`, `type_alias_declaration` or `enum_declaration`, so a
 * row for them would never fire. `public_field_definition` is likewise TS-only;
 * JS class fields arrive as `field_definition` in this grammar.
 */
function javascriptShape(): GrammarShape {
  return {
    declarations: {
      function_declaration: { kind: 'function', nameField: 'name' },
      class_declaration: { kind: 'class', nameField: 'name' },
      method_definition: { kind: 'method', nameField: 'name' },
      variable_declarator: { kind: 'variable', nameField: 'name' },
      field_definition: { kind: 'variable', nameField: 'property' },
    },
    scopes: ['class_body', 'object', 'statement_block'],
    call: { type: 'call_expression', field: 'function' },
    import: { type: 'import_statement', field: 'source' },
  }
}

/** The C/C++ shape, shared by both ids. */
function cppShape(): GrammarShape {
  return {
    declarations: {
      function_definition: { kind: 'function', nameField: 'declarator' },
      class_specifier: { kind: 'class', nameField: 'name' },
      struct_specifier: { kind: 'struct', nameField: 'name' },
      enum_specifier: { kind: 'enum', nameField: 'name' },
    },
    scopes: ['block', 'field_declaration_list'],
    call: { type: 'call_expression', field: 'function' },
    import: { type: 'preproc_include', field: 'path' },
  }
}

/**
 * The minimal tree-sitter node surface this module reads.
 *
 * Declared structurally rather than imported from `web-tree-sitter` so a test
 * can drive {@link extractSymbols} with plain objects — the extraction rules are
 * what needs testing, and building a real parse for every case would test the
 * grammar instead.
 */
export interface SyntaxNode {
  readonly type: string
  readonly text: string
  readonly startPosition: { readonly row: number }
  readonly namedChildren: readonly SyntaxNode[]
  childForFieldName(name: string): SyntaxNode | null
}

/** What one file parsed to. */
export interface ParsedFile {
  readonly symbols: readonly SymbolRecord[]
  /** Call targets by name, with the line they were called from. */
  readonly calls: readonly { readonly name: string, readonly line: number }[]
  /** Import specifiers, verbatim (resolution happens against the project). */
  readonly imports: readonly { readonly specifier: string, readonly line: number }[]
  /** True when the parser produced an ERROR node — the file is partly unread. */
  readonly hasError: boolean
  /**
   * True when this language has a grammar but no extraction shape, so nothing
   * was read. Distinct from "this file declares nothing": a tool must be able to
   * say `LANGUAGE_UNSUPPORTED` rather than report an empty file as fact.
   */
  readonly unsupported: boolean
}

/** The symbol id for a declaration. Never includes a line number. */
export function symbolId(path: string, kind: SymbolKind, name: string, parent: string | undefined): string {
  return parent === undefined
    ? `${path}#${kind}:${name}`
    : `${path}#${kind}:${parent}.${name}`
}

/**
 * The name a declarator declares.
 *
 * C-family declarators nest: `*foo(int x)` is a `function_declarator` whose
 * `declarator` field is a `pointer_declarator` whose own `declarator` is the
 * identifier `foo`. The `declarator` FIELD is the path to the name; the other
 * children are what the declaration takes (a parameter list, an array size) and
 * must not be searched — reading them yields a parameter name, which is how
 * `int add(int a, int b)` once produced `b`.
 */
function leafName(node: SyntaxNode): string {
  // Every grammar spells an identifier slightly differently: TS uses
  // `property_identifier` for a member name and a class field, Go uses
  // `field_identifier`, C uses `identifier`. A list that omits one of them makes
  // `this.helper()` resolve to nothing — measured as every member call in this
  // repository producing no edge.
  if (node.type === 'identifier'
    || node.type === 'type_identifier'
    || node.type === 'field_identifier'
    || node.type === 'property_identifier'
    || node.type === 'name') return node.text
  const declarator = node.childForFieldName('declarator')
  if (declarator !== null) return leafName(declarator)
  // A plain type node (a `struct_specifier`'s name) is the name itself.
  const name = node.childForFieldName('name')
  if (name !== null) return name.text
  return ''
}

/**
 * The name a CALLEE expression resolves to, for a call edge.
 *
 * A callee is not a declarator, so it needs its own rule. `helper()` is an
 * identifier; `this.helper()` and `obj.method()` are member expressions whose
 * name is the `property`; `pkg.Func()` in Go is a selector whose name is the
 * `field`. Without those two branches only bare calls produced edges — measured
 * as every `this.foo()` in this repository going uncounted, which makes
 * `codegraph_impact` answer "no callers" for almost everything.
 *
 * The OBJECT is deliberately dropped: `a.save()` and `b.save()` both resolve to
 * the name `save`, and the name is all this graph resolves on. That is the
 * syntax-only trade, stated in the module header.
 *
 * @param node - the callee expression.
 * @returns the name to resolve, or '' when the callee has no name (an
 *   immediately-invoked arrow, a computed index).
 */
function calleeName(node: SyntaxNode): string {
  const direct = leafName(node)
  if (direct !== '') return direct
  // `a.b()` / `this.foo()` (TS/JS), `pkg.Func()` (Go), `obj?.m()`.
  for (const field of ['property', 'field']) {
    const member = node.childForFieldName(field)
    if (member !== null) return leafName(member)
  }
  // `new Thing()` counts as a reference to Thing.
  const constructor = node.childForFieldName('constructor')
  if (constructor !== null) return leafName(constructor)
  return ''
}

/**
 * Extract one file's symbols and call sites.
 *
 * @param root - the parse tree's root node.
 * @param path - the project-relative path, for the symbol ids.
 * @param language - the language id, selecting the shape.
 * @returns what the file declares and calls.
 */
export function extractSymbols(root: SyntaxNode, path: string, language: string): ParsedFile {
  // `hasOwn` rather than a bare index: `node.type` is grammar-controlled text,
  // and a name like `constructor` would otherwise hit `Object.prototype`.
  const shape = Object.hasOwn(GRAMMAR_SHAPES, language) ? GRAMMAR_SHAPES[language] : undefined
  if (shape === undefined) {
    return { symbols: [], calls: [], imports: [], hasError: hasErrorNode(root), unsupported: true }
  }

  const symbols: SymbolRecord[] = []
  const calls: { name: string, line: number }[] = []
  const imports: { specifier: string, line: number }[] = []
  // Same-file collisions of (kind, parent, name) — overloads, and a method and a
  // field of one name. The id is the symbols table's PRIMARY KEY, so a duplicate
  // would fail the whole file's write; an ordinal keeps both rows addressable.
  const used = new Map<string, number>()

  /**
   * Walk one node, tracking the enclosing declaration's name so a method's id
   * carries its class. A declaration's own body is walked with the declaration
   * as parent; everything else keeps the parent it had.
   */
  const walk = (node: SyntaxNode, parent: string | undefined): void => {
    const declaration = Object.hasOwn(shape.declarations, node.type) ? shape.declarations[node.type] : undefined
    if (declaration !== undefined) {
      const nameNode = node.childForFieldName(declaration.nameField)
      const rawName = nameNode === null
        ? ''
        : (declaration.nameField === 'declarator' ? leafName(nameNode) : nameNode.text)
      const name = rawName.trim()
      // A destructuring pattern's text is not a name (`{a, b}`); only an
      // identifier-shaped name becomes a symbol.
      if (name !== '' && !/[{}\[\],]/u.test(name)) {
        const base = symbolId(path, declaration.kind, name, parent)
        const seen = used.get(base) ?? 0
        used.set(base, seen + 1)
        symbols.push({
          id: seen === 0 ? base : `${base}#${String(seen)}`,
          path,
          name,
          kind: declaration.kind,
          line: node.startPosition.row + 1,
          parent,
        })
        // A declaration's own body belongs to it.
        for (const child of node.namedChildren) walk(child, name)
        return
      }
    }
    if (shape.call !== undefined && node.type === shape.call.type) {
      const callee = node.childForFieldName(shape.call.field)
      if (callee !== null) {
        const name = calleeName(callee)
        if (name !== '') calls.push({ name, line: node.startPosition.row + 1 })
      }
    }
    if (shape.import !== undefined && node.type === shape.import.type) {
      // An empty `field` means the grammar names the target as a CHILD node
      // rather than through a field (Java's `import_declaration`); fall back to
      // the first child that carries a name-shaped text.
      const target = shape.import.field === ''
        ? firstNamedChild(node)
        : node.childForFieldName(shape.import.field)
      if (target !== null) imports.push({ specifier: target.text.replace(/^['"]|['"]$/gu, ''), line: node.startPosition.row + 1 })
    }
    for (const child of node.namedChildren) walk(child, parent)
  }

  walk(root, undefined)
  return { symbols, calls, imports, hasError: hasErrorNode(root), unsupported: false }
}

/** The first named child, for a grammar that names a target as a child, not a field. */
function firstNamedChild(node: SyntaxNode): SyntaxNode | null {
  return node.namedChildren[0] ?? null
}

/** Whether any node in the tree is an ERROR node. */
function hasErrorNode(node: SyntaxNode): boolean {
  if (node.type === 'ERROR') return true
  for (const child of node.namedChildren) if (hasErrorNode(child)) return true
  return false
}

/**
 * Turn a file's calls into edges, resolving each name against the project.
 *
 * Resolution is by NAME across the whole project, and only when the name is
 * unambiguous. See the module header for why an ambiguous name is dropped rather
 * than guessed.
 *
 * A self-recursive call keeps its edge: it is a real reference, and "this
 * function calls itself" is honest information for a reader.
 *
 * @param parsed - the file's parse result.
 * @param callerId - the id of the symbol (or file node) that owns the calls.
 * @param resolve - name → the ids that declare it, project-wide.
 * @returns the reference edges.
 */
export function callEdges(
  parsed: ParsedFile,
  callerId: string,
  resolve: (name: string) => readonly string[],
): EdgeRecord[] {
  const edges: EdgeRecord[] = []
  for (const call of parsed.calls) {
    const targets = resolve(call.name)
    // Zero matches: the callee is outside this project or in an unparsed
    // language. Several matches: the name is ambiguous without types. Both are
    // "no edge", which under-reports rather than lying.
    if (targets.length !== 1) continue
    edges.push({ from: callerId, to: targets[0]!, kind: 'references', line: call.line })
  }
  return edges
}
