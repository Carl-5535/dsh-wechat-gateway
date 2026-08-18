import { describe, expect, it } from 'vitest'
import { isAllowed } from '../src/index.js'
import type { Config } from '../src/index.js'
import type { InboundMessage } from '../src/ilink.js'

function config(overrides: Partial<Config> = {}): Config {
  return {
    tokenEnv: 'WECHAT_BOT_TOKEN',
    credentialPath: '/tmp/a.json',
    statePath: '/tmp/s.json',
    apiBase: '',
    cdnBase: 'https://novac2c.cdn.weixin.qq.com/c2c',
    workspace: '/tmp',
    mediaDir: '',
    allowedUsers: [],
    allowedGroups: [],
    retryDelayMs: 100,
    emptyPollDelayMs: 10,
    maxMessageChars: 3_500,
    maxMediaBytes: 1024,
    ...overrides,
  }
}

function directMessage(userId: string): InboundMessage {
  return { id: '1', chatId: userId, userId, group: false, text: 'hi', media: [], mediaErrors: [] }
}

function groupMessage(userId: string, roomId: string): InboundMessage {
  return { id: '2', chatId: roomId, userId, group: true, text: 'hi', media: [], mediaErrors: [] }
}

describe('isAllowed 白名单（默认拒绝）', () => {
  it('白名单为空时任何人都不放行', () => {
    expect(isAllowed(directMessage('u1'), config())).toBe(false)
  })

  it('单聊：发送者在 allowedUsers 即放行', () => {
    const allowed = config({ allowedUsers: ['u1', 'u2'] })
    expect(isAllowed(directMessage('u1'), allowed)).toBe(true)
    expect(isAllowed(directMessage('u3'), allowed)).toBe(false)
  })

  it('群聊：群与发送者都必须在白名单', () => {
    const allowed = config({ allowedUsers: ['u1'], allowedGroups: ['room1'] })
    expect(isAllowed(groupMessage('u1', 'room1'), allowed)).toBe(true)
    expect(isAllowed(groupMessage('u1', 'room2'), allowed)).toBe(false)
    expect(isAllowed(groupMessage('u2', 'room1'), allowed)).toBe(false)
  })

  it('仅配置群白名单、没配用户白名单时不放行', () => {
    const allowed = config({ allowedGroups: ['room1'] })
    expect(isAllowed(groupMessage('u1', 'room1'), allowed)).toBe(false)
  })
})
