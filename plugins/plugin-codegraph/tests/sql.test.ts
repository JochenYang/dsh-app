/**
 * SQL, read by the scanner rather than a grammar.
 *
 * The cases that matter are the ones a naive `split(';')` gets wrong, because a wrong
 * split does not produce an error — it produces a declaration that does not exist, or
 * misses one that does. So the fixtures here are the awkward shapes: a semicolon inside
 * a string, inside a comment, and inside a Postgres dollar-quoted function body.
 *
 * @module plugin-codegraph/tests/sql
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { maskedSql, parseSql } from '../src/sql.ts'

/** The declarations a script produced, as `kind:name`. */
function declared(source: string): string[] {
  return parseSql(source, 'migrations/001.sql').symbols.map(symbol => `${symbol.kind}:${symbol.name}`)
}

describe('parseSql — declarations', () => {
  it('reads a Postgres table, view, type and function', () => {
    const source = [
      'CREATE TYPE mood AS ENUM (\'sad\', \'ok\');',
      'CREATE TABLE users (',
      '  id uuid PRIMARY KEY,',
      '  mood mood',
      ');',
      'CREATE VIEW active_users AS SELECT * FROM users;',
      "CREATE FUNCTION touch() RETURNS trigger AS $$ BEGIN NEW.at := now(); RETURN NEW; END; $$ LANGUAGE plpgsql;",
    ].join('\n')
    assert.deepEqual(declared(source), [
      'type:mood',
      'struct:users',
      'function:active_users',
      'function:touch',
    ])
  })

  it('reads the IF NOT EXISTS, TEMP and schema-qualified forms', () => {
    const source = [
      'CREATE TABLE IF NOT EXISTS "audit" (id int);',
      'CREATE TEMPORARY TABLE scratch (id int);',
      'CREATE TABLE public.orders (id int);',
    ].join('\n')
    assert.deepEqual(declared(source), ['struct:audit', 'struct:scratch', 'struct:orders'])
  })

  it('reads a backtick-quoted MySQL table', () => {
    assert.deepEqual(declared('CREATE TABLE `order_items` (`id` int);'), ['struct:order_items'])
  })

  it('declares a CREATE OR REPLACE run twice only once', () => {
    // Two symbols with one id would fail the whole file's write: the id is the primary
    // key of the symbols table.
    const source = [
      'CREATE OR REPLACE VIEW report AS SELECT 1;',
      'CREATE OR REPLACE VIEW report AS SELECT 2;',
    ].join('\n')
    assert.deepEqual(declared(source), ['function:report'])
  })
})

describe('maskedSql', () => {
  it('keeps the length and the line structure, so a line number stays a line number', () => {
    const source = [
      "INSERT INTO t VALUES ('a;b');",
      '-- a comment; with a semicolon',
      '/* block; comment */',
      'CREATE TABLE t (id int);',
    ].join('\n')
    const mask = maskedSql(source)
    assert.equal(mask.length, source.length)
    assert.equal(mask.split('\n').length, source.split('\n').length)
    // No semicolon survives outside the real statement ends.
    assert.equal((mask.match(/;/gu) ?? []).length, 2, 'the one in the string and the comments are gone')
    // An identifier keeps its name; a string does not.
    assert.match(mask, /CREATE TABLE t/u)
    assert.doesNotMatch(mask, /a;b/u)
  })
})

describe('parseSql — where a statement ends', () => {
  it('does not split on a semicolon inside a string', () => {
    const source = "CREATE TABLE notes (body text DEFAULT 'a;b');\nCREATE TABLE other (id int);"
    assert.deepEqual(declared(source), ['struct:notes', 'struct:other'])
  })

  it('does not split on a semicolon inside a comment', () => {
    const source = [
      '-- run this; then that',
      'CREATE TABLE a (id int);',
      '/* a block; with a semicolon */',
      'CREATE TABLE b (id int);',
    ].join('\n')
    assert.deepEqual(declared(source), ['struct:a', 'struct:b'])
  })

  it('keeps a dollar-quoted function body in one statement', () => {
    // The body holds whole statements. Splitting there would read `BEGIN … END` as SQL
    // and could invent a declaration from the garbage.
    const source = [
      'CREATE FUNCTION bump() RETURNS void AS $$',
      'BEGIN',
      '  UPDATE counters SET n = n + 1;',
      '  DELETE FROM stale;',
      'END;',
      '$$ LANGUAGE plpgsql;',
      'CREATE TABLE after (id int);',
    ].join('\n')
    const parsed = parseSql(source, 'a.sql')
    assert.deepEqual(parsed.symbols.map(symbol => symbol.name), ['bump', 'after'])
  })
})

describe('parseSql — what a statement references', () => {
  it('attributes a foreign key to the table that declares it', () => {
    const source = [
      'CREATE TABLE orders (',
      '  id int,',
      '  user_id int REFERENCES users(id)',
      ');',
    ].join('\n')
    const parsed = parseSql(source, 'a.sql')
    assert.deepEqual(parsed.calls.map(call => `${call.name}@${String(call.line)}`), ['users@3'])
    assert.equal(parsed.calls[0]?.owner, 'a.sql#struct:orders', 'the edge belongs to the declaration')
  })

  it('starts a bare data statement’s edge at the file', () => {
    const source = 'ALTER TABLE users ADD COLUMN email text;'
    const parsed = parseSql(source, 'a.sql')
    assert.deepEqual(parsed.calls.map(call => call.name), ['users'])
    assert.equal(parsed.calls[0]?.owner, undefined, 'no declaration in this statement, so the file owns it')
  })

  it('ignores a FROM that names no table', () => {
    assert.deepEqual(parseSql('SELECT * FROM (SELECT 1) t;', 'a.sql').calls, [])
    assert.deepEqual(parseSql('SELECT * FROM unnest(ARRAY[1]);', 'a.sql').calls, [])
  })

  it('gives a declaration the lines it spans, so a slice covers the columns', () => {
    const parsed = parseSql(['CREATE TABLE t (', '  a int,', '  b int', ');'].join('\n'), 'a.sql')
    assert.deepEqual([parsed.symbols[0]?.line, parsed.symbols[0]?.endLine], [1, 4])
  })
})
