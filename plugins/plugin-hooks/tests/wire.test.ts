/**
 * Wire tests: bridge validation, dialect→kernel mapping, toBridgeConfig.
 * @module plugin-hooks/tests/wire
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { KERNEL_PLUGIN, nextBridgeId, parseNativeRules, toBridgeConfig, validateBridge, HooksValidationError, type HooksBridge, type NativeRule } from '../src/wire.ts'

const VALID_CC = { dialect: 'claude-code', configPath: 'D:/proj/.claude/hooks.json' }
const VALID_CODEX = { dialect: 'codex', configPath: 'D:/proj/.codex/hooks.json', model: 'deepseek-v4' }

/**
 * The stable code a rejection carries. Assertions moved from matching the (now
 * client-side) sentence to the code, which is the contract the host half
 * actually owns.
 * @param run - the call expected to throw.
 * @returns the thrown code, or a marker describing what happened instead.
 */
function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return error instanceof HooksValidationError ? error.code : `not-a-validation-error:${String(error)}`
  }
  return 'no-error'
}

/** A native rule body, valid by default. */
function rule(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ rules: [{ on: 'pre-tool-use', action: 'block', message: 'x', ...overrides }] })
}

describe('validateBridge', () => {
  it('rejects a bad dialect, empty configPath, or missing/malformed id', () => {
    assert.throws(() => validateBridge({ ...VALID_CC, id: 'nope' }, new Set()), HooksValidationError)
    assert.throws(() => validateBridge({ ...VALID_CC, id: 'hook-1', dialect: 'wrong' }, new Set()), HooksValidationError)
    assert.throws(() => validateBridge({ id: 'hook-1', dialect: 'claude-code', configPath: '' }, new Set()), HooksValidationError)
    assert.throws(() => validateBridge({ id: 'hook-1', dialect: 'claude-code' }, new Set()), HooksValidationError)
    assert.equal(codeOf(() => validateBridge({ ...VALID_CC, id: 'nope' }, new Set())), 'bridge.badId')
    assert.equal(codeOf(() => validateBridge({ ...VALID_CC, id: 'hook-1', dialect: 'wrong' }, new Set())), 'dialect.invalid')
    assert.equal(codeOf(() => validateBridge({ id: 'hook-1', dialect: 'claude-code', configPath: '' }, new Set())), 'configPath.required')
    assert.equal(codeOf(() => validateBridge({ id: 'hook-1', dialect: 'claude-code' }, new Set())), 'configPath.required')
    assert.equal(codeOf(() => validateBridge(null, new Set())), 'bridge.notObject')
    assert.equal(codeOf(() => validateBridge({ id: 'hook-1', dialect: 'native', configSource: 'file', configPath: 'D:/x' }, new Set())), 'native.noExternalFile')
    assert.equal(codeOf(() => validateBridge({ id: 'hook-1', dialect: 'claude-code', configSource: 'other', configPath: 'D:/x' }, new Set())), 'configSource.invalid')
    assert.equal(codeOf(() => validateBridge({ id: 'hook-1', dialect: 'claude-code', configSource: 'inline', configContent: '  ' }, new Set())), 'config.inlineEmpty')
  })

  it('rejects a duplicate id and a non-positive numeric field', () => {
    assert.throws(() => validateBridge({ ...VALID_CC, id: 'hook-1' }, new Set(['hook-1'])), HooksValidationError)
    assert.throws(() => validateBridge({ ...VALID_CC, id: 'hook-1', defaultTimeoutMs: -1 }, new Set()), HooksValidationError)
    assert.equal(codeOf(() => validateBridge({ ...VALID_CC, id: 'hook-1' }, new Set(['hook-1']))), 'bridge.badId')
    assert.equal(codeOf(() => validateBridge({ ...VALID_CC, id: 'hook-1', defaultTimeoutMs: -1 }, new Set())), 'field.notPositive')
    assert.throws(
      () => validateBridge({ ...VALID_CC, id: 'hook-1', defaultTimeoutMs: -1 }, new Set()),
      (error: unknown) => error instanceof HooksValidationError && error.params?.field === 'defaultTimeoutMs',
    )
  })

  it('accepts model on codex only; other dialects carrying one are rejected', () => {
    const codex = validateBridge({ ...VALID_CODEX, id: 'hook-1' }, new Set())
    assert.equal(codex.model, 'deepseek-v4')
    assert.throws(() => validateBridge({ ...VALID_CC, id: 'hook-1', model: 'deepseek-v4' }, new Set()), HooksValidationError)
    assert.throws(() => validateBridge({ id: 'hook-1', dialect: 'native', configSource: 'inline', configContent: '{}', model: 'deepseek-v4' }, new Set()), HooksValidationError)
    assert.equal(codeOf(() => validateBridge({ ...VALID_CC, id: 'hook-1', model: 'deepseek-v4' }, new Set())), 'model.codexOnly')
    assert.equal(codeOf(() => validateBridge({ id: 'hook-1', dialect: 'native', configSource: 'inline', configContent: '{}', model: 'deepseek-v4' }, new Set())), 'model.codexOnly')
  })

  it('accepts a valid claude-code bridge and normalizes enabled to true by default', () => {
    const b = validateBridge({ ...VALID_CC, id: 'hook-1' }, new Set())
    assert.equal(b.enabled, true)
    assert.equal(b.dialect, 'claude-code')
    assert.equal(b.configPath, 'D:/proj/.claude/hooks.json')
  })
})

describe('nextBridgeId', () => {
  it('continues the monotonic sequence', () => {
    assert.equal(nextBridgeId([{ id: 'hook-3' } as HooksBridge, { id: 'hook-1' } as HooksBridge]), 'hook-4')
    assert.equal(nextBridgeId([]), 'hook-1')
  })
})

describe('toBridgeConfig', () => {
  it('maps a claude-code bridge with pluginRoot and projectDir', () => {
    const config = toBridgeConfig({ id: 'hook-1', dialect: 'claude-code', enabled: true, configPath: 'D:/x', pluginRoot: 'D:/plugins', projectDir: 'D:/proj', defaultTimeoutMs: 600000 })
    assert.equal(config.configPath, 'D:/x')
    assert.equal(config.pluginRoot, 'D:/plugins')
    assert.equal(config.projectDir, 'D:/proj')
    assert.equal(config.defaultTimeoutMs, 600000)
    assert.equal(config.model, undefined)
  })

  it('maps a codex bridge with model and no pluginRoot', () => {
    const config = toBridgeConfig({ id: 'hook-2', dialect: 'codex', enabled: true, configPath: 'D:/y', model: 'deepseek-v4', stderrSummaryMaxChars: 500 })
    assert.equal(config.configPath, 'D:/y')
    assert.equal(config.model, 'deepseek-v4')
    assert.equal(config.stderrSummaryMaxChars, 500)
    assert.equal(config.pluginRoot, undefined)
  })

  it('maps to the right kernel plugin name per dialect', () => {
    assert.equal(KERNEL_PLUGIN['claude-code'], '@deepseek-ai/dsh-hooks-claude-code')
    assert.equal(KERNEL_PLUGIN['codex'], '@deepseek-ai/dsh-hooks-codex')
  })
})

describe('parseNativeRules', () => {
  it('parses a valid rules array', () => {
    const rules = parseNativeRules(JSON.stringify({
      rules: [
        { name: 'block-writes', on: 'pre-tool-use', matcher: 'write|edit', action: 'block', message: '禁止修改' },
        { name: 'reminder', on: 'prompt-submit', action: 'context', message: '记得提交规范' },
      ],
    }))
    assert.equal(rules.length, 2)
    assert.equal(rules[0]?.on, 'pre-tool-use')
    assert.equal(rules[1]?.action, 'context')
  })

  it('rejects bad JSON, empty rules, and unsupported event/action combos', () => {
    assert.throws(() => parseNativeRules('{not json'), HooksValidationError)
    assert.throws(() => parseNativeRules('[]'), HooksValidationError)
    assert.throws(() => parseNativeRules('{}'), HooksValidationError)
    assert.throws(() => parseNativeRules('{"rules":[]}'), HooksValidationError)
    assert.throws(() => parseNativeRules('{"rules":[{"on":"pre-tool-use","action":"context","message":"x"}]}'), HooksValidationError)
    assert.throws(() => parseNativeRules('{"rules":[{"on":"session-start","action":"block","message":"x"}]}'), HooksValidationError)
    assert.throws(() => parseNativeRules('{"rules":[{"on":"bad-event","action":"block","message":"x"}]}'), HooksValidationError)
    assert.equal(codeOf(() => parseNativeRules('{not json')), 'native.jsonParseFailed')
    assert.equal(codeOf(() => parseNativeRules('[]')), 'native.notObject')
    assert.equal(codeOf(() => parseNativeRules('{}')), 'native.rulesRequired')
    assert.equal(codeOf(() => parseNativeRules('{"rules":[]}')), 'native.rulesRequired')
    assert.equal(codeOf(() => parseNativeRules('{"rules":[{"on":"pre-tool-use","action":"context","message":"x"}]}')), 'native.actionUnsupported')
    assert.equal(codeOf(() => parseNativeRules('{"rules":[{"on":"session-start","action":"block","message":"x"}]}')), 'native.actionUnsupported')
    assert.equal(codeOf(() => parseNativeRules('{"rules":[{"on":"bad-event","action":"block","message":"x"}]}')), 'native.onInvalid')
  })

  it('rejects missing message and bad regex', () => {
    assert.throws(() => parseNativeRules('{"rules":[{"on":"pre-tool-use","action":"block"}]}'), HooksValidationError)
    assert.throws(() => parseNativeRules('{"rules":[{"on":"pre-tool-use","action":"block","message":"x","matcher":"[invalid"}]}'), HooksValidationError)
    assert.equal(codeOf(() => parseNativeRules(rule())), 'no-error')
    assert.equal(codeOf(() => parseNativeRules('{"rules":[{"on":"pre-tool-use","action":"block"}]}')), 'native.messageRequired')
    assert.equal(codeOf(() => parseNativeRules(rule({ matcher: '[invalid' }))), 'native.matcherInvalid')
    assert.equal(codeOf(() => parseNativeRules(rule({ matcher: '' }))), 'native.matcherRequired')
    assert.equal(codeOf(() => parseNativeRules('{"rules":[1]}')), 'native.ruleNotObject')
  })

  it('carries the rule label and name as params, so no sentence is assembled host-side', () => {
    assert.throws(
      () => parseNativeRules(rule({ name: 'block-writes', action: 'context' })),
      (error: unknown) => error instanceof HooksValidationError
        && error.code === 'native.actionUnsupported'
        && error.params?.label === 'rules[0]'
        && error.params?.name === 'block-writes'
        && error.params?.on === 'pre-tool-use'
        && error.params?.action === 'context',
    )
  })

  it('defaults name to the index label when absent', () => {
    const rules = parseNativeRules('{"rules":[{"on":"pre-tool-use","action":"block","message":"x"}]}')
    assert.equal(rules[0]?.name, 'rules[0]')
  })
})
