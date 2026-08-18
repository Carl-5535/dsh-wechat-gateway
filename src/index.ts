/**
 * dsh-wechat-gateway —— DeepSeek Harness 进程内微信插件。
 *
 * 把个人微信变成 DSH Agent 的远程入口：微信消息在 Host 进程内直接驱动
 * Agent 会话（每个聊天一个持久会话），回复经持久化发件箱分块送回微信。
 *
 * 安全模型：默认拒绝。未配置白名单时仅响应登录账号本人；
 * 群聊必须同时配置 allowedGroups 与 allowedUsers 才会处理。
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, AgentHandle, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { SessionEvent, JsonValue } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ILinkClient, type InboundMessage } from './ilink.js'
import { defaultCredentialPath, pathExists, readCredential } from './store.js'
import { defaultStatePath, GatewayStateStore, loadGatewayState } from './state.js'
import { contentUserMessage, installSelection, sessionId } from './harness.js'
import { extractFileDirectives, resolveWorkspaceFile, saveInboundMedia, splitText } from './media.js'
import { mountLoginRoute } from './web-login.js'

/** Cordis 插件名（稳定标识）。 */
export const name = 'wechat-gateway'

/** 网关需要注入的 DSH 服务。 */
export const inject = ['agentDefaultModel', 'agentPresets', 'agents', 'permissionPresets', 'sessions', 'sessionTitle', 'tools']

export interface Config {
  tokenEnv: string
  credentialPath: string
  statePath: string
  accountId?: string
  apiBase: string
  cdnBase: string
  workspace: string
  mediaDir: string
  allowedUsers: string[]
  allowedGroups: string[]
  retryDelayMs: number
  emptyPollDelayMs: number
  maxMessageChars: number
  maxMediaBytes: number
}

export const Config: z<Config> = z.object({
  tokenEnv: z.string().default('WECHAT_BOT_TOKEN'),
  credentialPath: z.string().default(defaultCredentialPath()),
  statePath: z.string().default(defaultStatePath()),
  accountId: z.string(),
  apiBase: z.string().default(''),
  cdnBase: z.string().default('https://novac2c.cdn.weixin.qq.com/c2c'),
  workspace: z.string().default(homedir()),
  mediaDir: z.string().default(''),
  allowedUsers: z.array(String).default([]),
  allowedGroups: z.array(String).default([]),
  retryDelayMs: z.number().min(100).default(5_000),
  emptyPollDelayMs: z.number().min(10).default(250),
  maxMessageChars: z.number().min(100).max(10_000).default(3_500),
  maxMediaBytes: z.number().min(1_024).max(512 * 1024 * 1024).default(100 * 1024 * 1024),
})

/** 白名单判定：单聊需发送者在 allowedUsers；群聊还需群在 allowedGroups。 */
export function isAllowed(message: InboundMessage, config: Config): boolean {
  return message.group
    ? config.allowedGroups.includes(message.chatId) && config.allowedUsers.includes(message.userId)
    : config.allowedUsers.includes(message.userId)
}

/** 从事件流中收集 seq 之后最后一条助手文本。 */
export function assistantText(events: readonly SessionEvent[], afterSeq: number): { text: string; seq: number } {
  let text = ''
  let seq = afterSeq
  for (const event of events) {
    if (event.seq <= afterSeq) continue
    seq = Math.max(seq, event.seq)
    if (event.type !== 'assistant/message') continue
    text = event.data.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
  }
  return { text, seq }
}

interface ChatState {
  handle: AgentHandle
  sentThroughSeq: number
  delivery: Promise<void>
  typing: Promise<void>
}

interface AgentPresetService {
  mount(agentCtx: Context): Promise<unknown>
}

interface PermissionPresetService {
  set(session: Agent['session'], name: string): void
}

interface SessionTitleService {
  rename(session: Agent['session'], title: string): unknown
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

const HELP_TEXT = [
  '我是运行在这台机器上的 DeepSeek Harness (DSH) 助手，直接发消息即可。',
  '命令：',
  '  /help 或 /帮助 —— 查看本说明',
  '  /status 或 /状态 —— 查看会话状态',
  '  /stop 或 /停止 —— 中止当前任务',
  '  /new 或 /新会话 —— 开启全新会话（丢弃当前上下文）',
  '发给我的图片/文件会保存到工作区；我可以用 [[send-file:路径]] 把工作区文件发回给你。',
].join('\n')

class WechatGateway {
  readonly #ctx: Context
  readonly #config: Config
  readonly #client: ILinkClient
  readonly #store: GatewayStateStore
  readonly #abort = new AbortController()
  readonly #chats = new Map<string, ChatState>()
  readonly #agentChats = new Map<Agent, string>()
  readonly #seen: Set<string>
  /** 登录账号（扫码人）的 chatId，主动推送的目标。 */
  readonly #ownerChatId: string | undefined

  constructor(ctx: Context, config: Config, connection: { token: string; accountId?: string; apiBase: string; ownerChatId?: string }, store: GatewayStateStore) {
    this.#ctx = ctx
    this.#config = config
    this.#store = store
    this.#seen = new Set(store.state.seenMessageIds)
    this.#ownerChatId = connection.ownerChatId
    this.#client = new ILinkClient({
      ...connection,
      state: store.state.protocol,
      onStateChange: async (state) => {
        store.state.protocol = state
        await store.save()
      },
      cdnBase: config.cdnBase,
      maxMediaBytes: config.maxMediaBytes,
    })
  }

  /** 供 wechat_notify 工具调用：把文本主动推送到登录账号的微信。 */
  async notifyOwner(text: string, signal?: AbortSignal): Promise<void> {
    if (this.#ownerChatId === undefined) throw new Error('未记录登录账号的微信 id（可能使用环境变量 token 启动），无法主动推送')
    for (const chunk of splitText(text, this.#config.maxMessageChars)) {
      await this.#sendWithRetry(this.#ownerChatId, chunk, signal)
    }
  }

  start(): void {
    // Agent 被释放（如 Web UI 关闭会话）时清理内存映射；
    // 持久映射保留，下一条消息会 resume 既有会话。
    this.#ctx.on('agent/disposed', ({ agent }) => {
      const chatId = this.#agentChats.get(agent)
      if (chatId === undefined) return
      this.#agentChats.delete(agent)
      const state = this.#chats.get(chatId)
      if (state?.handle.agent === agent) this.#chats.delete(chatId)
    })
    // 每轮结束：把助手回复送回微信（串行排队，防止交错）。
    this.#ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      const agent = this.#ctx.agents.get(session.id)
      if (agent === undefined) return
      const chatId = this.#agentChats.get(agent)
      if (chatId === undefined) return
      const state = this.#chats.get(chatId)
      if (state === undefined) return
      state.delivery = state.delivery
        .then(async () => {
          await this.#ctx.sessions.flush(session)
          await this.#deliver(chatId, state)
        })
        .catch((error: unknown) => {
          if (!this.#abort.signal.aborted) this.#log(`投递失败: ${error instanceof Error ? error.message : String(error)}`)
        })
    })
    void this.#startLoop().catch((error: unknown) => {
      if (!this.#abort.signal.aborted) this.#log(`网关停止: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  async #startLoop(): Promise<void> {
    await this.#drainStoredOutbox()
    await this.#pollLoop()
  }

  async dispose(): Promise<void> {
    this.#abort.abort()
    await Promise.all([...this.#chats.values()].map(async state => { await state.handle.dispose() }))
  }

  #log(message: string): void {
    process.stderr.write(`wechat-gateway: ${message}\n`)
  }

  /** 回合结束 → 提取回复 → 写入持久化发件箱 → 尽力送完。 */
  async #deliver(chatId: string, state: ChatState): Promise<void> {
    await state.typing
    void this.#client.sendTyping(chatId, false, this.#abort.signal).catch(() => undefined)
    const output = assistantText(state.handle.agent.session.events, state.sentThroughSeq)
    if (output.text === '') {
      state.sentThroughSeq = output.seq
      return
    }
    const delivery = extractFileDirectives(output.text)
    const chunks = delivery.text === '' ? [] : splitText(delivery.text, this.#config.maxMessageChars)
    this.#store.state.outbox[chatId] = { chunks, files: delivery.files, next: 0, nextFile: 0 }
    await this.#store.save()
    await this.#drainOutbox(chatId)
    // 全部送达才推进 sentThroughSeq：中途崩溃重启后会重发该轮回复，
    // 代价是极端情况下的重复消息，换来绝不丢失。
    if (!this.#abort.signal.aborted && this.#store.state.outbox[chatId] === undefined) state.sentThroughSeq = output.seq
  }

  async #drainStoredOutbox(): Promise<void> {
    for (const chatId of Object.keys(this.#store.state.outbox)) {
      if (this.#abort.signal.aborted) return
      await this.#drainOutbox(chatId)
    }
  }

  async #drainOutbox(chatId: string): Promise<void> {
    const item = this.#store.state.outbox[chatId]
    if (item === undefined) return
    while (item.next < item.chunks.length && !this.#abort.signal.aborted) {
      await this.#sendWithRetry(chatId, item.chunks[item.next]!)
      if (this.#abort.signal.aborted) return
      item.next += 1
      await this.#store.save()
    }
    while (item.nextFile < item.files.length && !this.#abort.signal.aborted) {
      const requested = item.files[item.nextFile]!
      try {
        const file = await resolveWorkspaceFile(this.#config.workspace, requested, this.#config.maxMediaBytes)
        await this.#sendMediaWithRetry(chatId, file.name, file.bytes)
      } catch (error) {
        if (this.#abort.signal.aborted) return
        this.#log(`拒绝外发文件 ${JSON.stringify(requested)}: ${error instanceof Error ? error.message : String(error)}`)
        await this.#sendWithRetry(chatId, `无法发送文件 ${JSON.stringify(requested)}：它不存在、不在工作区内或超过大小限制。`)
      }
      if (this.#abort.signal.aborted) return
      item.nextFile += 1
      await this.#store.save()
    }
    if (item.next === item.chunks.length && item.nextFile === item.files.length) {
      delete this.#store.state.outbox[chatId]
      await this.#store.save()
    }
  }

  async #sendMediaWithRetry(chatId: string, name: string, data: Uint8Array): Promise<void> {
    while (!this.#abort.signal.aborted) {
      try {
        await this.#client.sendMedia(chatId, name, data, this.#abort.signal)
        return
      } catch (error) {
        if (this.#abort.signal.aborted) return
        this.#log(`媒体发送失败，重试中: ${error instanceof Error ? error.message : String(error)}`)
        await sleep(this.#config.retryDelayMs, this.#abort.signal)
      }
    }
  }

  async #sendWithRetry(chatId: string, text: string, signal?: AbortSignal): Promise<void> {
    // 工具取消信号与网关停止信号任一触发即停止重试。
    const requestSignal = signal === undefined ? this.#abort.signal : AbortSignal.any([this.#abort.signal, signal])
    const cancelled = (): boolean => this.#abort.signal.aborted || signal?.aborted === true
    while (!cancelled()) {
      try {
        await this.#client.sendText(chatId, text, requestSignal)
        return
      } catch (error) {
        if (cancelled()) return
        this.#log(`发送失败，重试中: ${error instanceof Error ? error.message : String(error)}`)
        await sleep(this.#config.retryDelayMs, requestSignal)
      }
    }
  }

  async #pollLoop(): Promise<void> {
    while (!this.#abort.signal.aborted) {
      try {
        const messages = await this.#client.poll(this.#abort.signal)
        for (const message of messages) await this.#receive(message)
        if (messages.length === 0) await sleep(this.#config.emptyPollDelayMs, this.#abort.signal)
      } catch (error) {
        if (this.#abort.signal.aborted) return
        this.#log(`${error instanceof Error ? error.message : String(error)}`)
        await sleep(this.#config.retryDelayMs, this.#abort.signal)
      }
    }
  }

  async #receive(message: InboundMessage): Promise<void> {
    // 去重：iLink 在重连/游标回退时可能重推同一条消息。
    if (message.id !== '' && this.#seen.has(message.id)) return
    if (message.id !== '') {
      this.#seen.add(message.id)
      // 有界去重表：超限淘汰最老条目。
      if (this.#seen.size > 2_000) this.#seen.delete(this.#seen.values().next().value!)
      this.#store.state.seenMessageIds = [...this.#seen]
      await this.#store.save()
    }
    if (!isAllowed(message, this.#config)) return
    const command = message.text.trim().toLowerCase()
    if (command === '/help' || command === '/帮助') {
      await this.#sendWithRetry(message.chatId, HELP_TEXT)
      return
    }
    if (command === '/status' || command === '/状态') {
      const state = this.#chats.get(message.chatId)
      await this.#sendWithRetry(message.chatId, state === undefined ? '当前没有活跃的 DSH 会话。' : `DSH 会话状态：${state.handle.agent.status}。`)
      return
    }
    if (command === '/stop' || command === '/停止') {
      this.#chats.get(message.chatId)?.handle.agent.cancel({ kind: 'user' })
      await this.#sendWithRetry(message.chatId, '已请求中止当前任务。')
      return
    }
    if (command === '/new' || command === '/新会话') {
      await this.#dropChat(message.chatId)
      await this.#sendWithRetry(message.chatId, '已开启新会话，下一条消息将从头开始。')
      return
    }
    const state = await this.#chat(message.chatId)
    const blocks: Parameters<typeof contentUserMessage>[0] = []
    if (message.text !== '') blocks.push({ type: 'text', text: message.text })
    const paths: string[] = []
    const mediaRoot = this.#config.mediaDir || `${this.#config.workspace}/.wechat-gateway/inbox`
    for (const media of message.media) {
      const path = await saveInboundMedia(mediaRoot, message.chatId, media)
      paths.push(path)
      // 图片类附件同时走 DSH 附件服务，模型可直接看图。
      if (media.kind === 'image') {
        const attachments = this.#ctx.get('attachments')
        if (attachments !== undefined && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(media.mediaType)) {
          try {
            const attachment = await attachments.saveImage({ data: media.data, mediaType: media.mediaType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', name: media.name })
            blocks.push({ type: 'image', attachment })
          } catch (error) {
            this.#log(`图片附件入库失败，回退为本地文件: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
    }
    if (message.mediaErrors.length > 0) blocks.push({ type: 'text', text: `部分微信附件接收失败：\n${message.mediaErrors.map(error => `- ${error}`).join('\n')}` })
    if (paths.length > 0) blocks.push({ type: 'text', text: `微信附件已保存到工作区：\n${paths.map(path => `- ${path}`).join('\n')}` })
    state.typing = this.#client.sendTyping(message.chatId, true, this.#abort.signal).catch(() => undefined)
    state.handle.agent.followup(contentUserMessage(blocks))
  }

  /** 取得（或恢复）一个聊天对应的 Agent 会话。 */
  async #chat(chatId: string): Promise<ChatState> {
    const existing = this.#chats.get(chatId)
    if (existing !== undefined) return existing
    const selection = this.#ctx.agentDefaultModel.currentSelection()
    const setup = async (agentCtx: Context): Promise<void> => {
      const agentPresets = this.#ctx.get('agentPresets') as AgentPresetService | undefined
      if (agentPresets === undefined) throw new Error('wechat-gateway: agentPresets 服务不可用')
      await agentPresets.mount(agentCtx)
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
      installSelection(agentCtx, selected, [
        '本会话与一个微信聊天相连，同时可在 Harness Web UI 中查看。',
        '从微信收到的文件保存在工作区内，用户消息中会列出绝对路径。',
        '要把工作区文件发回微信，在最终回复中单独一行写指令：[[send-file:relative/or/absolute/path]]。',
        '仅当用户明确要求或确有必要时才请求发送文件；该指令会从送达微信的文本中移除。',
        '回复将原样送达微信（纯文本），避免使用依赖渲染的复杂 Markdown 表格。',
        '你的回复会自动送达微信，无需对本会话调用 wechat_notify；该工具供其他会话主动推送使用。',
      ].join('\n'))
    }
    const persistedSession = this.#store.state.chats[chatId]
    let handle: AgentHandle
    if (persistedSession !== undefined) {
      const active = this.#ctx.agents.get(sessionId(persistedSession))
      if (active !== undefined) {
        // 会话已被 Web UI 等其他持有者打开：附着但不持有销毁权，
        // /new 与插件卸载不得摧毁他方拥有的会话。
        handle = { agent: active, dispose: () => Promise.resolve() }
      } else {
        try {
          handle = await this.#ctx.agents.resume({
            resumeSessionId: sessionId(persistedSession),
            agentOptions: { provider: selection.provider, model: selection.model },
            setup,
          })
        } catch (error) {
          this.#log(`无法恢复会话 ${persistedSession}，改为新建: ${error instanceof Error ? error.message : String(error)}`)
          delete this.#store.state.chats[chatId]
          handle = await this.#createAgent(selection, setup)
        }
      }
    } else {
      handle = await this.#createAgent(selection, setup)
    }
    const state = { handle, sentThroughSeq: handle.agent.session.seq, delivery: Promise.resolve(), typing: Promise.resolve() }
    const permissionPresets = this.#ctx.get('permissionPresets') as PermissionPresetService | undefined
    if (permissionPresets === undefined) throw new Error('wechat-gateway: permissionPresets 服务不可用')
    permissionPresets.set(handle.agent.session, 'workspace-write')
    const sessionTitle = this.#ctx.get('sessionTitle') as SessionTitleService | undefined
    if (sessionTitle === undefined) throw new Error('wechat-gateway: sessionTitle 服务不可用')
    sessionTitle.rename(handle.agent.session, '微信')
    this.#chats.set(chatId, state)
    this.#agentChats.set(handle.agent, chatId)
    this.#store.state.chats[chatId] = handle.agent.id
    await this.#store.save()
    return state
  }

  async #createAgent(selection: { provider: string; model: string }, setup: (agentCtx: Context) => Promise<void>): Promise<AgentHandle> {
    return await this.#ctx.agents.create({
      sessionId: sessionId(`wechat-${randomUUID()}`),
      meta: { cwd: this.#config.workspace },
      agentOptions: selection,
      setup,
    })
  }

  async #dropChat(chatId: string): Promise<void> {
    const state = this.#chats.get(chatId)
    delete this.#store.state.chats[chatId]
    await this.#store.save()
    if (state === undefined) return
    this.#chats.delete(chatId)
    this.#agentChats.delete(state.handle.agent)
    await state.handle.dispose()
  }
}

/** Cordis 插件入口：挂登录路由、按凭据启动网关。 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  let gateway: WechatGateway | undefined
  let gatewayAccount: string | undefined
  const startGateway = async (): Promise<void> => {
    if (gateway !== undefined) return
    const environmentToken = process.env[config.tokenEnv]?.trim()
    const credential = await (pathExists(config.credentialPath).then(async exists => exists ? await readCredential(config.credentialPath) : undefined))
    const token = environmentToken || credential?.token
    // 白名单默认只放行登录账号本人。
    const allowedUsers = config.allowedUsers.length > 0
      ? config.allowedUsers
      : credential?.userId === undefined || credential.userId === '' ? [] : [credential.userId]
    if (token === undefined || token === '' || allowedUsers.length === 0) return
    gateway = new WechatGateway(ctx, { ...config, allowedUsers }, {
      token,
      accountId: config.accountId ?? credential?.accountId,
      apiBase: config.apiBase || credential?.apiBase || 'https://ilinkai.weixin.qq.com',
      ownerChatId: credential?.userId,
    }, new GatewayStateStore(config.statePath, await loadGatewayState(config.statePath)))
    gatewayAccount = credential?.accountId
    gateway.start()
  }
  const restartGateway = async (): Promise<void> => {
    await gateway?.dispose()
    gateway = undefined
    await startGateway()
  }
  // 全局注册 wechat_notify：任何 Agent 会话（Web UI 或微信）都可主动推送。
  ctx.tools.register(defineTool({
    name: 'wechat_notify',
    description: '主动推送一条文本消息到用户的微信（本机 DeepSeek Harness 微信通道的登录账号）。'
      + '适用场景：长任务的关键进展/完成通知、定时或后台任务的结果汇报、需要用户及时知晓或决策的提醒。'
      + '仅在微信网关已登录时可用；返回未登录错误时，请提示用户在 DSH 侧边栏底部的微信入口扫码连接。'
      + '不要用它替代正常的会话回复。',
    parameters: {
      text: { type: 'string', required: true, description: '要推送的消息文本（纯文本，可多行）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args: unknown, value: JsonValue) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 60_000,
    async execute(args: { text: string }, exec: ToolRunContext): Promise<JsonValue> {
      if (args.text.trim() === '') throw new Error('text 必须是非空字符串')
      if (gateway === undefined) throw new Error('微信未登录：请在 DSH 侧边栏底部的「微信」入口扫码连接后再试')
      await gateway.notifyOwner(args.text, exec.signal)
      return { ok: true, channel: 'wechat' }
    },
  }))
  mountLoginRoute(ctx, {
    credentialPath: config.credentialPath,
    apiBase: config.apiBase || undefined,
    onCredential: restartGateway,
    connected: () => ({ connected: gateway !== undefined, account: gatewayAccount }),
  })
  await startGateway()
  if (gateway === undefined) process.stderr.write('wechat-gateway: 尚未登录微信。在 Harness Web UI 打开 /wechat-gateway/login 扫码，或运行 npx dsh-wechat-gateway login。\n')
  ctx.effect(() => async () => { await gateway?.dispose() })
}

export { ILinkClient } from './ilink.js'
export type { InboundMessage, ILinkState, ILinkClientOptions } from './ilink.js'
