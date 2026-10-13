/**
 * A minimal JSON Schema validator, scoped to the keywords the published
 * catalog-source schema actually uses.
 *
 * Why hand-rolled: the plugin's manifest declares no schema validator and the
 * repository root carries `ajv` only as a transitive dependency of
 * `electron-builder`/`@deepseek-ai/dsh-api-settings-controller` — depending on
 * an undeclared, hoisted package from a plugin test would break the moment a
 * root install moves it (and `npm ci` inside the plugin never installs it at
 * all). Adding one is a new dependency, which this work is not allowed to do.
 *
 * The trade-off is made safe by being LOUD instead of permissive: a keyword this
 * reader does not implement is an error, never a silent pass. A schema author
 * who reaches for `format`, `minItems`, `oneOf`, `const` or `enum` gets a
 * failure that names the keyword and says where to extend, so the validator can
 * never quietly stop checking part of the schema.
 *
 * That audit is STATIC and TOTAL, and this is the part that is easy to get
 * wrong. A check performed inside `visit()` only sees the nodes an instance
 * happens to walk: `properties` is entered for the keys the instance carries,
 * `items` only for a non-empty array, a later `anyOf` branch only when an
 * earlier one did not match, an unreferenced `$defs` entry never. A keyword
 * planted in one of those positions would then be invisible — the schema could
 * stop describing the instance and the suite would stay green. So
 * {@link assertSupportedKeywords} walks the whole schema graph (every `$defs`
 * entry and every subschema, `$ref` targets included, since they resolve inside
 * the same document) BEFORE any instance is judged, and throws on the first
 * unsupported keyword, `type` name, or uncompilable `pattern` it finds.
 *
 * The supported set is the set the contract schema uses, and every supported
 * keyword is exercised by `catalog-contract.test.ts`.
 *
 * Deliberate fidelity note: `integer` means a JavaScript safe integer
 * (`Number.isSafeInteger`), matching the parser's own `safeCountOf`, and string
 * lengths count UTF-16 code units, matching `String.prototype.length` in the
 * parser — not the code-point counting the JSON Schema specification describes.
 * Both differences are unobservable for this schema's field names and URLs, and
 * the stricter side is always the parser's own cap.
 *
 * @module plugin-market/tests/schema-validator
 */

/** Keywords that carry no assertion and are ignored while validating. */
const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set([
  '$schema',
  '$id',
  '$anchor',
  'title',
  'description',
  '$comment',
  'examples',
  'default',
  'deprecated',
  'readOnly',
  'writeOnly',
])

/** Keywords that carry an assertion this validator implements. */
const ASSERTION_KEYWORDS: ReadonlySet<string> = new Set([
  '$ref',
  '$defs',
  'type',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'anyOf',
  'not',
])

/**
 * The implemented keywords whose value is, or contains, subschemas — the
 * positions the static audit descends into. An unimplemented keyword is
 * reported by the keyword check before its value is ever looked at, so this
 * list only has to cover the implemented ones.
 */
const SUBSCHEMA_KEYWORDS: ReadonlyArray<string> = [
  '$defs',
  'properties',
  'anyOf',
  'items',
  'not',
  'additionalProperties',
]

/** One JSON Schema node, as much as this reader cares. */
export type JsonSchema = Record<string, unknown>

/** Raised for a schema-shaped problem, never for an invalid instance. */
export class UnsupportedSchemaError extends Error {}

/**
 * Validate a value against a schema.
 *
 * The schema's own vocabulary is audited first and in full (see the module
 * header), so a schema carrying a keyword, `type` name or `pattern` this reader
 * cannot honour throws here rather than passing somewhere an instance never
 * reaches.
 *
 * @param schema - the schema node to judge the instance with.
 * @param value - the instance to judge.
 * @param root - the document `$ref` resolves against; defaults to `schema`, so
 *   pass the whole file when validating against a single `$defs` entry.
 * @returns one message per failed assertion, each naming the instance path;
 *   an empty array means the instance validates.
 * @throws UnsupportedSchemaError when the schema (or the root it resolves
 *   against) uses anything this reader does not implement.
 */
export function validateSchema(schema: unknown, value: unknown, root: unknown = schema): string[] {
  const problems: string[] = []
  assertSupportedKeywords(root, '#', problems)
  if (schema !== root) assertSupportedKeywords(schema, '#/', problems)
  if (problems.length > 0) {
    throw new UnsupportedSchemaError(
      `the schema uses ${String(problems.length)} thing(s) the minimal validator does not implement:\n  `
      + problems.join('\n  ')
      + '\nadd the keyword to tests/schema-validator.ts or drop it from the schema',
    )
  }
  const errors: string[] = []
  visit(schema, value, root, '#', errors)
  return errors
}

/**
 * Walk one schema node and everything under it, collecting every keyword, type
 * name and pattern this reader cannot honour. Instance-independent: the walk
 * descends into positions no instance would reach (an unused `$defs` entry, an
 * `anyOf` branch that has already matched, the `items` of an empty array).
 * @param node - the schema node to audit.
 * @param at - the schema path, for the message.
 * @param problems - appended to; the caller decides when to throw.
 */
function assertSupportedKeywords(node: unknown, at: string, problems: string[]): void {
  if (typeof node === 'boolean') return
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    problems.push(`${at}: a schema node is neither an object nor a boolean`)
    return
  }
  const record = node as Record<string, unknown>
  for (const keyword of Object.keys(record)) {
    if (ANNOTATION_KEYWORDS.has(keyword) || ASSERTION_KEYWORDS.has(keyword)) continue
    if (keyword.startsWith('x-')) continue
    problems.push(`"${keyword}" at ${at} is not implemented`)
  }
  const declaredTypes = record.type === undefined ? [] : (Array.isArray(record.type) ? record.type : [record.type])
  for (const candidate of declaredTypes) {
    if (!IMPLEMENTED_TYPES.has(candidate)) problems.push(`type "${String(candidate)}" at ${at} is not implemented`)
  }
  if (record.pattern !== undefined) {
    if (typeof record.pattern !== 'string') problems.push(`pattern at ${at} is not a string`)
    else {
      try {
        new RegExp(record.pattern)
      } catch (error) {
        problems.push(`pattern ${JSON.stringify(record.pattern)} at ${at} does not compile (${String(error)})`)
      }
    }
  }
  for (const keyword of SUBSCHEMA_KEYWORDS) {
    const child = record[keyword]
    if (child === undefined) continue
    if (keyword === '$defs' || keyword === 'properties') {
      if (typeof child !== 'object' || child === null || Array.isArray(child)) continue
      for (const [name, subschema] of Object.entries(child)) {
        assertSupportedKeywords(subschema, `${at}/${keyword}/${name}`, problems)
      }
      continue
    }
    if (Array.isArray(child)) {
      child.forEach((subschema, index) => { assertSupportedKeywords(subschema, `${at}/${keyword}/${String(index)}`, problems) })
      continue
    }
    assertSupportedKeywords(child, `${at}/${keyword}`, problems)
  }
}

/** The `type` names {@link instanceHasType} understands. */
const IMPLEMENTED_TYPES: ReadonlySet<string> = new Set([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
])

/** Whether one instance satisfies one `type` keyword. */
function instanceHasType(type: unknown, value: unknown): boolean {
  switch (type) {
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return Number.isSafeInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: throw new UnsupportedSchemaError(`the minimal validator has no support for type "${String(type)}"`)
  }
}

/** The schema a local `$ref` names, resolved against the root document. */
function resolveRef(ref: unknown, root: unknown): unknown {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) {
    throw new UnsupportedSchemaError(`the minimal validator can only follow local JSON pointers, not "${String(ref)}"`)
  }
  let node: unknown = root
  for (const rawToken of ref.slice(2).split('/')) {
    const token = rawToken.replace(/~1/gu, '/').replace(/~0/gu, '~')
    if (typeof node !== 'object' || node === null) {
      throw new UnsupportedSchemaError(`$ref "${ref}" names nothing in the schema root`)
    }
    node = (node as Record<string, unknown>)[token]
  }
  if (node === undefined) throw new UnsupportedSchemaError(`$ref "${ref}" names nothing in the schema root`)
  return node
}

/** Judge one schema node against one instance at one path. */
function visit(schema: unknown, value: unknown, root: unknown, path: string, errors: string[]): void {
  if (typeof schema === 'boolean') {
    if (!schema) errors.push(`${path}: refused by a "false" schema`)
    return
  }
  const node = schema as Record<string, unknown>
  if (node.$ref !== undefined) visit(resolveRef(node.$ref, root), value, root, path, errors)
  const type = node.type
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type]
    if (!types.some(candidate => instanceHasType(candidate, value))) {
      errors.push(`${path}: expected ${types.map(String).join(' or ')}, got ${describe(value)}`)
      return
    }
  }
  const isObject = typeof value === 'object' && value !== null && !Array.isArray(value)
  const declared = (typeof node.properties === 'object' && node.properties !== null
    ? node.properties
    : {}) as Record<string, unknown>
  if (isObject) {
    // `required` and `additionalProperties` stand on their own: `{ required:
    // ['npm'] }` inside an `anyOf`/`not` branch is a whole schema of its own,
    // and skipping it there would make `not` match everything.
    if (Array.isArray(node.required)) {
      for (const name of node.required) {
        if (!(String(name) in (value as Record<string, unknown>))) errors.push(`${path}: "${String(name)}" is required`)
      }
    }
    for (const [name, property] of Object.entries(declared)) {
      const held = (value as Record<string, unknown>)[name]
      if (held === undefined) continue
      visit(property, held, root, `${path}/${name}`, errors)
    }
    const additional = node.additionalProperties
    if (additional === false) {
      for (const name of Object.keys(value as Record<string, unknown>)) {
        if (!(name in declared)) errors.push(`${path}: "${name}" is not allowed here`)
      }
    } else if (typeof additional === 'object' && additional !== null) {
      for (const [name, held] of Object.entries(value as Record<string, unknown>)) {
        if (name in declared) continue
        visit(additional, held, root, `${path}/${name}`, errors)
      }
    }
  }
  if (Array.isArray(value) && node.items !== undefined) {
    value.forEach((item, index) => { visit(node.items, item, root, `${path}/${String(index)}`, errors) })
  }
  if (typeof value === 'string') {
    if (typeof node.pattern === 'string' && !new RegExp(node.pattern).test(value)) {
      errors.push(`${path}: ${JSON.stringify(value)} does not match ${node.pattern}`)
    }
    if (typeof node.minLength === 'number' && value.length < node.minLength) {
      errors.push(`${path}: shorter than minLength ${String(node.minLength)}`)
    }
    if (typeof node.maxLength === 'number' && value.length > node.maxLength) {
      errors.push(`${path}: longer than maxLength ${String(node.maxLength)}`)
    }
  }
  if (typeof value === 'number') {
    if (typeof node.minimum === 'number' && value < node.minimum) errors.push(`${path}: below minimum ${String(node.minimum)}`)
    if (typeof node.maximum === 'number' && value > node.maximum) errors.push(`${path}: above maximum ${String(node.maximum)}`)
  }
  if (Array.isArray(node.anyOf)) {
    const matched = node.anyOf.some(candidate => validateBranch(candidate, value, root))
    if (!matched) errors.push(`${path}: matched none of the ${String(node.anyOf.length)} anyOf branches`)
  }
  if (node.not !== undefined && validateBranch(node.not, value, root)) {
    errors.push(`${path}: matched a "not" schema and is therefore refused`)
  }
}

/** Whether one branch validates, discarding its messages. */
function validateBranch(schema: unknown, value: unknown, root: unknown): boolean {
  const errors: string[] = []
  visit(schema, value, root, '#', errors)
  return errors.length === 0
}

/** A short description of an instance for one error message. */
function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return typeof value === 'object' ? 'an object' : `${typeof value} ${JSON.stringify(value)}`
}
