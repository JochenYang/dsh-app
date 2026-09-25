/**
 * Client render tests for the coded host messages: a known code renders this
 * page's zh copy (pinned byte-for-byte), an unknown one falls back to the
 * host's English diagnostic, a nested code inside a param slot resolves to its
 * own copy, and none of them ever renders blank.
 *
 * @module plugin-presets/tests/client
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { hostMessage } from '../src/client/messages.ts'
import { zh } from '../src/client/locales.ts'

/**
 * The page's `t` seat, reduced to the zh dictionary with `{name}`
 * interpolation — the same contract the locale runtime implements.
 * @param dict - the dictionary to read.
 * @returns the stand-in translate function.
 */
function seat(dict: Readonly<Record<string, string>>): Parameters<typeof hostMessage>[1] {
  return ((key: string, params?: Record<string, unknown>) =>
    String(dict[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`))
  ) as unknown as Parameters<typeof hostMessage>[1]
}

const t = seat(zh)

describe('hostMessage (presets)', () => {
  it('renders a known code from the zh dictionary, byte-identical to the pre-i18n sentence', () => {
    assert.equal(
      hostMessage({ code: 'preset.unknownEntry', params: { entry: 'demo' } }, t),
      '预设「demo」不存在，或不是可导出的自定义预设（内置预设不可导出）',
    )
    assert.equal(
      hostMessage({ code: 'preset.duplicateMember', params: { name: 'preset/a.txt' } }, t),
      '预设包含重复的成员名「preset/a.txt」，已拒绝',
    )
    assert.equal(
      hostMessage({ code: 'backup.secretContent', params: { rel: 'profile/cordis.patch.yml', rule: 'api-key' } }, t),
      '配置文件「profile/cordis.patch.yml」命中疑似凭据内容（规则 api-key）',
    )
    assert.equal(hostMessage({ code: 'route.presetTooLarge', params: { mb: 10 } }, t), '预设包超过 10MB 上限')
  })

  it('interpolates every value the sentence names, so no raw {param} can reach the screen', () => {
    assert.equal(
      hostMessage({ code: 'preset.importTooManyFiles', params: { count: 420, cap: 200 } }, t),
      '预设包含 420 个文件，超过单包 200 个的上限，已拒绝',
    )
    assert.equal(
      hostMessage({ code: 'preset.manifestVersion', params: { version: '2', supported: '1' } }, t),
      '预设包格式版本不支持（formatVersion=2，当前支持 1）',
    )
    assert.equal(
      hostMessage({ code: 'preset.exportTooLarge', params: { mb: 20 } }, t),
      '预设总大小超过 20MB 上限，无法导出',
    )
  })

  it('resolves a nested code in a param slot into that code\'s own copy', () => {
    // The outer sentences wrap an inner rejection reason and the archive a
    // message is about; both travel as codes, never as prose.
    assert.equal(
      hostMessage({ code: 'preset.illegalPath', params: { path: 'C:/evil', reason: 'path.absolute' } }, t),
      '预设包内存在不允许的路径「C:/evil」：路径是绝对路径，已拒绝',
    )
    assert.equal(
      hostMessage({ code: 'preset.manifestEntryInvalid', params: { reason: 'entry.pattern' } }, t),
      'manifest.json 中的预设名不合法：预设名只能使用小写字母、数字以及短横线 -，以字母或数字开头，最长 64 个字符',
    )
    assert.equal(
      hostMessage({ code: 'zip.sizeMismatch', params: { subject: 'subject.backup', name: 'profile/cordis.patch.yml' } }, t),
      '配置备份成员「profile/cordis.patch.yml」的实际内容与声明不符，已拒绝',
    )
    assert.equal(
      hostMessage({ code: 'zip.corrupt', params: { subject: 'subject.preset' } }, t),
      '无法解压预设包：ZIP 数据损坏',
    )
    assert.equal(
      hostMessage({ code: 'preset.readDirFailed', params: { code: 'error.unknown' } }, t),
      '读取预设目录失败（未知错误）',
    )
    assert.equal(
      hostMessage({ code: 'preset.readDirFailed', params: { code: 'EPERM' } }, t),
      '读取预设目录失败（EPERM）',
      'an OS error code is not a dictionary code and rides through verbatim',
    )
  })

  it('falls back to the host English diagnostic for a code this build does not know', () => {
    assert.equal(
      hostMessage({ code: 'preset.futureCode', text: 'the preset could not be read: EBUSY' }, t),
      'the preset could not be read: EBUSY',
    )
    // The conflict codes deliberately have no copy here: any 409 opens this
    // page's own overwrite dialog instead of rendering the message.
    assert.equal(
      hostMessage({ code: 'preset.conflict', params: { entry: 'demo' }, text: 'preset "demo" already exists' }, t),
      'preset "demo" already exists',
    )
    // The fence codes carry an English diagnostic only.
    assert.equal(hostMessage({ code: 'route.crossOrigin', text: 'cross-origin request' }, t), 'cross-origin request')
  })

  it('never renders blank: the caller\'s line, the host diagnostic, then nothing at all', () => {
    assert.equal(hostMessage({ code: 'future.code' }, t, '导入失败'), '导入失败')
    assert.equal(hostMessage({ code: 'future.code', text: 'the package could not be read' }, t, '导入失败'),
      'the package could not be read')
    assert.equal(hostMessage(undefined, t, '请求失败'), '请求失败')
  })
})
