/**
 * Single-file components, read through the mask.
 *
 * The contract has two halves and both are checked against real syntax: the mask keeps a
 * file's line structure (a symbol at line 9 of a component must be reported at 9, not at
 * 4, or the source slice a tool returns points at markup), and the script that survives
 * parses with the TypeScript grammar the plugin already ships. Nothing here needs a
 * `tree-sitter-vue`: a container grammar would only find the tags this module finds with
 * a scan.
 *
 * @module plugin-codegraph/tests/sfc
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { grammarPath, LANGUAGES } from '../src/languages.ts'
import { textForParse } from '../src/sfc.ts'
import { parseFile } from '../src/tree-sitter.ts'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const grammarDir = join(pluginRoot, 'grammars')
const paths = { bundledDir: grammarDir, downloadDir: grammarDir }

/** Parse text the way the plugin's parser wrapper does: mask, then the shipped grammar. */
async function parseComponent(source: string, languageId = 'vue') {
  const text = textForParse(source, languageId)
  assert.ok(text !== undefined, 'a component with a script block must produce text to parse')
  const spec = LANGUAGES.find(language => language.id === languageId)
  assert.ok(spec !== undefined)
  const grammar = grammarPath(spec, paths)
  assert.ok(grammar !== undefined, `${languageId} resolves to a grammar the plugin ships`)
  return await parseFile(grammar, join(grammarDir, 'web-tree-sitter.wasm'), text, `a.${languageId}`, languageId)
}

describe('textForParse', () => {
  it('leaves a file that is not a component untouched', () => {
    const source = 'export function plain(): number { return 1 }\n'
    assert.equal(textForParse(source, 'typescript'), source, 'same string, no copy')
  })

  it('answers nothing for a component with no script block', () => {
    // A template-only component declares nothing. Parsing its markup as JavaScript would
    // be worse than useless: it reports syntax errors that are not the user's.
    assert.equal(textForParse('<template><div>hi</div></template>\n', 'vue'), undefined)
  })

  it('keeps the file’s line count, so a symbol’s line is the line in the file', async () => {
    const source = [
      '<template>',
      '  <button @click="save">{{ label }}</button>',
      '</template>',
      '',
      '<script setup lang="ts">',
      'export function save(): void {',
      '  persist()',
      '}',
      '</script>',
      '',
      '<style scoped>',
      '.b { color: red }',
      '</style>',
    ].join('\n')
    const masked = textForParse(source, 'vue')
    assert.ok(masked !== undefined)
    assert.equal(masked.split('\n').length, source.split('\n').length, 'same number of lines')

    const parsed = await parseComponent(source)
    const save = parsed.symbols.find(symbol => symbol.name === 'save')
    assert.ok(save !== undefined, 'the function declared in the script block is a symbol')
    assert.equal(save.line, 6, 'line 6 of the COMPONENT, which is where a reader will look')
    assert.deepEqual(parsed.calls.map(call => call.name), ['persist'], 'calls inside the block are recorded')
    assert.equal(parsed.symbols.some(symbol => symbol.name === 'b'), false, 'the stylesheet names no symbol')
  })

  it('keeps both script blocks a Vue component may carry', async () => {
    const source = [
      '<script lang="ts">',
      'export const shared = 1',
      '</script>',
      '<script setup lang="ts">',
      'export function useIt(): number { return shared }',
      '</script>',
    ].join('\n')
    const parsed = await parseComponent(source)
    assert.deepEqual(parsed.symbols.map(symbol => symbol.name).sort(), ['shared', 'useIt'])
  })

  it('is not shifted by a character outside the BMP above the script', async () => {
    // The mask indexes by UTF-16 code unit because the offsets come from regex indices.
    // A spread would have iterated code POINTS, and one emoji in the template would have
    // moved every character after it — the symbols would still appear, at wrong lines.
    const source = [
      '<template><p>🍜</p></template>',
      '<script lang="ts">',
      'export const noodle = 1',
      '</script>',
    ].join('\n')
    const parsed = await parseComponent(source)
    assert.deepEqual(parsed.symbols.map(symbol => `${symbol.name}:${String(symbol.line)}`), ['noodle:3'])
  })

  it('reads a Svelte component the same way', async () => {
    const source = [
      '<script lang="ts">',
      'export function run(): void { go() }',
      '</script>',
      '<main>{run()}</main>',
    ].join('\n')
    const parsed = await parseComponent(source, 'svelte')
    assert.deepEqual(parsed.symbols.map(symbol => symbol.name), ['run'])
    assert.deepEqual(parsed.calls.map(call => call.name), ['go'])
  })
})

describe('the language table', () => {
  it('maps both extensions to a language the plugin bundles', () => {
    for (const [path, id] of [['a.vue', 'vue'], ['a.svelte', 'svelte']] as const) {
      const spec = LANGUAGES.find(language => language.extensions.includes(path.slice(path.lastIndexOf('.'))))
      assert.equal(spec?.id, id)
      assert.equal(spec?.bundled, true, 'a component language ships with the plugin')
      assert.equal(spec?.grammar, 'typescript', 'and reuses the TypeScript grammar rather than shipping a container one')
    }
  })
})
