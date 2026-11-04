/**
 * The `.gitignore` matcher and the generated-file predicates, as pure functions.
 *
 * These are the unit tests of a rule engine whose verdicts are only visible in
 * `indexer.test.ts` as "a file is missing from the graph". Pinning the semantics
 * here is what keeps a walk-level failure from being read as a filesystem quirk:
 * a `dist/` that still gets indexed looks exactly like a `.gitignore` the app
 * never read, and the difference is one `isIgnored` call away.
 *
 * @module plugin-codegraph/tests/ignore
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  GENERATED_BANNER_LINES,
  hasNegation,
  isGeneratedHead,
  isGeneratedPath,
  isIgnored,
  parseGitignore,
} from '../src/ignore.ts'

/** The shape of one parsed rule, for assertions that care about parsing. */
function shape(text: string, base = ''): string[] {
  return parseGitignore(text, base).map(rule => `${rule.negated ? '!' : ''}${rule.anchored ? '/' : ''}${rule.dirOnly ? 'dir:' : ''}${rule.segments.join('/')}`)
}

describe('parseGitignore', () => {
  it('skips comments and blank lines, and keeps the remaining order', () => {
    // Order IS the precedence: the last matching rule wins, so a parser that
    // reordered or dropped a line would silently invert a negation.
    assert.deepEqual(shape('# a comment\n\n   \n*.tmp.ts\n!keep.tmp.ts\n'), ['*.tmp.ts', '!keep.tmp.ts'])
  })

  it('reads a trailing slash as "directory only" and a leading one as anchored', () => {
    assert.deepEqual(shape('dist/\n/build\nlogs\n'), ['dir:dist', '/build', 'logs'])
  })

  it('anchors a pattern that has a separator in the middle', () => {
    // git's rule: a `/` anywhere but the end makes the pattern relative to the
    // `.gitignore`'s own directory instead of matching that name at any depth.
    assert.deepEqual(shape('src/gen/*.ts'), ['/src/gen/*.ts'])
  })

  it('carries the directory a nested file was found in', () => {
    const [rule] = parseGitignore('secret.ts\n', 'pkg/sub')
    assert.equal(rule?.base, 'pkg/sub', 'a nested rule speaks only about its own subtree')
  })
})

describe('isIgnored', () => {
  const rules = (text: string, base = ''): ReturnType<typeof parseGitignore> => parseGitignore(text, base)

  it('excludes an ignored directory and everything under it', () => {
    const set = rules('dist/\n')
    assert.equal(isIgnored(set, 'dist', true), true, 'the directory itself is excluded')
    assert.equal(isIgnored(set, 'dist/bundle.js'), true, 'a file below it is covered by the directory rule')
    assert.equal(isIgnored(set, 'dist/deep/nested/x.ts'), true, 'at any depth')
    assert.equal(isIgnored(set, 'src/dist.ts'), false, 'a name that merely ends in "dist" is not the directory')
  })

  it('keeps a file that a negation names, inside the directory it excluded', () => {
    // The case that makes `!` worth supporting at all, and the reason the walk
    // descends into an ignored directory when a negation is in force.
    const set = rules('dist/\n!dist/keep.ts\n')
    assert.equal(isIgnored(set, 'dist/keep.ts'), false, 'the negation is the later rule, so it wins')
    assert.equal(isIgnored(set, 'dist/other.ts'), true, 'and it re-includes exactly what it names')
    assert.equal(isIgnored(set, 'dist/keep.ts.bak'), true, 'a longer name is a different path')
  })

  it('matches a wildcard at any depth', () => {
    const set = rules('*.tmp.ts\n')
    assert.equal(isIgnored(set, 'scratch.tmp.ts'), true)
    assert.equal(isIgnored(set, 'src/deep/scratch.tmp.ts'), true, 'a pattern without a separator matches any component')
    assert.equal(isIgnored(set, 'scratch.ts'), false)
  })

  it('crosses directories for a `**` pattern, and leaves the named directory itself alone', () => {
    const set = rules('**/tmp/**\n')
    assert.equal(isIgnored(set, 'tmp/a.ts'), true)
    assert.equal(isIgnored(set, 'src/tmp/a.ts'), true)
    assert.equal(isIgnored(set, 'src/tmp/deeper/a.ts'), true)
    assert.equal(isIgnored(set, 'src/notmp/a.ts'), false)
    // `a/**` covers what is INSIDE `a`, so the directory is walked and its files
    // are refused one by one rather than the whole tree disappearing at once.
    assert.equal(isIgnored(set, 'src/tmp', true), false)
  })

  it('anchors a leading slash to the .gitignore directory', () => {
    const set = rules('/build\n')
    assert.equal(isIgnored(set, 'build', true), true)
    assert.equal(isIgnored(set, 'src/build', true), false, 'an anchored rule does not match at depth')
  })

  it('matches one character for `?`, never a separator', () => {
    const set = rules('file?.ts\n')
    assert.equal(isIgnored(set, 'file1.ts'), true)
    assert.equal(isIgnored(set, 'file10.ts'), false)
  })

  it('keeps a nested .gitignore to its own subtree', () => {
    // The defect this pins: a rule collected from `pkg/` being applied to a
    // sibling directory, which would drop a file the author never excluded.
    const set = rules('secret.ts\n', 'pkg')
    assert.equal(isIgnored(set, 'pkg/secret.ts'), true)
    assert.equal(isIgnored(set, 'pkg/deep/secret.ts'), true)
    assert.equal(isIgnored(set, 'other/secret.ts'), false)
    assert.equal(isIgnored(set, 'secret.ts'), false)
  })

  it('lets a deeper .gitignore override the root one', () => {
    // Root rules arrive first, so a nested file's later rule is the one that wins.
    const set = [...rules('*.log\n'), ...rules('!debug.log\n', 'pkg')]
    assert.equal(isIgnored(set, 'pkg/debug.log'), false)
    assert.equal(isIgnored(set, 'other/debug.log'), true)
  })

  it('compares case-insensitively, because the filesystem it walks is', () => {
    // Windows and most macOS trees hold one `dist` whatever case a rule was typed
    // in; a case-sensitive matcher would let the directory through on those hosts
    // and keep it on Linux, which is the worst of both.
    assert.equal(isIgnored(rules('dist/\n'), 'Dist/x.ts'), true)
  })
})

describe('hasNegation', () => {
  it('reports whether a prune is safe', () => {
    assert.equal(hasNegation(parseGitignore('dist/\n')), false, 'nothing can bring a file back, so the directory can be pruned')
    assert.equal(hasNegation(parseGitignore('dist/\n!dist/keep.ts\n')), true, 'the walk has to descend to find what the negation keeps')
    assert.equal(hasNegation([]), false)
  })
})

describe('isGeneratedPath', () => {
  it('recognises the naming conventions of the generators that matter here', () => {
    for (const path of [
      'lib/model.g.dart',
      'proto/service.pb.go',
      'src/wire_generated.ts',
      'app/legacy.generated.js',
      'static/vendor.min.js',
      'Forms/MainWindow.Designer.cs',
      'Forms/MainWindow.g.cs',
    ]) {
      assert.equal(isGeneratedPath(path), true, `${path} is named as build output`)
    }
  })

  it('leaves a hand-written file alone, including one whose name says "generated"', () => {
    // The false positive that matters: a person can type "generated" into a file
    // name, and dropping that file loses symbols nobody can find afterwards.
    for (const path of ['src/index.ts', 'src/generated.ts', 'docs/README.md', 'src/schema.d.ts']) {
      assert.equal(isGeneratedPath(path), false, `${path} is a name a person writes`)
    }
  })
})

describe('isGeneratedHead', () => {
  it('recognises the banner shapes real generators write', () => {
    assert.equal(isGeneratedHead('// @generated by graphql-codegen\n'), true)
    assert.equal(isGeneratedHead('//------------------------------------------------------------------------------\n// <auto-generated>\n//------------------------------------------------------------------------------\n'), true)
    assert.equal(isGeneratedHead('// Code generated by protoc-gen-go. DO NOT EDIT.\n'), true)
    assert.equal(isGeneratedHead('"""Generated by Django 4.2 on 2024-01-01."""\n'), true)
    assert.equal(isGeneratedHead('# Generated by docker buildx\n'), true)
  })

  it('does not read a banner out of the body of a file', () => {
    // The limit `GENERATED_BANNER_LINES` exists for: a README that documents its
    // own generated table says "do not edit" in prose, and must stay in the graph.
    const head = ['# Guide', '', 'Run the build.', '', '', '', 'Do not edit the table below by hand.'].join('\n')
    assert.equal(isGeneratedHead(head), false, 'a mention past the banner window is prose, not a banner')
    assert.ok(GENERATED_BANNER_LINES >= 3, 'the window has to cover a licence header plus the banner line')
  })

  it('says nothing for an ordinary source file or for an empty head', () => {
    assert.equal(isGeneratedHead('SYM alpha\nCALL beta\n'), false)
    assert.equal(isGeneratedHead(''), false)
  })
})
