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
  /**
   * Node type → the symbol it declares.
   *
   * `nameField` is the node FIELD carrying the name. Some grammars do not name it
   * as a field at all — PowerShell's `function_statement` carries the name as a
   * `function_name` CHILD with no field — so `nameChild` names a child TYPE to
   * fall back to. Exactly one of the two is required; a row with neither would
   * silently never produce a symbol, which the per-declaration suite catches.
   */
  readonly declarations: Readonly<Record<string, { kind: SymbolKind, nameField?: string, nameChild?: string }>>
  /** Node types that wrap a body whose declarations belong to the enclosing symbol. */
  readonly scopes: readonly string[]
  /** Node type used for a call, and the field naming the callee. */
  readonly call: { readonly type: string, readonly field: string } | undefined
  /** Node type used for an import statement, and the field naming the target. */
  readonly import: { readonly type: string, readonly field: string } | undefined
  /**
   * The heritage clause node types, one per relationship.
   *
   * `extends` and `implements` are different questions — "what is this derived
   * from" versus "what contract does this promise" — and collapsing them loses the
   * one a reader asks about an interface. Measured before this existed: the graph
   * answered "who references this interface" with only the places that NAME it,
   * never the classes that implement it.
   */
  readonly heritage?: { readonly extends?: string, readonly implements?: string }
  /**
   * Node types that carry a TYPE reference, and the child type holding the name.
   *
   * A signature is not a call: `function f(x: Foo)` never calls `Foo`, so no call
   * edge exists, yet changing `Foo` breaks `f`. Without this edge, `impact` on a
   * type reports only the code that constructs it.
   */
  readonly typeRef?: readonly string[]
  /**
   * How an export names what it exports, when the grammar distinguishes it.
   *
   * A module's public surface is what other packages may depend on, and it is not
   * derivable from references: an exported symbol with no internal callers is still
   * the API. `all` marks `export * from './x'`, which re-exports another module's
   * whole surface.
   */
  readonly exportSurface?: { readonly statement: string, readonly specifier?: string }
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
  // Node names below were read off a REAL parse of a sample file with this
  // plugin's own grammar (`scratch/codegraph-grammars/probe.cjs`), not from
  // memory: a name the grammar does not produce fails silently, producing a
  // symbol table that looks empty for a language that works. Rust's `impl_item`
  // is deliberately absent — it declares no name of its own, and the methods
  // inside it are matched by `function_item` under the `declaration_list` scope.
  rust: {
    declarations: {
      function_item: { kind: 'function', nameField: 'name' },
      struct_item: { kind: 'struct', nameField: 'name' },
      enum_item: { kind: 'enum', nameField: 'name' },
      trait_item: { kind: 'interface', nameField: 'name' },
      // A trait's method SIGNATURE (no body) is its own node; an impl's method is
      // a `function_item`. Both must be declared or a trait's surface is missing.
      function_signature_item: { kind: 'method', nameField: 'name' },
      field_declaration: { kind: 'variable', nameField: 'name' },
    },
    scopes: ['declaration_list', 'block', 'impl_item'],
    call: { type: 'call_expression', field: 'function' },
    // `use_declaration` names its target through a scoped identifier, not a field.
    import: { type: 'use_declaration', field: '' },
  },
  ruby: {
    declarations: {
      method: { kind: 'method', nameField: 'name' },
      singleton_method: { kind: 'method', nameField: 'name' },
      class: { kind: 'class', nameField: 'name' },
      module: { kind: 'module', nameField: 'name' },
    },
    scopes: ['body_statement', 'block'],
    call: { type: 'call', field: 'method' },
    import: undefined,
  },
  php: {
    declarations: {
      function_definition: { kind: 'function', nameField: 'name' },
      method_declaration: { kind: 'method', nameField: 'name' },
      class_declaration: { kind: 'class', nameField: 'name' },
      interface_declaration: { kind: 'interface', nameField: 'name' },
      trait_declaration: { kind: 'class', nameField: 'name' },
    },
    scopes: ['declaration_list', 'compound_statement'],
    call: { type: 'function_call_expression', field: 'function' },
    // `namespace_use_declaration` has no field; the name is a child.
    import: { type: 'namespace_use_declaration', field: '' },
  },
  bash: {
    declarations: {
      // A shell function is the only declaration the language has: no classes, no
      // types, and a variable is a runtime name rather than a code structure.
      function_definition: { kind: 'function', nameField: 'name' },
    },
    scopes: ['compound_statement', 'function_definition'],
    call: { type: 'command', field: 'name' },
    import: undefined,
  },
  // PowerShell: the grammar is in the same package, and it is one of the few
  // "not a mainstream compiled language" ids a Windows project actually uses.
  //
  // Neither declaration names its name as a FIELD — measured against the real
  // grammar: `function_statement` carries a `function_name` CHILD and
  // `class_statement` a `simple_name` child — which is why the shape grew
  // `nameChild`. A `nameField: 'name'` here would have produced an empty symbol
  // list and looked like a language this plugin does not support.
  powershell: {
    declarations: {
      function_statement: { kind: 'function', nameChild: 'function_name' },
      class_statement: { kind: 'class', nameChild: 'simple_name' },
    },
    scopes: ['script_block', 'script_block_body', 'statement_list'],
    call: { type: 'command', field: 'command_name' },
    import: undefined,
  },
  // CSS, INI and regex are DOWNLOADABLE and PARSEABLE but carry no extraction
  // shape on purpose. Their "declarations" are a selector, a config key and a
  // regular-expression fragment: none names a thing a caller can reference, so an
  // edge to one would be a graph entry no one can act on. The settings page
  // reports them as "No extraction rules" instead of promising a symbol table,
  // which is the same honesty `LANGUAGE_UNSUPPORTED` gives an uninstalled grammar.
  css: { declarations: {}, scopes: [], call: undefined, import: undefined },
  ini: { declarations: {}, scopes: [], call: undefined, import: undefined },
  regex: { declarations: {}, scopes: [], call: undefined, import: undefined },
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
    heritage: { extends: 'extends_clause', implements: 'implements_clause' },
    typeRef: ['type_annotation'],
    exportSurface: { statement: 'export_statement', specifier: 'export_specifier' },
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
 * The languages this plugin can actually READ.
 *
 * Derived from the extraction table rather than kept beside it. `routes.ts` used
 * to carry its own copy so a route would not pull the parser into the request
 * path, and that copy is exactly the kind of second truth that drifts: a
 * language added to one table and not the other would make the settings page say
 * "no extraction rules" for a language that works, or promise one that parses to
 * nothing — and neither failure is red. Importing this module costs a table and
 * a few pure functions; it does not load tree-sitter.
 *
 * Having an ENTRY is not the test — `declarations` being non-empty is. CSS, INI
 * and regex appear in `GRAMMAR_SHAPES` with an empty declaration map on purpose
 * (rated below), and a plain `Object.keys` would have advertised them as
 * indexable while every file of theirs produced an empty symbol table.
 */
export const SUPPORTED_LANGUAGE_IDS: readonly string[] = Object.entries(GRAMMAR_SHAPES)
  .filter(([, shape]) => Object.keys(shape.declarations).length > 0)
  .map(([id]) => id)

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
  /**
   * Call targets by name, with the line they were called from and the symbol that
   * contains the call.
   *
   * `owner` is the enclosing declaration's node id, or undefined for a call made
   * at file scope. It is what lets an edge say "this FUNCTION calls X" rather
   * than "this file does".
   */
  readonly calls: readonly { readonly name: string, readonly line: number, readonly owner: string | undefined }[]
  /** Import specifiers, verbatim (resolution happens against the project). */
  readonly imports: readonly { readonly specifier: string, readonly line: number }[]
  /**
   * Heritage relationships: a class or interface and what it derives from.
   *
   * `extends` and `implements` are kept apart because they answer different
   * questions — "what is this built on" versus "what contract does this satisfy" —
   * and a reader asking about an interface means the second. Neither is a call, so
   * without this the graph has nothing to say about a type hierarchy at all.
   */
  readonly heritage: readonly {
    readonly from: string
    readonly name: string
    readonly line: number
    readonly kind: 'extends' | 'implements'
  }[]
  /**
   * Type references a declaration carries in its signature or annotations.
   *
   * `function f(x: Foo)` never calls `Foo`, so no call edge exists, yet changing
   * `Foo` breaks `f`. Without these, `impact` on a type reports only the code that
   * constructs it — a fraction of what actually depends on it.
   */
  readonly typeRefs: readonly { readonly name: string, readonly line: number, readonly owner: string | undefined }[]
  /**
   * What this module makes public.
   *
   * Not derivable from references: an exported symbol with no internal caller is
   * still the API. `all` marks `export * from './x'`, which republishes another
   * module's whole surface.
   */
  readonly exports: readonly {
    readonly name: string
    readonly line: number
    readonly all: boolean
    /**
     * The `from` specifier, when the export names another module.
     *
     * The author's own statement of WHERE the name comes from, which is the most
     * precise resolution signal available — stronger than a project-wide name match.
     * Measured before this existed: one `export { contentText } from './utils/text.ts'`
     * linked four unrelated `contentText` declarations from files it never mentioned.
     */
    readonly from: string | undefined
  }[]
  /** True when the parser produced an ERROR node — the file is partly unread. */
  readonly hasError: boolean
  /**
   * True when nothing was read from this file, because the language cannot be
   * read at all right now.
   *
   * Two causes, and they are reported apart because they ask the user for
   * different things: `missing` means the grammar is not installed (download it),
   * `noShape` means it is installed and this plugin has no rules for it (nothing
   * to download). Collapsing them into one count told users "N files skipped
   * because their language is not installed" for a project whose only gap was a
   * `.css` file — measured on this machine, where every skipped file was a
   * language that IS installed.
   */
  readonly unsupported: false | 'missing' | 'noShape'
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

/** Type names that never resolve to a project declaration. */
const SKIP_TYPE_NAMES = new Set([
  'any', 'unknown', 'never', 'void', 'string', 'number', 'boolean', 'object',
  'symbol', 'bigint', 'null', 'undefined', 'this', 'true', 'false',
  'Array', 'Promise', 'Map', 'Set', 'Record', 'Partial', 'Readonly',
])

/**
 * Every descendant of one node type.
 *
 * `SyntaxNode.descendantsOfType` is not on the type this plugin compiles against, so
 * the walk is explicit. Depth-first and in source order, which is what an export
 * clause's names should keep.
 *
 * @param node - the subtree root.
 * @param type - the node type to collect.
 * @returns the matching descendants, in source order.
 */
function collectByType(node: SyntaxNode, type: string): SyntaxNode[] {
  const found: SyntaxNode[] = []
  const visit = (current: SyntaxNode): void => {
    for (const child of current.namedChildren) {
      if (child.type === type) found.push(child)
      visit(child)
    }
  }
  visit(node)
  return found
}

/**
 * The declaration name a type node refers to, or '' when it names none.
 *
 * `SomeType`, `Foo.Bar`, `Array<Item>` and `readonly Foo[]` all mention a name; only
 * the LAST part of a qualified path and the inner name of a generic are declarations
 * a reader can act on. Builtin keywords (`string`, `number`, `void`) are excluded:
 * they resolve to nothing in the symbol table, so an edge for them is pure noise.
 *
 * @param node - a node inside a heritage clause or a type annotation.
 * @returns the type's name, or '' when this node carries none.
 */
function typeNameOf(node: SyntaxNode): string {
  if (SKIP_TYPE_NAMES.has(node.type)) return ''
  if (node.type === 'type_identifier' || node.type === 'identifier' || node.type === 'nested_type_identifier') {
    const text = node.text.trim()
    if (text === '') return ''
    // `Foo.Bar` names Bar.
    const last = text.includes('.') ? text.slice(text.lastIndexOf('.') + 1) : text
    return SKIP_TYPE_NAMES.has(last) ? '' : last
  }
  // `generic_type` / `array_type` / `union_type` / `type_arguments`: the names are
  // deeper. Recursing keeps `Array<Item>` pointing at Item and not at Array.
  for (const child of node.namedChildren) {
    const name = typeNameOf(child)
    if (name !== '') return name
  }
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
  // An entry with an EMPTY declaration map is the same answer as no entry: CSS,
  // INI and regex appear in the table so the settings page can rate them, and
  // `declarations: {}` means "parses, declares nothing addressable". Reading only
  // `shape === undefined` here reported those three as SUPPORTED while producing
  // an empty symbol table — the exact "installed but useless" claim this plugin
  // refuses to make.
  if (shape === undefined || Object.keys(shape.declarations).length === 0) {
    return { symbols: [], calls: [], imports: [], heritage: [], typeRefs: [], exports: [], hasError: hasErrorNode(root), unsupported: 'noShape' }
  }

  const symbols: SymbolRecord[] = []
  /**
   * A call site, with the declaration that CONTAINS it.
   *
   * `owner` is the enclosing symbol's node id, or undefined at file scope (a
   * top-level statement, a module initialiser). Without it every call edge
   * started at `file:<path>`, so `codegraph_context` could answer "what does this
   * file call" but never "what does this function call" — the question the tool
   * is actually asked.
   */
  const calls: { name: string, line: number, owner: string | undefined }[] = []
  const imports: { specifier: string, line: number }[] = []
  const heritage: { from: string, name: string, line: number, kind: 'extends' | 'implements' }[] = []
  const typeRefs: { name: string, line: number, owner: string | undefined }[] = []
  const exports: { name: string, line: number, all: boolean, from: string | undefined }[] = []
  // Same-file collisions of (kind, parent, name) — overloads, and a method and a
  // field of one name. The id is the symbols table's PRIMARY KEY, so a duplicate
  // would fail the whole file's write; an ordinal keeps both rows addressable.
  const used = new Map<string, number>()

  /**
   * Walk one node, tracking the enclosing declaration's name so a method's id
   * carries its class. A declaration's own body is walked with the declaration
   * as parent; everything else keeps the parent it had.
   *
   * `ownerId` is the ID of the enclosing symbol, which is what a call edge needs:
   * a call inside `alpha` belongs to `alpha`, not to the file. It is carried
   * separately from `parent` because `parent` is only the NAME (needed for the
   * next symbol's id) whereas the edge needs the full id, overload ordinal
   * included — two overloads of one name are two different callers.
   */
  const walk = (node: SyntaxNode, parent: string | undefined, ownerId: string | undefined): void => {
    const declaration = Object.hasOwn(shape.declarations, node.type) ? shape.declarations[node.type] : undefined
    if (declaration !== undefined) {
      // A named field first; otherwise the first child of the declared TYPE, which
      // is how PowerShell's `function_statement` (child `function_name`, no
      // field) is read.
      const fieldNode = declaration.nameField === undefined
        ? null
        : node.childForFieldName(declaration.nameField)
      const nameNode = fieldNode ?? (
        declaration.nameChild === undefined
          ? null
          : node.namedChildren.find(child => child.type === declaration.nameChild) ?? null
      )
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
        const id = seen === 0 ? base : `${base}#${String(seen)}`
        symbols.push({
          id,
          path,
          name,
          kind: declaration.kind,
          line: node.startPosition.row + 1,
          parent,
        })
        // A declaration's own body belongs to it.
        for (const child of node.namedChildren) walk(child, name, id)
        return
      }
    }
    if (shape.call !== undefined && node.type === shape.call.type) {
      const callee = node.childForFieldName(shape.call.field)
      if (callee !== null) {
        const name = calleeName(callee)
        if (name !== '') calls.push({ name, line: node.startPosition.row + 1, owner: ownerId })
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
    // Heritage: `class A extends B implements C`. Both sides are TYPE names, and
    // neither is a call, so the call branch can never see them.
    if (shape.heritage !== undefined) {
      const isExtends = shape.heritage.extends !== undefined && node.type === shape.heritage.extends
      const isImplements = shape.heritage.implements !== undefined && node.type === shape.heritage.implements
      if ((isExtends || isImplements) && ownerId !== undefined) {
        for (const child of node.namedChildren) {
          // `extends Foo<T>` wraps the name in `generic_type`; the identifier is the
          // part that names a declaration, so every named child is read as a name.
          const name = typeNameOf(child)
          if (name !== '') heritage.push({ from: ownerId, name, line: node.startPosition.row + 1, kind: isExtends ? 'extends' : 'implements' })
        }
      }
    }
    // A type reference in a signature or a field: `function f(x: Foo)`.
    if (shape.typeRef !== undefined && shape.typeRef.includes(node.type)) {
      for (const child of node.namedChildren) {
        const name = typeNameOf(child)
        if (name !== '') typeRefs.push({ name, line: node.startPosition.row + 1, owner: ownerId })
      }
    }
    // What this module publishes. `export * from './x'` has no name of its own, so
    // it is recorded as an `all` row carrying the source specifier instead.
    if (shape.exportSurface !== undefined && node.type === shape.exportSurface.statement) {
      const line = node.startPosition.row + 1
      const wanted = shape.exportSurface.specifier
      const specifiers = wanted === undefined ? [] : collectByType(node, wanted)
      // The `from` specifier, when there is one: `export { x } from './y'`. This is
      // the author's own statement of where the name comes from, and the strongest
      // resolution signal the parse has.
      const fromSpecifier = node.childForFieldName('source')?.text.replace(/^['"]|['"]$/gu, '') ?? undefined
      if (specifiers.length > 0) {
        for (const specifier of specifiers) {
          const name = specifier.childForFieldName('name')?.text ?? specifier.namedChildren[0]?.text ?? ''
          if (name !== '') exports.push({ name: name.trim(), line, all: false, from: fromSpecifier })
        }
      } else if (/\bexport\s*\*/u.test(node.text)) {
        const source = fromSpecifier ?? ''
        if (source !== '') exports.push({ name: source, line, all: true, from: source })
      } else {
        // `export const x`, `export function f` — the declaration inside carries the
        // name; this row records that the module publishes it. `export const` wraps
        // a `lexical_declaration`, whose own name sits one level deeper on the
        // `variable_declarator`, so the search is recursive rather than one level.
        const declarators = collectByType(node, 'variable_declarator')
        const own = node.namedChildren.find(child => child.childForFieldName('name') !== null)
        const name = own?.childForFieldName('name')?.text
          ?? declarators[0]?.childForFieldName('name')?.text
          ?? ''
        if (name !== '') exports.push({ name: name.trim(), line, all: false, from: fromSpecifier })
      }
    }
    for (const child of node.namedChildren) walk(child, parent, ownerId)
  }

  walk(root, undefined, undefined)
  return {
    symbols,
    calls,
    imports,
    heritage,
    typeRefs,
    exports,
    hasError: hasErrorNode(root),
    unsupported: false,
  }
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
/**
 * How many declarations a shared name may have before it stops linking.
 *
 * A name shared by two declarations is a real ambiguity worth linking to both: the
 * reader picks. A name shared by 1325 of them is not a name, it is a local variable
 * convention — measured on a real project, `variable:result` alone produced 200,000+
 * edges because every `const result` in the codebase became a target of every
 * `result.something()` call. That is noise wearing the costume of coverage.
 *
 * Ten is where a reader can still discard the wrong rows by eye. Past that, the link
 * says nothing and only costs time: an index pass went from 17.9s to 124.6s when
 * every shared name expanded without a bound.
 */
const MAX_SHARED_TARGETS = 10

/**
 * The declarations one call or type reference should link to.
 *
 * Three layers, most precise first. Measured on a real project, the layers matter
 * unevenly — but the middle one is nearly free and prevents the shape that cost the
 * most in this plugin's history:
 *
 *   1. **Declared in the same file.** A module-private name can only mean the local
 *      declaration; a file-local match is exact, not a guess. `streamWithDeltas` was
 *      declared in production code and in a test harness, and the project-wide
 *      uniqueness rule dropped all thirteen call sites — the local declaration was
 *      right there.
 *   2. **Declared in a file this one imports.** `see base.ts` is the author stating
 *      which declaration they mean, so a match inside an imported file beats a global
 *      count. Not implemented yet: it needs the names an import clause carries, which
 *      the parse does not record, and measured on a real project the heritage targets
 *      that fan out are already type-distinct (`type Container` versus
 *      `class Container`). Recorded here as the next layer rather than pretended.
 *   3. **Unique project-wide**, or few enough to list.
 *
 * @param targets - every declaration carrying the name.
 * @param sameFile - the declarations of those that live in the referring file.
 * @returns the ones worth an edge.
 */
function linkTargets(targets: readonly string[], sameFile: readonly string[] = []): readonly string[] {
  if (targets.length === 0) return []
  if (targets.length === 1) return targets
  // Layer 1: a local declaration is exact. This is what the project-wide rule threw
  // away, and it is the common shape — a private helper beside a same-named export.
  if (sameFile.length > 0) return sameFile.slice(0, MAX_SHARED_TARGETS)
  // Too common: `resolve` found a name the codebase reuses for locals. Linking to
  // all of them buries the real callers, and linking to one would be a guess.
  if (targets.length > MAX_SHARED_TARGETS) return []
  return targets
}

/**
 * The heritage and type-reference edges for one file.
 *
 * Three relationships the call walk cannot produce, each answering a question the
 * graph could not answer before:
 *
 *   - `extends`    — "what is this built on". The class hierarchy.
 *   - `implements` — "what contract does this satisfy". Separate from `extends`
 *     because a reader asking about an interface means this one, and merging them
 *     would answer with the wrong set.
 *   - `type_refs`  — a signature's dependency. `function f(x: Foo)` never calls
 *     `Foo`; without this edge, `impact` on a type reports only the code that
 *     constructs it, which is a fraction of what actually breaks.
 *
 * Targets resolve by NAME through the same rule the call walk uses, so a type
 * declared in several places links to each of them — and inherits the same ceiling,
 * because a name shared by a thousand declarations identifies nothing.
 *
 * @param parsed - one file's parse.
 * @param fileId - the file's node id, for a reference at file scope.
 * @param resolve - name → the declaration ids carrying it.
 * @returns the edges, ready to insert.
 */
export function relationEdges(
  parsed: ParsedFile,
  fileId: string,
  resolve: (name: string) => readonly string[],
  /**
   * Turns a relative specifier into the project-relative path the graph keys files by.
   *
   * Without it a star re-export's target was stored VERBATIM, so a package's
   * `index.ts` pointed at a `./`-relative node while the graph's file nodes are
   * project-relative — measured, all 46 star edges failed to join and were
   * decoration. The same resolver `imports` already uses is the answer; a re-export
   * and an import name a path in exactly the same way.
   */
  resolveModule?: (specifier: string) => string | undefined,
): EdgeRecord[] {
  const edges: EdgeRecord[] = []
  // A module-private type can only mean itself, so a local declaration is exact and
  // outranks any project-wide count — the same first layer `callEdges` applies.
  const local = new Map<string, string[]>()
  for (const symbol of parsed.symbols) {
    const list = local.get(symbol.name)
    if (list === undefined) local.set(symbol.name, [symbol.id])
    else list.push(symbol.id)
  }
  const add = (from: string, name: string, kind: 'extends' | 'implements' | 'type_refs', line: number): void => {
    for (const target of linkTargets(resolve(name), local.get(name) ?? [])) edges.push({ from, to: target, kind, line })
  }
  for (const relation of parsed.heritage) add(relation.from, relation.name, relation.kind, relation.line)
  // ONE edge per (declaration, type), at its first line.
  //
  // A type annotation is not a call site: `function f(a: Foo, b: Foo)` mentions Foo
  // twice and says nothing a reader acts on twice. Measured on a real project the
  // duplication is 8.3% (25,561 edges collapse to 23,428) — smaller than expected,
  // so this is a tidiness rule rather than the volume problem it was proposed as.
  // The distinction that matters: `references` keeps every call site because each one
  // is a place to read, while `type_refs` answers "does this signature depend on
  // this type" — a set question, not a line question.
  const seenTypeRefs = new Set<string>()
  for (const reference of parsed.typeRefs) {
    const from = reference.owner ?? fileId
    const key = `${from}\u0000${reference.name}`
    if (seenTypeRefs.has(key)) continue
    seenTypeRefs.add(key)
    add(from, reference.name, 'type_refs', reference.line)
  }
  // The public surface: file → symbol. `all` rows name a MODULE rather than a
  // declaration (`export * from './x'`), so they resolve against file nodes instead;
  // they still say "this file republishes that one's surface", which is what makes
  // "what does this package expose" answerable across a re-export chain.
  for (const entry of parsed.exports) {
    const fromFile = entry.from === undefined ? undefined : resolveModule?.(entry.from)
    if (entry.all) {
      // A re-export names a PATH. Storing it verbatim was the defect: the node is
      // project-relative, the specifier is not, and the edge joined to nothing.
      if (fromFile !== undefined) edges.push({ from: fileId, to: `file:${fromFile}`, kind: 'exports', line: entry.line })
      continue
    }
    // A named re-export (`export { x } from '../y'`) means a declaration IN THAT
    // FILE. Resolving it against the whole project was a real false-positive source:
    // measured, one `export { contentText }` linked four unrelated `contentText`
    // declarations from files it never mentioned.
    if (fromFile !== undefined) {
      // Narrow to the named module when the parse knows it; the join is exact.
      for (const target of linkTargets(resolve(entry.name).filter(id => id.startsWith(`${fromFile}#`)))) {
        edges.push({ from: fileId, to: target, kind: 'exports', line: entry.line })
      }
      continue
    }
    // A plain `export const x` / `export function f`: the declaration is this file's.
    for (const target of local.get(entry.name) ?? []) {
      edges.push({ from: fileId, to: target, kind: 'exports', line: entry.line })
    }
  }
  return edges
}

export function callEdges(
  parsed: ParsedFile,
  callerId: string,
  resolve: (name: string) => readonly string[],
): EdgeRecord[] {
  const edges: EdgeRecord[] = []
  // The ids this file declares, by name. A module-private declaration can only mean
  // itself, so a local match is exact and outranks any project-wide count.
  const local = new Map<string, string[]>()
  for (const symbol of parsed.symbols) {
    const list = local.get(symbol.name)
    if (list === undefined) local.set(symbol.name, [symbol.id])
    else list.push(symbol.id)
  }
  for (const call of parsed.calls) {
    const targets = linkTargets(resolve(call.name), local.get(call.name) ?? [])
    // Zero targets means one of two things, and neither can produce an edge: the
    // callee is outside this project, or its name is shared so widely that every
    // declaration of it would be noise.
    if (targets.length === 0) continue
    // SEVERAL targets: the name is declared more than once, by a handful.
    //
    // This used to be dropped as "ambiguous", and that was the single worst defect
    // in this plugin. Measured on a real project: 53.2% of all reference edges hung
    // off file nodes rather than symbols, and `streamWithDeltas` — declared once in
    // production code and once in a test harness — had thirteen real call sites and
    // ZERO edges. `codegraph_impact` answered `referencing: []`, which reads exactly
    // like "nobody calls this". A module that under-reports callers is worse than one
    // that over-reports them: the reader can discard a wrong row, but cannot know
    // about a missing one.
    //
    // So a shared name links to every declaration of it (up to `MAX_SHARED_TARGETS`).
    // Picking one would be a guess dressed as an answer; linking to all of them is a
    // fact — "this name is used here, and these are the declarations it could mean" —
    // which is what `codegraph_impact`'s candidates list exists to disambiguate.
    for (const target of targets) {
      // The edge starts at the enclosing DECLARATION when the call is inside one,
      // and at the file otherwise. This is what makes "what does this function
      // call" a question the graph can answer: attributing every call to the file
      // made `codegraph_context.calls` report the whole file's calls for every
      // symbol in it.
      //
      // Both kinds of edge carry kind `references`, and they are told apart by
      // their source: `file:<path>` is a file-level call (a top-level statement or
      // a module initialiser), a symbol id is a call made inside that symbol. A
      // separate kind would have meant every existing `references` query needing
      // to know about it, and `impact` genuinely wants both.
      edges.push({ from: call.owner ?? callerId, to: target, kind: 'references', line: call.line })
    }
  }
  return edges
}
