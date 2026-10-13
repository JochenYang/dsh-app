/**
 * Field-drift scanner: which keys of a catalog DOCUMENT does the plugin actually
 * read, across the whole `src/` tree?
 *
 * Why an AST and not a text match. The published contract
 * (`docs/catalog-source.schema.json` + `docs/catalog-source.md`) claims that
 * every field the parser reads appears in the schema. Proving that with
 * `record\.(\w+)` regular expressions over `catalog.ts` is not proof: the same
 * read wears at least five other spellings, and a scan fixed to one file and a
 * hand-written function list never sees the second file that reads the same
 * document. Both gaps were measured, not imagined — a helper
 * (`revokedOf(record) { return record.revoked === true }`), an optional chain,
 * an index access, a destructuring pattern, a `Object.keys(record)` walk, and
 * `src/snapshot.ts` all read fields the old guard never looked at, and every one
 * of them left the suite green.
 *
 * So this module parses every source file under `src/` with the TypeScript
 * compiler (`ts.createSourceFile` — the plugin already depends on `typescript`)
 * and reports each key read off a value it has PROVEN to be the catalog
 * document, one of its rows, or one of its category labels.
 *
 * ## Documented boundary and its cost
 *
 * Provenance, not names. A read is reported only when the receiver traces back
 * to a document that entered the module through the audited door — the
 * parameter of `parseCatalogDocument`, or an argument handed to it. That is
 * what keeps `error.message`, `options.profile` and `entry.name` (an already
 * parsed `CatalogEntry`) out of the report; a name-only scan would drown in
 * them and a reviewer would start ignoring it.
 *
 * The provenance rules, each with what it costs:
 *
 * - Taint travels through variable declarations, assignments, `as`/`!` casts,
 *   property and index reads, `for…of`/`for…in`/`.forEach` elements, object
 *   destructuring (including nested and renamed), and the parameters of
 *   SAME-FILE functions called with a tainted argument (the helper case above).
 * - Taint does NOT travel through a call's return value, through a second
 *   file's exported function, or through an arbitrary expression. A helper that
 *   receives a row and returns a boolean is covered; a helper that stores the
 *   row on a module-level mutable object, or that lives in another file, is not
 *   — the read inside it would be missed. `src/` has no such shape today.
 * - A read whose receiver is shapeless (`value`, the primitive a `record.x`
 *   read produced) is NOT reported: `.trim()`, `.length` and `.slice()` live
 *   there, and a name list excluding them would be a hole of its own. Its cost
 *   is the symmetric one — `record.foo.bar` reports `foo` (the field that
 *   matters) but not a second hop.
 * - `document.categories` is treated as free-form: its keys are source-chosen
 *   category ids, so reading one is not a schema field. Its VALUES are still
 *   followed as category labels, and `categoryMapOf`/`storeCategoryMapOf` are
 *   audited against the label definitions like any other reader.
 *   `categoryOf`'s `categories.get(id)?.zh` is therefore not itself reported;
 *   the label field set is covered one step earlier, at the map builders.
 *
 * @module plugin-market/tests/catalog-drift-scan
 */

import { createRequire } from 'node:module'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type * as TS from 'typescript'

const ts: typeof TS = createRequire(import.meta.url)('typescript')

/**
 * The shape a value is known to have. Everything read off it is reported except
 * `value` and `categoryRaw` (see the module header).
 */
export type FieldKind =
  | 'document'
  | 'rows'
  | 'row'
  | 'categoryRaw'
  | 'labelSeq'
  | 'label'
  | 'localized'
  | 'value'

/**
 * The shapes whose keys the contract describes, and so the reported ones.
 * `rows` is deliberately absent: an array of rows has no document field to
 * read — its ELEMENTS are rows, and those are reported. `categoryRaw` is absent
 * for the reason in the module header (its keys are source-chosen ids), and
 * `value` because shapeless values hold the primitive methods.
 */
const AUDITED_KINDS: ReadonlySet<FieldKind> = new Set<FieldKind>(['document', 'row', 'label', 'localized'])

/** One source file handed to {@link scanCatalogFieldReads}. */
export interface SourceUnit {
  /** Path as reported back on every read (relative when it comes from a tree). */
  readonly path: string
  readonly text: string
}

/** One key read off a value proven to be part of the catalog document. */
export interface FieldRead {
  readonly file: string
  readonly line: number
  /** The key, or `''` for a read the scan could not name (see `dynamic`). */
  readonly key: string
  /** The shape the key was read OFF — what its declaration must cover. */
  readonly kind: FieldKind
  /** A read whose key is not a literal (`record[k]`, `Object.keys(record)`). */
  readonly dynamic: boolean
  /** Nearest enclosing named function, when the read sits inside one. */
  readonly inFunction?: string
}

/** Every `.ts`/`.tsx` file under a directory, in a stable order. */
export function readSourceTree(dir: string): SourceUnit[] {
  const found: SourceUnit[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const child = join(current, entry.name)
      if (entry.isDirectory()) { walk(child); continue }
      if (!/\.tsx?$/u.test(entry.name)) continue
      found.push({ path: relative(dir, child).split('\\').join('/'), text: readFileSync(child, 'utf8') })
    }
  }
  walk(dir)
  return found
}

// --- the scan ----------------------------------------------------------------

/** One file's taint environment: identifiers proven to hold a catalog value. */
type Environment = Map<TS.Node, Map<string, FieldKind>>

/** The `parseCatalogDocument` door an unproven document enters through. */
const DOOR = 'parseCatalogDocument'

/** The kind read off `parent` under `key`, or undefined when the key is not a shape's field. */
function childKind(parent: FieldKind, key: string): FieldKind {
  if (parent === 'document') {
    if (key === 'plugins') return 'rows'
    if (key === 'categories') return 'categoryRaw'
  }
  if (parent === 'row' && key === 'description') return 'localized'
  return 'value'
}

/** The kind one element of an iterable holds. */
function elementKind(parent: FieldKind): FieldKind {
  if (parent === 'rows') return 'row'
  if (parent === 'categoryRaw' || parent === 'labelSeq') return 'label'
  return 'value'
}

/** The lattice join: two proven kinds that disagree prove only "some value". */
function joinKinds(left: FieldKind, right: FieldKind): FieldKind {
  return left === right ? left : 'value'
}

/** Whether an expression's callee is the door, under any import spelling. */
function isDoorCall(call: TS.CallExpression): boolean {
  const callee = call.expression
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : ''
  return name === DOOR
}

/** The rightmost name of an `Object.<name>` member call, or undefined. */
function objectMemberName(call: TS.CallExpression): string | undefined {
  const callee = call.expression
  if (!ts.isPropertyAccessExpression(callee)) return undefined
  if (!ts.isIdentifier(callee.expression) || callee.expression.text !== 'Object') return undefined
  return callee.name.text
}

/** Whether a node declares a callable body (not a type-level signature). */
function isFunctionScope(node: TS.Node): boolean {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
    || ts.isConstructorDeclaration(node)
}

/** The callable body of a node, when it has one. */
function functionScopeOf(node: TS.Node): TS.FunctionLikeDeclaration | undefined {
  return isFunctionScope(node) ? node as TS.FunctionLikeDeclaration : undefined
}

/** The name a callable body is declared under, when it has one. */
function functionNameOf(node: TS.Node): string | undefined {
  const scope = functionScopeOf(node)
  if (scope === undefined) return undefined
  const name = (scope as { name?: TS.Node }).name
  return name !== undefined && ts.isIdentifier(name) ? name.text : undefined
}

/** Whether a node opens a scope an identifier can be bound in. */
function isScopeNode(node: TS.Node): boolean {
  return ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node) || isFunctionScope(node)
}

/** The scope an identifier written at `node` belongs to. */
function scopeOf(node: TS.Node): TS.Node {
  for (let current: TS.Node | undefined = node; current !== undefined; current = current.parent as TS.Node | undefined) {
    if (isScopeNode(current)) return current
  }
  return node.getSourceFile()
}

/** The next scope outward from `scope`, if any. */
function outerScopeOf(scope: TS.Node): TS.Node | undefined {
  for (let current = scope.parent as TS.Node | undefined; current !== undefined; current = current.parent as TS.Node | undefined) {
    if (isScopeNode(current)) return current
  }
  return undefined
}

/** The proven kind of an identifier, or undefined when it holds nothing catalog-shaped. */
function lookup(env: Environment, identifier: TS.Identifier): FieldKind | undefined {
  for (let scope: TS.Node | undefined = scopeOf(identifier); scope !== undefined; scope = outerScopeOf(scope)) {
    const kind = env.get(scope)?.get(identifier.text)
    if (kind !== undefined) return kind
  }
  return undefined
}

/** Bind `name` to `kind` in the scope holding `node` (joining with an existing proof). */
function bind(env: Environment, node: TS.Node, name: string, kind: FieldKind): boolean {
  const scope = scopeOf(node)
  let held = env.get(scope)
  if (held === undefined) { held = new Map(); env.set(scope, held) }
  const previous = held.get(name)
  const joined = previous === undefined ? kind : joinKinds(previous, kind)
  if (previous === joined) return false
  held.set(name, joined)
  return true
}

/** The literal key a computed member name reads, or undefined when it is not a literal. */
function literalKey(argument: TS.Expression | undefined): string | undefined {
  if (argument === undefined) return undefined
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) return argument.text
  return undefined
}

/** The proven kind of an expression, following the taint rules in the module header. */
function kindOfExpression(env: Environment, node: TS.Expression | undefined): FieldKind | undefined {
  if (node === undefined) return undefined
  if (ts.isIdentifier(node)) return lookup(env, node)
  if (ts.isParenthesizedExpression(node)) return kindOfExpression(env, node.expression)
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
    || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) {
    return kindOfExpression(env, node.expression)
  }
  if (ts.isPropertyAccessExpression(node)) {
    const parent = kindOfExpression(env, node.expression)
    return parent === undefined ? undefined : childKind(parent, node.name.text)
  }
  if (ts.isElementAccessExpression(node)) {
    const parent = kindOfExpression(env, node.expression)
    if (parent === undefined) return undefined
    if (parent === 'rows' || parent === 'categoryRaw') return elementKind(parent)
    return childKind(parent, literalKey(node.argumentExpression) ?? '')
  }
  if (ts.isCallExpression(node)) {
    const member = objectMemberName(node)
    if (member === 'entries' || member === 'values') {
      const held = kindOfExpression(env, node.arguments[0])
      return held === 'categoryRaw' ? 'labelSeq' : undefined
    }
    return undefined
  }
  return undefined
}

/** The key a binding element reads off the object being destructured. */
function bindingKey(element: TS.BindingElement): string | undefined {
  const target = element.propertyName ?? element.name
  if (ts.isIdentifier(target) || ts.isStringLiteral(target)) return target.text
  return undefined
}

/** One name an object destructuring pattern binds, with the key it reads. */
interface BoundName {
  readonly element: TS.BindingElement
  readonly name: string
  /** The key read, or undefined when it is computed and so unauditable. */
  readonly key: string | undefined
  /** The kind the bound name holds. */
  readonly kind: FieldKind
}

/** Every name one object binding pattern binds off a value of `parent` kind, nested patterns included. */
function boundNames(pattern: TS.ObjectBindingPattern, parent: FieldKind): BoundName[] {
  const found: BoundName[] = []
  const descend = (current: TS.ObjectBindingPattern, kind: FieldKind): void => {
    for (const element of current.elements) {
      const key = bindingKey(element)
      const held = key === undefined ? 'value' : childKind(kind, key)
      if (ts.isIdentifier(element.name)) {
        found.push({ element, name: element.name.text, key, kind: held })
      } else if (ts.isObjectBindingPattern(element.name)) {
        descend(element.name, held)
      } else {
        for (const nested of element.name.elements) {
          if (ts.isOmittedExpression(nested)) continue
          if (ts.isIdentifier(nested.name) && nested.propertyName === undefined) {
            found.push({ element: nested, name: nested.name.text, key: undefined, kind: held })
          }
        }
      }
    }
  }
  descend(pattern, parent)
  return found
}

/** Iterate every node of a file, parents included. */
function walk(node: TS.Node, visit: (node: TS.Node) => void): void {
  visit(node)
  node.forEachChild((child) => { walk(child, visit) })
}

/** One propagation pass; true when it learned something new. */
function propagate(
  source: TS.SourceFile,
  env: Environment,
  declarations: ReadonlyMap<string, TS.FunctionLikeDeclaration>,
): boolean {
  let changed = false
  walk(source, (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      if (ts.isIdentifier(node.name)) {
        const kind = kindOfExpression(env, node.initializer)
        if (kind !== undefined) { changed = bind(env, node, node.name.text, kind) || changed }
      } else if (ts.isObjectBindingPattern(node.name)) {
        const parent = kindOfExpression(env, node.initializer)
        if (parent !== undefined) {
          for (const bound of boundNames(node.name, parent)) {
            changed = bind(env, bound.element, bound.name, bound.kind) || changed
          }
        }
      }
      return
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left)) {
      const kind = kindOfExpression(env, node.right)
      if (kind !== undefined) { changed = bind(env, node, node.left.text, kind) || changed }
      return
    }
    if (ts.isForOfStatement(node)) {
      const held = iteratedKind(env, node.expression)
      if (held !== undefined) {
        const target = ts.isVariableDeclarationList(node.initializer) ? node.initializer.declarations[0] : undefined
        if (target !== undefined) {
          if (ts.isIdentifier(target.name)) changed = bind(env, target, target.name.text, held) || changed
          else if (ts.isArrayBindingPattern(target.name)) {
            // `for (const [id, entry] of Object.entries(map))`: every name takes
            // the element kind; a tuple's first slot holds a key it never reads.
            for (const element of target.name.elements) {
              if (ts.isOmittedExpression(element)) continue
              if (ts.isIdentifier(element.name)) changed = bind(env, element, element.name.text, held) || changed
            }
          }
        }
      }
      return
    }
    if (ts.isCallExpression(node)) {
      if (isDoorCall(node)) {
        const door = node.arguments[0]
        if (door !== undefined && ts.isIdentifier(door)) changed = bind(env, door, door.text, 'document') || changed
      }
      const callee = node.expression
      const name = ts.isIdentifier(callee) ? callee.text : undefined
      const declaration = name === undefined ? undefined : declarations.get(name)
      if (declaration !== undefined) {
        node.arguments.forEach((argument, index) => {
          const kind = kindOfExpression(env, argument)
          if (kind === undefined) return
          const parameter = declaration.parameters[Math.min(index, declaration.parameters.length - 1)]
          if (parameter === undefined) return
          if (index >= declaration.parameters.length && parameter.dotDotDotToken === undefined) return
          if (ts.isIdentifier(parameter.name)) changed = bind(env, parameter, parameter.name.text, kind) || changed
        })
      }
      // `rows.forEach(row => …)`: the callback's first parameter is an element.
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'forEach') {
        const held = kindOfExpression(env, callee.expression)
        const callback = node.arguments[0]
        const scope = callback === undefined ? undefined : functionScopeOf(callback)
        if (held !== undefined && scope !== undefined) {
          const parameter = scope.parameters[0]
          if (parameter !== undefined && ts.isIdentifier(parameter.name)) {
            changed = bind(env, parameter, parameter.name.text, elementKind(held)) || changed
          }
        }
      }
      return
    }
  })
  return changed
}

/** The kind a `for…of`/`forEach` element holds, following `Object.entries(map)`. */
function iteratedKind(env: Environment, expression: TS.Expression): FieldKind | undefined {
  const held = kindOfExpression(env, expression)
  return held === undefined ? undefined : elementKind(held)
}

/** Every read the environment proves is a catalog field, or an unauditable one. */
function report(source: TS.SourceFile, env: Environment, file: string): FieldRead[] {
  const reads: FieldRead[] = []
  const enclosing: string[] = []
  const note = (node: TS.Node, key: string, kind: FieldKind, dynamic: boolean): void => {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source))
    const owner = enclosing[enclosing.length - 1]
    reads.push({
      file,
      line: position.line + 1,
      key,
      kind,
      dynamic,
      ...(owner === undefined ? {} : { inFunction: owner }),
    })
  }
  const visit = (node: TS.Node): void => {
    const named = functionNameOf(node)
    if (named !== undefined) enclosing.push(named)
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const parent = kindOfExpression(env, node.expression)
      if (parent !== undefined && AUDITED_KINDS.has(parent)) {
        if (ts.isPropertyAccessExpression(node)) note(node, node.name.text, parent, false)
        else {
          const key = literalKey(node.argumentExpression)
          if (key === undefined) note(node, '', parent, true)
          else note(node, key, parent, false)
        }
      }
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword) {
      const parent = kindOfExpression(env, node.right)
      if (parent !== undefined && AUDITED_KINDS.has(parent)) {
        const key = literalKey(node.left)
        note(node, key ?? '', parent, key === undefined)
      }
    } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
      const parent = kindOfExpression(env, node.initializer)
      if (parent !== undefined && AUDITED_KINDS.has(parent)) {
        for (const bound of boundNames(node.name, parent)) {
          if (bound.key === undefined) note(bound.element, '', parent, true)
          else note(bound.element, bound.key, parent, false)
        }
      }
    } else if (ts.isForInStatement(node)) {
      const parent = kindOfExpression(env, node.expression)
      if (parent !== undefined && AUDITED_KINDS.has(parent)) note(node, '', parent, true)
    } else if (ts.isCallExpression(node)) {
      const member = objectMemberName(node)
      if (member === 'keys' || member === 'entries' || member === 'values') {
        const parent = kindOfExpression(env, node.arguments[0])
        if (parent !== undefined && AUDITED_KINDS.has(parent)) note(node, '', parent, true)
      }
    }
    node.forEachChild((child) => { visit(child) })
    if (named !== undefined) enclosing.pop()
  }
  visit(source)
  return reads
}

/** Every named callable in a file, for same-file argument propagation. */
function declarationsOf(source: TS.SourceFile): Map<string, TS.FunctionLikeDeclaration> {
  const found = new Map<string, TS.FunctionLikeDeclaration>()
  walk(source, (node) => {
    const named = functionNameOf(node)
    const scope = functionScopeOf(node)
    if (named !== undefined && scope !== undefined && !found.has(named)) found.set(named, scope)
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const initializer = functionScopeOf(node.initializer)
      if (initializer !== undefined && !found.has(node.name.text)) found.set(node.name.text, initializer)
    }
  })
  return found
}

/** How many propagation rounds before the scan gives up on convergence. */
const MAX_ROUNDS = 8

/**
 * Scan source units for reads of catalog-document fields.
 * @param files - the sources to scan; a caller passes the whole `src/` tree.
 * @returns every proven read, plus every unauditable one (`dynamic: true`).
 * @throws Error when a file does not parse into a source file — a scan that
 *   silently skipped a file would report agreement it never established.
 */
export function scanCatalogFieldReads(files: readonly SourceUnit[]): FieldRead[] {
  const reads: FieldRead[] = []
  for (const file of files) {
    const source = ts.createSourceFile(
      file.path,
      file.text,
      ts.ScriptTarget.ES2022,
      true,
      file.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    const diagnostics = (source as unknown as { parseDiagnostics?: readonly { messageText: unknown }[] }).parseDiagnostics
    if (diagnostics !== undefined && diagnostics.length > 0) {
      throw new Error(`${file.path} does not parse: ${String(diagnostics[0]?.messageText)}`)
    }
    const env: Environment = new Map()
    const declarations = declarationsOf(source)
    // Seed: the door itself. Its parameter is the document; anywhere else, the
    // argument handed to it is.
    walk(source, (node) => {
      if (functionNameOf(node) === DOOR) {
        const parameter = functionScopeOf(node)?.parameters[0]
        if (parameter !== undefined && ts.isIdentifier(parameter.name)) bind(env, parameter, parameter.name.text, 'document')
      }
    })
    let converged = false
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      if (!propagate(source, env, declarations)) { converged = true; break }
    }
    if (!converged) {
      throw new Error(`${file.path}: the taint analysis did not settle in ${String(MAX_ROUNDS)} rounds —`
        + ' a scan that stops early under-reports the reads it is meant to catch')
    }
    reads.push(...report(source, env, file.path))
  }
  return reads
}
