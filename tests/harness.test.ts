import { describe, expect, it } from 'vitest'
import { installSelection } from '../src/harness.js'
import type { ModelSelectionRef } from '../src/dsh-agent.js'

/** 最小 agentCtx 桩：记录 waterfall 监听器，供测试手动驱动。 */
function fakeAgentCtx(): { on: (event: string, listener: (...args: any[]) => any) => () => void, handlers: Record<string, (...args: any[]) => any> } {
  const handlers: Record<string, (...args: any[]) => any> = {}
  return {
    on: (event, listener) => {
      handlers[event] = listener
      return () => undefined
    },
    handlers,
  }
}

describe('installSelection 热切换', () => {
  it('切换 selection.current 后，agent/request 跟随新模型（而非组装快照）', async () => {
    const ctx = fakeAgentCtx()
    const ref: ModelSelectionRef = { current: { provider: 'a', model: 'glm-5' }, assembled: undefined }
    installSelection(ctx as never, ref)
    // 先完成一次系统提示词组装（快照记录为 glm-5）
    await ctx.handlers['system-prompt/assemble']!({}, {}, async () => ({ sections: [], variables: {} }))
    expect(ref.assembled).toMatchObject({ provider: 'a', model: 'glm-5' })
    // /model 热切换
    ref.current = { provider: 'b', model: 'SkyCoder-Pro' }
    const config = await ctx.handlers['agent/request']!({}, async () => ({ provider: 'x', model: 'y', maxTokens: 4096 }))
    expect(config).toMatchObject({ provider: 'b', model: 'SkyCoder-Pro', maxTokens: 4096 })
  })

  it('切换会同步 assembled，供后续消费方读取一致视图', async () => {
    const ctx = fakeAgentCtx()
    const ref: ModelSelectionRef = { current: { provider: 'a', model: 'm1' }, assembled: undefined }
    installSelection(ctx as never, ref)
    ref.current = { provider: 'c', model: 'm2' }
    await ctx.handlers['agent/request']!({}, async () => ({ provider: 'x', model: 'y' }))
    expect(ref.assembled).toMatchObject({ provider: 'c', model: 'm2' })
  })
})
