import { describe, expect, it } from 'vitest'
import { CREDENTIAL_TTL_MS, credentialAnchorAt, expiryStatus, formatExpiryWarning, formatRemaining } from '../src/index.js'

const HOUR = 3_600_000

describe('credentialAnchorAt', () => {
  it('活动时间晚于凭据落盘时间时以活动时间为准（收信续期）', () => {
    expect(credentialAnchorAt('2026-08-24T00:00:00.000Z', '2026-08-24T05:00:00.000Z')).toBe('2026-08-24T05:00:00.000Z')
  })

  it('活动时间早于本凭据落盘时间时作废（换号重登沿用旧状态文件）', () => {
    expect(credentialAnchorAt('2026-08-25T00:00:00.000Z', '2026-08-24T05:00:00.000Z')).toBe('2026-08-25T00:00:00.000Z')
  })

  it('任一侧缺失时回退另一侧', () => {
    expect(credentialAnchorAt(undefined, '2026-08-24T05:00:00.000Z')).toBe('2026-08-24T05:00:00.000Z')
    expect(credentialAnchorAt('2026-08-24T00:00:00.000Z', undefined)).toBe('2026-08-24T00:00:00.000Z')
    expect(credentialAnchorAt(undefined, undefined)).toBeUndefined()
  })
})

describe('expiryStatus', () => {
  it('savedAt 缺失或无法解析时返回 undefined', () => {
    expect(expiryStatus(undefined, 0, 4 * HOUR)).toBeUndefined()
    expect(expiryStatus('not-a-date', 0, 4 * HOUR)).toBeUndefined()
  })

  it('按 savedAt + 24 小时推算过期时刻', () => {
    const savedAt = '2026-08-24T08:00:00.000Z'
    const now = Date.parse('2026-08-24T12:00:00.000Z')
    const status = expiryStatus(savedAt, now, 4 * HOUR)
    expect(status?.expiresAt).toBe(Date.parse(savedAt) + CREDENTIAL_TTL_MS)
    expect(status?.remainingMs).toBe(20 * HOUR)
    expect(status?.shouldWarn).toBe(false)
  })

  it('剩余不足预警窗口时 shouldWarn 为 true（含恰好等于窗口边界）', () => {
    const savedAt = '2026-08-24T00:00:00.000Z'
    expect(expiryStatus(savedAt, Date.parse('2026-08-24T20:30:00.000Z'), 4 * HOUR)?.shouldWarn).toBe(true)
    expect(expiryStatus(savedAt, Date.parse('2026-08-24T20:00:00.000Z'), 4 * HOUR)?.shouldWarn).toBe(true)
  })

  it('已过期不再预警', () => {
    const savedAt = '2026-08-24T00:00:00.000Z'
    const status = expiryStatus(savedAt, Date.parse('2026-08-25T01:00:00.000Z'), 4 * HOUR)
    expect(status?.remainingMs).toBeLessThan(0)
    expect(status?.shouldWarn).toBe(false)
  })

  it('lead 为 0 时永不预警（关闭开关）', () => {
    const savedAt = '2026-08-24T00:00:00.000Z'
    expect(expiryStatus(savedAt, Date.parse('2026-08-24T23:59:00.000Z'), 0)?.shouldWarn).toBe(false)
  })
})

describe('formatRemaining', () => {
  it('10 小时以内保留一位小数，以上取整', () => {
    expect(formatRemaining(3.5 * HOUR)).toBe('约 3.5 小时')
    expect(formatRemaining(20 * HOUR)).toBe('约 20 小时')
  })

  it('不足 1 小时按分钟向上取整，至少 1 分钟', () => {
    expect(formatRemaining(40 * 60_000)).toBe('约 40 分钟')
    expect(formatRemaining(5_000)).toBe('约 1 分钟')
  })
})

describe('formatExpiryWarning', () => {
  it('包含剩余时长与保活指引，不误导为需要重扫', () => {
    const savedAt = '2026-08-24T00:00:00.000Z'
    const status = expiryStatus(savedAt, Date.parse('2026-08-24T20:00:00.000Z'), 4 * HOUR)
    expect(status).toBeDefined()
    const text = formatExpiryWarning(status!)
    expect(text).toContain('约 4 小时')
    expect(text).toContain('过期')
    expect(text).toContain('不影响登录')
    expect(text).toContain('发一条消息')
    expect(text).not.toContain('无法收发')
  })
})
