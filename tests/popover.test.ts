import { describe, expect, it } from 'vitest'
import { clampPopoverLeft } from '../src/client.js'

describe('clampPopoverLeft', () => {
  it('锚点在视口内时原样返回', () => {
    expect(clampPopoverLeft(68, 1024)).toBe(68)
    expect(clampPopoverLeft(292, 1280)).toBe(292)
  })

  it('锚点会溢出右缘时钳到右留白', () => {
    expect(clampPopoverLeft(900, 1024)).toBe(1024 - 312)
  })

  it('正好压线时不钳', () => {
    expect(clampPopoverLeft(1024 - 312, 1024)).toBe(1024 - 312)
  })

  it('无锚点时回退 280 默认值（仍受钳制）', () => {
    expect(clampPopoverLeft(undefined, 1280)).toBe(280)
    expect(clampPopoverLeft(undefined, 400)).toBe(88)
  })

  it('极窄视口下不小于 8px', () => {
    expect(clampPopoverLeft(68, 300)).toBe(8)
    expect(clampPopoverLeft(280, 250)).toBe(8)
  })
})
