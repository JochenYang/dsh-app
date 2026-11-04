/**
 * Prisma and GraphQL SDL, read by the shared scanner.
 *
 * Both languages are lists of named blocks, and the two things a scanner can get wrong are
 * the same in both: a brace that closes a block early (inside a comment or a doc string),
 * and a "type" that is really a scalar. So the fixtures here are the awkward shapes rather
 * than the happy path.
 *
 * @module plugin-codegraph/tests/schema
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { parseGraphql, parsePrisma } from '../src/schema.ts'

/** The declarations a document produced, as `kind:name`. */
function declared(parsed: { symbols: readonly { kind: string, name: string }[] }): string[] {
  return parsed.symbols.map(symbol => `${symbol.kind}:${symbol.name}`)
}

describe('parsePrisma', () => {
  const schema = [
    '// A comment with a } brace in it.',
    'enum Role {',
    '  ADMIN',
    '  USER',
    '}',
    '',
    '/// A doc comment with a { brace.',
    'model User {',
    '  id    Int    @id',
    '  role  Role',
    '  posts Post[]',
    '}',
    '',
    'model Post {',
    '  id       Int  @id',
    '  author   User @relation(fields: [authorId], references: [id])',
    '  authorId Int',
    '}',
  ].join('\n')

  it('declares the models and enums, and relates them by field type', () => {
    const parsed = parsePrisma(schema, 'prisma/schema.prisma')
    assert.deepEqual(declared(parsed), ['enum:Role', 'struct:User', 'struct:Post'])
    const fromUser = parsed.calls.filter(call => call.owner === 'prisma/schema.prisma#struct:User')
    assert.deepEqual(fromUser.map(call => call.name), ['Role', 'Post'], 'a relation is the field type, and scalars are not relations')
  })

  it('gives a model the lines its body spans, so a slice shows the fields', () => {
    const parsed = parsePrisma(schema, 'a.prisma')
    const user = parsed.symbols.find(symbol => symbol.name === 'User')
    assert.deepEqual([user?.line, user?.endLine], [8, 12])
  })

  it('is not cut short by a brace in a comment', () => {
    // The `}` in the first line's comment would end `Role` three lines early, and every
    // field after it would be read as a top-level declaration.
    const parsed = parsePrisma(schema, 'a.prisma')
    assert.equal(parsed.symbols.find(symbol => symbol.name === 'Role')?.endLine, 5)
  })
})

describe('parseGraphql', () => {
  const sdl = [
    '# A comment with a } brace.',
    'scalar Date',
    'enum Role { ADMIN USER }',
    'interface Node { id: ID! }',
    'type User implements Node {',
    '  id: ID!',
    '  name: String!',
    '  role: Role',
    '  posts: [Post!]!',
    '  createdAt: Date',
    '}',
    'type Post { id: ID! author: User }',
    'union Search = User | Post',
    'input Filter { term: String }',
  ].join('\n')

  it('declares every block kind', () => {
    assert.deepEqual(declared(parseGraphql(sdl, 'schema.graphql')), [
      'type:Date',
      'enum:Role',
      'interface:Node',
      'struct:User',
      'struct:Post',
      'type:Search',
      'type:Filter',
    ])
  })

  it('relates a field type, an implements clause and a union member', () => {
    const parsed = parseGraphql(sdl, 'schema.graphql')
    const fromUser = parsed.calls.filter(call => call.owner === 'schema.graphql#struct:User')
    assert.deepEqual(fromUser.map(call => call.name), ['Node', 'Role', 'Post', 'Date'], 'built-in scalars are filtered, named types are not')
    const union = parsed.calls.filter(call => call.owner === 'schema.graphql#type:Search')
    assert.ok(union.some(call => call.name === 'Post'), 'a union member is a reference')
  })

  it('is not cut short by a brace in a block-string description', () => {
    const source = ['type Doc {', '  """', '  a } brace in a description', '  """', '  id: ID!', '}', 'type Next { id: ID! }'].join('\n')
    const parsed = parseGraphql(source, 'a.graphql')
    assert.deepEqual([parsed.symbols[0]?.name, parsed.symbols[0]?.endLine], ['Doc', 6])
    assert.deepEqual(parsed.symbols.map(symbol => symbol.name), ['Doc', 'Next'])
  })

  it('declares a bodiless type without swallowing the next block', () => {
    // `extend type User @key(...)` is legal with no braces; taking the next `{` would give
    // it the following type's body and that type's fields.
    const source = ['extend type User @key(fields: "id")', 'type Post { id: ID! }'].join('\n')
    const parsed = parseGraphql(source, 'a.graphql')
    assert.deepEqual(parsed.symbols.map(symbol => `${symbol.name}@${String(symbol.line)}`), ['User@1', 'Post@2'])
    assert.deepEqual(parsed.calls, [], 'the bodiless type has no body to read references from')
  })
})
