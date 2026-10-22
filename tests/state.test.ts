import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewayStateStore, loadGatewayState, pushDeliveryEntry, type DeliveryLogEntry } from '../src/state.js'

async function tempFile(name: string): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'wg-')), name)
}

describe('loadGatewayState', () => {
  it('文件不存在时返回空状态', async () => {
    const state = await loadGatewayState(await tempFile('missing.json'))
    expect(state.version).toBe(1)
    expect(state.chats).toEqual({})
    expect(state.seenMessageIds).toEqual([])
    expect(state.outbox).toEqual({})
    expect(state.protocol.updatesBuffer).toBe('')
  })

  it('GatewayStateStore 保存后可无损读回', async () => {
    const path = await tempFile('state.json')
    const store = new GatewayStateStore(path, await loadGatewayState(path))
    store.state.chats['chat-1'] = 'wechat-uuid-1'
    store.state.seenMessageIds = ['m1', 'm2']
    store.state.protocol = { updatesBuffer: 'buf-abc', contextTokens: { 'chat-1': 'tok' } }
    store.state.outbox['chat-1'] = { chunks: ['a', 'b'], files: ['x.pdf'], next: 1, nextFile: 0 }
    await store.save()
    const restored = await loadGatewayState(path)
    expect(restored.chats['chat-1']).toBe('wechat-uuid-1')
    expect(restored.seenMessageIds).toEqual(['m1', 'm2'])
    expect(restored.protocol.updatesBuffer).toBe('buf-abc')
    expect(restored.outbox['chat-1']).toEqual({ chunks: ['a', 'b'], files: ['x.pdf'], next: 1, nextFile: 0 })
  })

  it('串行 save：后一次快照覆盖前一次', async () => {
    const path = await tempFile('state.json')
    const store = new GatewayStateStore(path, await loadGatewayState(path))
    store.state.seenMessageIds = ['first']
    void store.save()
    store.state.seenMessageIds = ['second']
    await store.save()
    expect((await loadGatewayState(path)).seenMessageIds).toEqual(['second'])
  })

  it('credentialActivityAt / expiryWarnEnabled / credentialWarn 可无损读回', async () => {
    const path = await tempFile('state.json')
    const store = new GatewayStateStore(path, await loadGatewayState(path))
    store.state.credentialActivityAt = '2026-08-24T05:00:00.000Z'
    store.state.expiryWarnEnabled = false
    store.state.credentialWarn = { anchorAt: '2026-08-24T05:00:00.000Z', warnedAt: '2026-08-25T01:00:00.000Z' }
    await store.save()
    const restored = await loadGatewayState(path)
    expect(restored.credentialActivityAt).toBe('2026-08-24T05:00:00.000Z')
    expect(restored.expiryWarnEnabled).toBe(false)
    expect(restored.credentialWarn).toEqual({ anchorAt: '2026-08-24T05:00:00.000Z', warnedAt: '2026-08-25T01:00:00.000Z' })
  })

  it('旧版状态（无 deliveryLog 字段）加载后 deliveryLog 为空对象', async () => {
    const path = await tempFile('state.json')
    await writeFile(path, JSON.stringify({
      version: 1, chats: {}, seenMessageIds: [],
      protocol: { updatesBuffer: '', contextTokens: {} },
      outbox: {},
    }), { mode: 0o600 })
    const state = await loadGatewayState(path)
    expect(state.deliveryLog).toEqual({})
  })

  it('deliveryLog 可无损读回', async () => {
    const path = await tempFile('state.json')
    const store = new GatewayStateStore(path, await loadGatewayState(path))
    store.state.deliveryLog['chat-1'] = [{ at: '2026-10-22T00:00:00.000Z', outcome: 'delivered', chunks: 3 }]
    await store.save()
    const restored = await loadGatewayState(path)
    expect(restored.deliveryLog['chat-1']).toEqual([{ at: '2026-10-22T00:00:00.000Z', outcome: 'delivered', chunks: 3 }])
  })

  it('拒绝损坏的 deliveryLog', async () => {
    const path = await tempFile('state.json')
    await writeFile(path, JSON.stringify({
      version: 1, chats: {}, seenMessageIds: [],
      protocol: { updatesBuffer: '', contextTokens: {} },
      deliveryLog: { c: [{ at: 'x', outcome: 'boom', chunks: 0 }] },
    }), { mode: 0o600 })
    await expect(loadGatewayState(path)).rejects.toThrow(/deliveryLog/)
  })

  it('拒绝损坏的 credentialWarn', async () => {
    const path = await tempFile('state.json')
    await writeFile(path, JSON.stringify({
      version: 1, chats: {}, seenMessageIds: [],
      protocol: { updatesBuffer: '', contextTokens: {} },
      credentialWarn: { anchorAt: 1 },
    }), { mode: 0o600 })
    await expect(loadGatewayState(path)).rejects.toThrow(/credentialWarn/)
  })

  it('拒绝不支持的版本号', async () => {
    const path = await tempFile('state.json')
    await writeFile(path, JSON.stringify({ version: 99, chats: {}, seenMessageIds: [], protocol: { updatesBuffer: '', contextTokens: {} }, outbox: {} }), { mode: 0o600 })
    await expect(loadGatewayState(path)).rejects.toThrow(/版本/)
  })

  it('拒绝损坏的 outbox 游标', async () => {
    const path = await tempFile('state.json')
    await writeFile(path, JSON.stringify({
      version: 1, chats: {}, seenMessageIds: [],
      protocol: { updatesBuffer: '', contextTokens: {} },
      outbox: { c: { chunks: ['a'], files: [], next: 5, nextFile: 0 } },
    }), { mode: 0o600 })
    await expect(loadGatewayState(path)).rejects.toThrow(/outbox/)
  })

  it('拒绝非对象 JSON', async () => {
    const path = await tempFile('state.json')
    await writeFile(path, '[1,2,3]', { mode: 0o600 })
    await expect(loadGatewayState(path)).rejects.toThrow()
  })
})

describe('store.ts 私有文件权限', () => {
  it('写入的文件为格式化 JSON 且带换行', async () => {
    const { writePrivateJson } = await import('../src/store.js')
    const path = await tempFile('cred.json')
    await writePrivateJson(path, { token: 't' })
    const text = await readFile(path, 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(JSON.parse(text)).toEqual({ token: 't' })
  })
})

describe('pushDeliveryEntry', () => {
  it('新的条目插入头部', () => {
    const first = pushDeliveryEntry({}, 'c', { at: 't1', outcome: 'delivered', chunks: 1 })
    const second = pushDeliveryEntry(first, 'c', { at: 't2', outcome: 'deferred', chunks: 2 })
    expect(second['c']!.map(entry => entry.at)).toEqual(['t2', 't1'])
  })

  it('超过 20 条上限时淘汰最老条目', () => {
    let log: Record<string, DeliveryLogEntry[]> = {}
    for (let i = 0; i < 25; i += 1) {
      log = pushDeliveryEntry(log, 'c', { at: `t${i}`, outcome: 'delivered', chunks: 1 })
    }
    const entries = log['c']!
    expect(entries).toHaveLength(20)
    expect(entries[0]!.at).toBe('t24')
    expect(entries.at(-1)!.at).toBe('t5')
  })

  it('不改动传入的旧记录（不可变）', () => {
    const before: Record<string, DeliveryLogEntry[]> = { c: [{ at: 't1', outcome: 'delivered', chunks: 1 }] }
    pushDeliveryEntry(before, 'c', { at: 't2', outcome: 'failed', chunks: 0 })
    expect(before['c']).toHaveLength(1)
  })

  it('不同聊天互不影响', () => {
    let log = pushDeliveryEntry({}, 'a', { at: 't1', outcome: 'delivered', chunks: 1 })
    log = pushDeliveryEntry(log, 'b', { at: 't2', outcome: 'delivered', chunks: 1 })
    expect(log['a']).toHaveLength(1)
    expect(log['b']).toHaveLength(1)
  })
})
