import { describe, expect, it } from 'vitest'
import { resolveDeliveryTarget } from '../src/index.js'

describe('resolveDeliveryTarget', () => {
  const chats = { 'chat-1': 'wechat-uuid-1', 'chat-2': 'wechat-uuid-2' }

  it('内存映射命中：快路径，非恢复', () => {
    expect(resolveDeliveryTarget({ mappedChatId: 'chat-1', chats, sessionKey: 'wechat-uuid-1' })).toEqual({ chatId: 'chat-1', recovered: false })
  })

  it('内存映射缺失但持久映射命中：恢复路径', () => {
    expect(resolveDeliveryTarget({ mappedChatId: undefined, chats, sessionKey: 'wechat-uuid-2' })).toEqual({ chatId: 'chat-2', recovered: true })
  })

  it('两个映射都缺失的非微信会话：undefined（正常路径，不投递不记日志）', () => {
    expect(resolveDeliveryTarget({ mappedChatId: undefined, chats, sessionKey: 'other-session' })).toBeUndefined()
  })

  it('两个映射都缺失的网关会话：skipped（曾绑定但失联）', () => {
    expect(resolveDeliveryTarget({ mappedChatId: undefined, chats, sessionKey: 'wechat-uuid-gone' })).toBe('skipped')
  })

  it('空持久映射时网关会话同样 skipped，非微信会话 undefined', () => {
    expect(resolveDeliveryTarget({ mappedChatId: undefined, chats: {}, sessionKey: 'wechat-uuid-x' })).toBe('skipped')
    expect(resolveDeliveryTarget({ mappedChatId: undefined, chats: {}, sessionKey: 'web-xyz' })).toBeUndefined()
  })
})
