import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewayStateStore, loadGatewayState } from '../src/state.js'

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
