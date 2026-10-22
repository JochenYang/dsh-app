/**
 * Language table contract: extension selection, the bundled set, and the
 * "not installed is not the same as empty" rule.
 *
 * The failure these guard against is silent: a graph that quietly skips a
 * language looks exactly like a project with no symbols in that language. Every
 * path that can produce that outcome answers a code instead.
 *
 * @module plugin-codegraph/tests/languages
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUNDLED_LANGUAGE_IDS,
  GRAMMAR_BASE_URL,
  GRAMMAR_SHA512,
  LANGUAGES,
  downloadGrammar,
  grammarPath,
  installedGrammarFiles,
  languageForPath,
  languageStatuses,
  type GrammarPaths,
} from '../src/languages.ts'

const scratch: string[] = []

after(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDirs(): GrammarPaths {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-lang-'))
  scratch.push(root)
  return { bundledDir: join(root, 'bundled'), downloadDir: join(root, 'download') }
}

describe('languageForPath', () => {
  it('selects by extension, case-insensitively', () => {
    assert.equal(languageForPath('src/a.ts')?.id, 'typescript')
    assert.equal(languageForPath('SRC/A.TS')?.id, 'typescript')
    assert.equal(languageForPath('a.tsx')?.id, 'tsx')
    assert.equal(languageForPath('a.mjs')?.id, 'javascript')
    assert.equal(languageForPath('a.py')?.id, 'python')
    assert.equal(languageForPath('a.go')?.id, 'go')
    assert.equal(languageForPath('a.java')?.id, 'java')
    assert.equal(languageForPath('a.cs')?.id, 'c_sharp')
  })

  it('maps C and C++ to the grammars they are actually parsed with', () => {
    // C is parsed by the C++ grammar (the grammar set has no pure-C build), so
    // the two ids must not both resolve to a grammar that is not there.
    assert.equal(languageForPath('a.c')?.id, 'c')
    assert.equal(languageForPath('a.c')?.grammar, 'cpp')
    assert.equal(languageForPath('a.cpp')?.id, 'cpp')
    assert.equal(languageForPath('a.h')?.id, 'c')
    assert.equal(languageForPath('a.hpp')?.id, 'cpp')
  })

  it('answers undefined for a file this plugin ignores', () => {
    assert.equal(languageForPath('README'), undefined)
    assert.equal(languageForPath('data.bin'), undefined)
    assert.equal(languageForPath('.gitignore'), undefined)
  })

  it('never lets two languages claim the same extension', () => {
    // A collision would make selection depend on table order, which is the kind
    // of bug that only shows up on one machine.
    const seen = new Map<string, string>()
    for (const language of LANGUAGES) {
      for (const extension of language.extensions) {
        const owner = seen.get(extension)
        assert.equal(owner, undefined, `${extension} is claimed by both ${String(owner)} and ${language.id}`)
        seen.set(extension, language.id)
      }
    }
  })
})

describe('BUNDLED_LANGUAGE_IDS', () => {
  it('ships the common set, with C and C++ as two ids sharing one grammar file', () => {
    // Nine ids, eight grammar files: C and C++ are separate languages to a
    // reader and to `files.lang`, but the grammar set has no pure-C build, so
    // both parse through `cpp` (measured: a C file parses with no ERROR node).
    assert.deepEqual([...BUNDLED_LANGUAGE_IDS].sort(), [
      'c', 'c_sharp', 'cpp', 'go', 'java', 'javascript', 'python', 'tsx', 'typescript',
    ])
    const files = new Set(LANGUAGES.filter(l => l.bundled).map(l => l.grammar))
    assert.equal(files.size, 8, 'nine bundled ids resolve to eight grammar files')
    assert.equal(LANGUAGES.find(l => l.id === 'c')?.grammar, LANGUAGES.find(l => l.id === 'cpp')?.grammar)
  })

  it('marks exactly the bundled ones as bundled', () => {
    const bundled = LANGUAGES.filter(language => language.bundled).map(language => language.id)
    assert.deepEqual([...bundled].sort(), [...BUNDLED_LANGUAGE_IDS].sort())
  })
})

describe('grammarPath', () => {
  it('answers undefined for a language whose wasm is absent', () => {
    const paths = tempDirs()
    assert.equal(grammarPath(LANGUAGES[0]!, paths), undefined)
  })

  it('reads a bundled grammar only from the plugin, an on-demand one only from the download dir', () => {
    const paths = tempDirs()
    mkdirSync(paths.bundledDir, { recursive: true })
    mkdirSync(paths.downloadDir, { recursive: true })
    // Put a bundled grammar where a DOWNLOADED one would live: it must not be
    // picked up, or "not installed" would silently become "installed".
    const bundled = LANGUAGES.find(language => language.bundled)!
    writeFileSync(join(paths.downloadDir, `tree-sitter-${bundled.grammar}.wasm`), 'x')
    assert.equal(grammarPath(bundled, paths), undefined)
    writeFileSync(join(paths.bundledDir, `tree-sitter-${bundled.grammar}.wasm`), 'x')
    assert.notEqual(grammarPath(bundled, paths), undefined)
  })
})

describe('languageStatuses', () => {
  it('reports every language with its install state and size', () => {
    const paths = tempDirs()
    const statuses = languageStatuses(paths)
    assert.equal(statuses.length, LANGUAGES.length)
    assert.ok(statuses.every(status => status.installed === false && status.bytes === 0))
  })
})

describe('downloadGrammar', () => {
  it('refuses a bundled grammar it cannot find instead of downloading it', async () => {
    const paths = tempDirs()
    const bundled = LANGUAGES.find(language => language.bundled)!
    await assert.rejects(() => downloadGrammar(bundled, paths), /missing from the plugin/)
  })

  it('refuses to download a grammar with no recorded sha512', async () => {
    // The alternative is executing bytes nobody verified, so the refusal comes
    // before any network call. A synthetic spec stands in for a language added
    // to the table without its digest.
    const paths = tempDirs()
    const spec = { id: 'synthetic', grammar: 'no-such-grammar', label: 'Synthetic', extensions: ['.syn'], bundled: false }
    let called = false
    const fakeFetch = (async () => { called = true; return new Response('', { status: 200 }) }) as unknown as typeof fetch
    await assert.rejects(() => downloadGrammar(spec, paths, fakeFetch), /no recorded sha512/)
    assert.equal(called, false, 'the digest check must happen before the fetch')
  })

  it('rejects a response that is not a wasm module', async () => {
    const paths = tempDirs()
    const spec = LANGUAGES.find(language => language.bundled === false)!
    const fakeFetch = (async () => new Response('<html>not found</html>', { status: 200 })) as unknown as typeof fetch
    // Both the magic-byte check and the digest check can fire; either refusal is
    // correct, so the assertion is on the refusal, not its wording.
    await assert.rejects(() => downloadGrammar(spec, paths, fakeFetch))
    assert.equal(existsSync(join(paths.downloadDir, `tree-sitter-${spec.grammar}.wasm`)), false)
  })

  it('rejects a failed status with the status in the message', async () => {
    const paths = tempDirs()
    const spec = LANGUAGES.find(language => !language.bundled)!
    const fakeFetch = (async () => new Response('', { status: 503 })) as unknown as typeof fetch
    await assert.rejects(() => downloadGrammar(spec, paths, fakeFetch), /HTTP 503/)
  })

  it('rejects bytes whose sha512 does not match the recorded digest', async () => {
    // A well-formed wasm module that is not the one we pinned: the supply-chain
    // case the digest exists for.
    const paths = tempDirs()
    const spec = LANGUAGES.find(language => !language.bundled)!
    const wrongModule = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
    const fakeFetch = (async () => new Response(wrongModule, { status: 200 })) as unknown as typeof fetch
    await assert.rejects(() => downloadGrammar(spec, paths, fakeFetch), /sha512/)
    assert.equal(existsSync(join(paths.downloadDir, `tree-sitter-${spec.grammar}.wasm`)), false,
      'a failed digest must not leave a file that later looks installed')
  })

  it('records a digest for every downloadable grammar', () => {
    for (const spec of LANGUAGES.filter(language => !language.bundled)) {
      assert.ok(GRAMMAR_SHA512[spec.grammar] !== undefined,
        `${spec.id} is downloadable but has no recorded sha512, so downloadGrammar would always refuse it`)
    }
  })
})

describe('bundled grammars on disk', () => {
  it('ships every bundled grammar file the table names, plus the tree-sitter runtime', () => {
    // `pluginOutputGap` only checks entries under `lib/`, so a missing grammar
    // would ship as a warning plus one silently dead language. This asserts the
    // files are actually in the plugin.
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'grammars')
    const present = new Set(installedGrammarFiles(dir))
    for (const spec of LANGUAGES.filter(language => language.bundled)) {
      assert.ok(present.has(`tree-sitter-${spec.grammar}.wasm`),
        `${spec.id} is bundled but grammars/tree-sitter-${spec.grammar}.wasm is missing`)
    }
    // The runtime module `Parser.init()` loads; without it nothing parses.
    assert.ok(present.has('web-tree-sitter.wasm'), 'the tree-sitter runtime wasm must ship beside the grammars')
  })
})

describe('GRAMMAR_BASE_URL', () => {
  it('pins the exact grammar version this runtime was measured against', () => {
    // A floating version can bump the wasm ABI and stop loading — the failure
    // that ruled out the other grammar package.
    assert.match(GRAMMAR_BASE_URL, /@vscode\/tree-sitter-wasm@\d+\.\d+\.\d+\/wasm$/u)
  })
})
