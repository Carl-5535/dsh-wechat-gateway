/**
 * 对 DSH 公共服务契约的轻量适配：构造 UserMessage、固定会话模型选择。
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** 把生成的 id 标注为 DSH 会话 id。 */
export function sessionId(value: string): SessionId {
  return value as SessionId
}

/** 构造纯文本用户消息。 */
export function textUserMessage(text: string): UserMessage {
  return contentUserMessage([{ type: 'text', text }])
}

/** 构造含文本/图片块的不可变用户消息。 */
export function contentUserMessage(content: UserMessage['content']): UserMessage {
  return Object.freeze({
    id: randomUUID() as UserMessage['id'],
    role: 'user',
    content: Object.freeze(content.map(block => Object.freeze(block))),
    source: Object.freeze({ kind: 'user' }),
  }) as unknown as UserMessage
}

/**
 * 把「网关启动时的模型选择」固定到新会话：
 * - system-prompt/assemble：注入插件提示段与 provider/model 变量；
 * - agent/request：覆盖每次模型调用的 provider/model。
 * 用户在 Web UI 里切换全局模型后，新开的聊天会跟随新选择。
 */
export function installSelection(agentCtx: Context, selection: ModelSelectionRef, extraInstructions?: string): () => void {
  const disposeAssembly = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const selected = selection.current
    const assembled = await next()
    selection.assembled = selected
    if (selected === undefined) return assembled
    return {
      ...assembled,
      sections: extraInstructions === undefined
        ? assembled.sections
        : [...assembled.sections, { name: 'wechat-gateway:delivery', text: extraInstructions }],
      variables: { ...assembled.variables, provider: selected.provider, model: selected.model },
    }
  })
  const disposeRequest = agentCtx.on('agent/request', async (_payload, next): Promise<LlmCallConfig> => {
    const resolved = await next()
    const selected = selection.assembled
    if (selected === undefined) return resolved
    const { reasoningEffort: _inherited, ...withoutInherited } = resolved
    return {
      ...withoutInherited,
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    }
  })
  return () => {
    disposeAssembly()
    disposeRequest()
  }
}
