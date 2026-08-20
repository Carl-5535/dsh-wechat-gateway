import { describe, expect, it } from 'vitest'
import { matchPresetName, parseApprovalReply } from '../src/index.js'

describe('parseApprovalReply 审批答复解析', () => {
  it('认可词 → allowed-once', () => {
    for (const text of ['同意', '允许', '批准', '好', '好的', 'Yes', 'Y', 'ok', 'OK', '1', ' 同意 ']) {
      expect(parseApprovalReply(text)).toBe('allowed-once')
    }
  })

  it('拒绝词 → rejected', () => {
    for (const text of ['拒绝', '不同意', '不允许', '不要', '否', '不', 'No', 'N', '0', ' no ']) {
      expect(parseApprovalReply(text)).toBe('rejected')
    }
  })

  it('转交词 → web', () => {
    for (const text of ['网页', 'web', 'WEB', '转网页', ' 网页 ']) {
      expect(parseApprovalReply(text)).toBe('web')
    }
  })

  it('普通内容与空文本 → undefined', () => {
    for (const text of ['', '  ', '帮我看下这个文件', '同意吗', 'ok吧', 'n2', '12', '网页端']) {
      expect(parseApprovalReply(text)).toBeUndefined()
    }
  })
})

describe('matchPresetName 权限模式匹配', () => {
  const names = ['workspace-write', 'danger-full-access']

  it('序号（从 1 起）', () => {
    expect(matchPresetName(names, '1')).toBe('workspace-write')
    expect(matchPresetName(names, '2')).toBe('danger-full-access')
    expect(matchPresetName(names, '3')).toBeUndefined()
  })

  it('完整名称忽略大小写', () => {
    expect(matchPresetName(names, 'workspace-write')).toBe('workspace-write')
    expect(matchPresetName(names, 'Danger-Full-Access')).toBe('danger-full-access')
  })

  it('内置中文别名', () => {
    expect(matchPresetName(names, '安全')).toBe('workspace-write')
    expect(matchPresetName(names, '保守')).toBe('workspace-write')
    expect(matchPresetName(names, '完全')).toBe('danger-full-access')
    expect(matchPresetName(names, '全开')).toBe('danger-full-access')
  })

  it('唯一前缀匹配', () => {
    expect(matchPresetName(names, 'work')).toBe('workspace-write')
    expect(matchPresetName(names, 'danger')).toBe('danger-full-access')
  })

  it('歧义前缀返回 multiple', () => {
    expect(matchPresetName(['write-a', 'write-b'], 'write')).toBe('multiple')
  })

  it('别名仅在预设存在时生效', () => {
    expect(matchPresetName(['danger-full-access'], '安全')).toBeUndefined()
  })

  it('空输入与未知输入', () => {
    expect(matchPresetName(names, '')).toBeUndefined()
    expect(matchPresetName(names, '  ')).toBeUndefined()
    expect(matchPresetName(names, '不存在的模式')).toBeUndefined()
  })
})
