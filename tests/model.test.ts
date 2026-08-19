import { describe, expect, it } from 'vitest'
import { matchModelEntry, type ModelEntry } from '../src/index.js'

const catalog: ModelEntry[] = [
  { provider: 'deepseek', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { provider: 'deepseek', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  { provider: 'glm', id: 'glm-5', name: 'GLM-5' },
]

describe('matchModelEntry', () => {
  it('序号（从 1 起）', () => {
    expect(matchModelEntry(catalog, '1')).toBe(catalog[0])
    expect(matchModelEntry(catalog, '3')).toBe(catalog[2])
    expect(matchModelEntry(catalog, '99')).toBeUndefined()
  })

  it('provider/model 精确匹配（忽略大小写）', () => {
    expect(matchModelEntry(catalog, 'glm/glm-5')).toBe(catalog[2])
    expect(matchModelEntry(catalog, 'DeepSeek/DeepSeek-V4-Pro')).toBe(catalog[0])
    expect(matchModelEntry(catalog, 'glm/wrong')).toBeUndefined()
  })

  it('模型 id 忽略大小写', () => {
    expect(matchModelEntry(catalog, 'GLM-5')).toBe(catalog[2])
    expect(matchModelEntry(catalog, 'deepseek-v4-flash')).toBe(catalog[1])
  })

  it('唯一名称匹配', () => {
    expect(matchModelEntry(catalog, 'GLM-5 '.trim())).toBe(catalog[2])
    expect(matchModelEntry(catalog, 'DeepSeek V4 Pro')).toBe(catalog[0])
  })

  it('歧义名称返回 multiple（构造同名场景）', () => {
    const duplicated: ModelEntry[] = [
      { provider: 'a', id: 'x-1', name: '同名' },
      { provider: 'b', id: 'x-2', name: '同名' },
    ]
    expect(matchModelEntry(duplicated, '同名')).toBe('multiple')
  })

  it('空输入与未知输入', () => {
    expect(matchModelEntry(catalog, '')).toBeUndefined()
    expect(matchModelEntry(catalog, '  ')).toBeUndefined()
    expect(matchModelEntry(catalog, '不存在的模型')).toBeUndefined()
  })
})
