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
import type {} from '@deepseek-ai/dsh-llm'
import type { ApprovalRequest, ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ILinkClient, type InboundMessage } from './ilink.js'
import { defaultCredentialPath, pathExists, readCredential } from './store.js'
import { defaultStatePath, GatewayStateStore, loadGatewayState } from './state.js'
import { contentUserMessage, installSelection, sessionId } from './harness.js'
import { extractFileDirectives, resolveWorkspaceFile, saveInboundMedia, splitText, detectLocalFilePaths } from './media.js'
import { mountLoginRoute } from './web-login.js'

/** Cordis 插件名（稳定标识）。 */
export const name = 'wechat-gateway'

/** 网关需要注入的 DSH 服务。 */
export const inject = ['agentDefaultModel', 'agentPresets', 'agents', 'llm', 'permissionPresets', 'sessions', 'sessionTitle', 'tools']

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
  /** 回复正文提及的工作区内文件是否自动回发（显式 [[send-file]] 不受此开关影响）。 */
  autoSendMentionedFiles: boolean
}

/**
 * 解析 WECHAT_AUTO_SEND_FILES：未设置时返回 undefined（走 schema 默认开启）；
 * 设为 0/false/off/no（忽略大小写）关闭，其余任意值开启。
 */
function autoSendFromEnv(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  return !/^(0|false|off|no)$/i.test(raw.trim())
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
  autoSendMentionedFiles: z.boolean().default(autoSendFromEnv(process.env.WECHAT_AUTO_SEND_FILES) ?? true),
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
  /** 本聊天的活模型选择引用：改 current 即热切换，下一轮生效。 */
  selectionRef: ModelSelectionRef
  sentThroughSeq: number
  delivery: Promise<void>
  typing: Promise<void>
}

/** 一条送达微信、等待答复的审批请求。 */
interface PendingApproval {
  toolName: string
  reason?: string
  settle: (action: ApprovalReplyAction) => void
}

/** 本地模型目录的一个条目（provider + 模型）。 */
export interface ModelEntry {
  provider: string
  id: string
  name: string
}

/**
 * /model 的选择匹配：序号（从 1 起）、「provider/model」、模型 id（忽略大小写）
 * 或唯一匹配的模型名。返回 undefined 表示没有匹配，multiple 表示名称歧义。
 */
export function matchModelEntry(catalog: readonly ModelEntry[], input: string, ): ModelEntry | 'multiple' | undefined {
  const query = input.trim()
  if (query === '') return undefined
  if (/^\d+$/.test(query)) {
    const index = Number(query) - 1
    return catalog[index]
  }
  const slash = query.split('/')
  if (slash.length === 2) {
    const [provider, id] = slash.map(part => part.trim().toLowerCase())
    return catalog.find(entry => entry.provider.toLowerCase() === provider && entry.id.toLowerCase() === id)
  }
  const byId = catalog.filter(entry => entry.id.toLowerCase() === query.toLowerCase())
  if (byId.length === 1) return byId[0]
  if (byId.length > 1) return 'multiple'
  const byName = catalog.filter(entry => entry.name.toLowerCase() === query.toLowerCase())
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) return 'multiple'
  return undefined
}

interface AgentPresetService {
  mount(agentCtx: Context): Promise<unknown>
}

/** permissionPresets 服务暴露的预设选项（客户端渲染用）。 */
export interface PresetOption {
  value: string
  name: string
  description?: string
}

/** permissionPresets 服务的一个预设捆绑（沙箱模式 + 审批策略）。 */
export interface PresetSpec {
  sandbox: string
  approval: 'ask' | 'never'
  name?: string
  description?: string
}

/** dsh-permission-presets 的服务面（本地最小声明，与官方 rc 类型结构一致）。 */
export interface PermissionPresetService {
  /** 预设表声明顺序的全部可切换预设名。 */
  readonly names: readonly string[]
  /** 新会话的默认预设。 */
  readonly defaultPreset: string
  /** 从会话事件折叠出实际生效的预设（含派生的 'custom'）。 */
  current(events: readonly SessionEvent[]): string
  /** 解析预设的旋钮捆绑；未知名称抛错。 */
  resolve(name: string): PresetSpec
  /** 构建某个预设（或 'custom'）的展示选项；未知名称抛错。 */
  optionOf(name: string): PresetOption
  /** 切换预设：记录意图事件并经各旋钮规范 setter 写入。 */
  set(session: Agent['session'], name: string): void
}

/** 微信里对审批请求的一条答复动作：放行/驳回，或转交网页端。 */
export type ApprovalReplyAction = ApprovalOutcome | 'web'

/** 触发同意的答复词（小写比较，中文原样）。 */
const APPROVAL_YES_WORDS = new Set(['同意', '允许', '批准', '好', '好的', '同意执行', 'yes', 'y', 'ok', '1'])
/** 触发拒绝的答复词。 */
const APPROVAL_NO_WORDS = new Set(['拒绝', '不同意', '不允许', '不要', '否', '不', 'no', 'n', '0'])
/** 触发转交网页端审批面板的答复词。 */
const APPROVAL_WEB_WORDS = new Set(['网页', 'web', '转网页'])

/**
 * 解析微信里对审批请求的答复：认可词 → 'allowed-once'，拒绝词 → 'rejected'，
 * 转交词 → 'web'，其他内容（含空文本）→ undefined（按普通消息处理）。
 */
export function parseApprovalReply(text: string): ApprovalReplyAction | undefined {
  const normalized = text.trim().toLowerCase()
  if (normalized === '') return undefined
  if (APPROVAL_YES_WORDS.has(normalized)) return 'allowed-once'
  if (APPROVAL_NO_WORDS.has(normalized)) return 'rejected'
  if (APPROVAL_WEB_WORDS.has(normalized)) return 'web'
  return undefined
}

/** 内置预设的中文别名（仅当该预设存在于表中时生效）。 */
const PRESET_ALIASES: Record<string, readonly string[]> = {
  'workspace-write': ['保守', '安全', '写工作区'],
  'danger-full-access': ['完全', '全开', '放开', '危险', '完全访问'],
}

/**
 * /permission 的预设匹配：序号（从 1 起）、完整名称（忽略大小写）、内置中文别名
 * 或唯一前缀。返回 undefined 表示没有匹配，multiple 表示歧义。
 */
export function matchPresetName(names: readonly string[], input: string): string | 'multiple' | undefined {
  const query = input.trim()
  if (query === '') return undefined
  if (/^\d+$/.test(query)) return names[Number(query) - 1]
  const lower = query.toLowerCase()
  const exact = names.find(name => name.toLowerCase() === lower)
  if (exact !== undefined) return exact
  const alias = names.find(name => (PRESET_ALIASES[name] ?? []).includes(query))
  if (alias !== undefined) return alias
  const byPrefix = names.filter(name => name.toLowerCase().startsWith(lower))
  if (byPrefix.length === 1) return byPrefix[0]
  if (byPrefix.length > 1) return 'multiple'
  return undefined
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
  '  /model 或 /模型 —— 查看可用模型；/model 序号或模型id 切换（仅本聊天生效）',
  '  /permission 或 /权限 —— 查看权限模式；/permission 序号或名称切换（仅本聊天生效）',
  '发给我的图片/文件会保存到工作区；我可以用 [[send-file:路径]] 把工作区文件发回给你。',
  '当我请求越权操作时会推送审批请求：回复「同意」或「拒绝」处理，回复「网页」转到网页端审批面板。',
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
  /** 本地模型目录缓存（30 秒 TTL，避免连续 /model 反复询问 provider）。 */
  #catalog?: { at: number; models: ModelEntry[] }
  /** 通道健康度：连续轮询失败 3 次即判失效（凭据过期/断网），成功即恢复。 */
  #consecutiveFailures = 0
  #channelHealthy = true
  /** 每聊天当前等待微信答复的审批（一次最多一条；后续请求排队投递）。 */
  readonly #pendingApprovals = new Map<string, PendingApproval>()
  /** 每聊天的审批问题投递链：串行化多个并发审批的微信提问。 */
  readonly #approvalAskChain = new Map<string, Promise<void>>()
  /** start() 注册的 ctx 监听器注销函数（重新扫码重启网关时清理，避免残留）。 */
  readonly #listeners: Array<() => void> = []

  /** 通道当前是否可用（供连接状态展示与 wechat_notify 前置检查）。 */
  get channelHealthy(): boolean {
    return this.#channelHealthy
  }

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
    if (!this.#channelHealthy) throw new Error('微信连接已失效（凭据过期或网络中断）：请重新扫码后再试')
    for (const chunk of splitText(text, this.#config.maxMessageChars)) {
      await this.#sendWithRetry(this.#ownerChatId, chunk, signal)
    }
  }

  start(): void {
    // Agent 被释放（如 Web UI 关闭会话）时清理内存映射；
    // 持久映射保留，下一条消息会 resume 既有会话。
    this.#listeners.push(this.#ctx.on('agent/disposed', ({ agent }) => {
      const chatId = this.#agentChats.get(agent)
      if (chatId === undefined) return
      this.#agentChats.delete(agent)
      const state = this.#chats.get(chatId)
      if (state?.handle.agent === agent) this.#chats.delete(chatId)
    }))
    // 每轮结束：把助手回复送回微信（串行排队，防止交错）。
    this.#listeners.push(this.#ctx.on('session/event', (session, event) => {
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
    }))
    // 审批应答（waterfall，prepend 保证 OUTER）：微信绑定的 Agent 发起审批时
    // 问题先只发微信（串行）；回复「网页」或通道失效再转交 Web UI 面板，避免
    // 面板显示后从他处结算导致僵死。其余 Agent 的请求原样透传。
    this.#listeners.push(this.#ctx.on('approval/request', async (req, next) => {
      const chatId = this.#agentChats.get(req.agent)
      if (chatId === undefined || !this.#channelHealthy) return await next()
      return await this.#approvalViaWechat(chatId, req, next)
    }, true))
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
    for (const dispose of this.#listeners.splice(0)) dispose()
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
    const mentioned = this.#config.autoSendMentionedFiles ? await this.#collectMentionedFiles(delivery.text, delivery.files) : []
    this.#store.state.outbox[chatId] = { chunks, files: [...delivery.files, ...mentioned], next: 0, nextFile: 0 }
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

  /**
   * 收集回复正文提及、可自动回发的本地文件：只保留存在、位于工作区内且
   * 未超限的路径（提及≠指令，越界/缺失静默跳过），单条回复最多 5 个防刷屏。
   */
  async #collectMentionedFiles(text: string, explicit: readonly string[]): Promise<string[]> {
    const explicitSet = new Set(explicit.map(path => path.toLowerCase()))
    const found: string[] = []
    for (const path of detectLocalFilePaths(text)) {
      if (found.length >= 5) break
      const key = path.toLowerCase()
      if (explicitSet.has(key) || found.some(existing => existing.toLowerCase() === key)) continue
      try {
        await resolveWorkspaceFile(this.#config.workspace, path, this.#config.maxMediaBytes)
        found.push(path)
      } catch {
        // 提及的路径不存在、不在工作区内或超限：不视为发送请求，静默跳过
        this.#log(`跳过正文提及的文件 ${path}（不存在、不在工作区内或超过大小限制）`)
      }
    }
    return found
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

  /** 枚举本地已配置 provider 的模型目录（带 TTL 缓存；单个 provider 失败跳过）。 */
  async #modelCatalog(): Promise<ModelEntry[]> {
    if (this.#catalog !== undefined && Date.now() - this.#catalog.at < 30_000) return this.#catalog.models
    const models: ModelEntry[] = []
    for (const provider of this.#ctx.llm.listProviders()) {
      try {
        for (const model of await this.#ctx.llm.listModels(provider.id)) {
          models.push({ provider: model.provider, id: model.id, name: model.name })
        }
      } catch {
        // 目录是 advisory 的：某个 provider 查询失败只影响列表完整度
      }
    }
    this.#catalog = { at: Date.now(), models }
    return models
  }

  /** /model：无参列出本地可用模型并标记当前项；带参切换本聊天的模型。 */
  async #modelCommand(chatId: string, rest: string): Promise<void> {
    const state = this.#chats.get(chatId)
    const current = state?.selectionRef.current ?? this.#ctx.agentDefaultModel.currentSelection()
    if (rest === '') {
      const catalog = await this.#modelCatalog()
      if (catalog.length === 0) {
        await this.#sendWithRetry(chatId, '本地未发现可枚举的模型目录，可直接用 /model <provider>/<model> 指定。')
        return
      }
      const lines = ['可用模型（✅ 为当前使用，切换仅对本聊天生效）：']
      const shown = catalog.slice(0, 50)
      shown.forEach((model, index) => {
        const mark = model.provider === current.provider && model.id === current.model ? ' ✅' : ''
        lines.push(`${index + 1}. ${model.name}（${model.provider}/${model.id}）${mark}`)
      })
      if (catalog.length > shown.length) lines.push(`… 其余 ${catalog.length - shown.length} 个略，可用 /model 模型id 直达`)
      lines.push('切换：/model 序号、/model 模型id 或 /model provider/model')
      await this.#sendWithRetry(chatId, lines.join('\n'))
      return
    }
    const catalog = await this.#modelCatalog()
    const chosen = matchModelEntry(catalog, rest)
    if (chosen === 'multiple') {
      await this.#sendWithRetry(chatId, `「${rest}」匹配到多个模型，请用 /model 模型id 或 /model provider/model 指定。`)
      return
    }
    if (chosen === undefined) {
      // 目录未收录也允许 provider/model 形式直接指定（目录是 advisory 的）
      const parts = rest.split('/').map(part => part.trim())
      if (parts.length === 2 && parts[0] !== '' && parts[1] !== '') {
        const target = { provider: parts[0]!, model: parts[1]! }
        const chat = state ?? await this.#chat(chatId)
        chat.selectionRef.current = target
        await this.#sendWithRetry(chatId, `已切换到 ${target.provider}/${target.model}，下一条消息生效。`)
        return
      }
      await this.#sendWithRetry(chatId, `没有匹配「${rest}」的模型，发送 /model 查看列表。`)
      return
    }
    const chat = state ?? await this.#chat(chatId)
    chat.selectionRef.current = { provider: chosen.provider, model: chosen.id }
    await this.#sendWithRetry(chatId, `已切换到 ${chosen.name}（${chosen.provider}/${chosen.id}），下一条消息生效。`)
  }

  /**
   * 审批 answerer 主体（串行，微信优先）。问题只发微信：回复认可/拒绝词
   * 直接认领；回复「网页」、通道中途失效或任务中止时调用 next() 转交后续
   * 应答者（Web UI 审批面板）——面板的待审批表项只能由浏览器响应或中止
   * 信号清除，因此绝不能在它已显示后又从他处结算，否则面板会僵死。
   */
  async #approvalViaWechat(chatId: string, req: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const pending: PendingApproval = { toolName: req.toolName, reason: req.reason, settle: () => undefined }
    const answer = new Promise<ApprovalReplyAction>(resolve => { pending.settle = resolve })
    const questionAbort = new AbortController()
    const chain = this.#approvalAskChain.get(chatId) ?? Promise.resolve()
    const delivered = chain
      .then(async () => {
        this.#pendingApprovals.set(chatId, pending)
        const lines = ['🔐 Agent 请求审批', `工具：${req.toolName}`]
        if (req.reason !== undefined && req.reason !== '') lines.push(`原因：${req.reason}`)
        lines.push('回复「同意」或「拒绝」；也可以回复「网页」转到网页端审批面板处理。')
        const signal = req.signal === undefined ? questionAbort.signal : AbortSignal.any([req.signal, questionAbort.signal])
        await this.#sendWithRetry(chatId, lines.join('\n'), signal)
      })
      .catch(() => undefined) // 提问投递失败不阻断：看门狗发现通道失效后会转交网页端
    this.#approvalAskChain.set(chatId, delivered)
    const action = await new Promise<ApprovalReplyAction | undefined>(resolve => {
      let timer: ReturnType<typeof setInterval> | undefined
      let done = false
      const finish = (value: ApprovalReplyAction | undefined): void => {
        if (done) return
        done = true
        if (timer !== undefined) clearInterval(timer)
        resolve(value)
      }
      // 看门狗：等待期间通道判死（凭据过期/断网）即转交，避免问题永远无人应答。
      timer = setInterval(() => { if (!this.#channelHealthy) finish(undefined) }, 30_000)
      ;(timer as { unref?: () => void }).unref?.()
      answer.then(action => finish(action))
      // 任务中止撤销请求：转交后续应答者（对已中止的请求它们同步返回 cancelled）。
      req.signal?.addEventListener('abort', () => finish(undefined), { once: true })
    })
    questionAbort.abort()
    if (this.#pendingApprovals.get(chatId) === pending) this.#pendingApprovals.delete(chatId)
    if (action === undefined) return await next()
    if (action === 'web') return await next()
    return action
  }

  /** /permission：无参列出权限模式并标记当前项；带参切换本聊天的模式。 */
  async #permissionCommand(chatId: string, rest: string): Promise<void> {
    const presets = this.#ctx.get('permissionPresets') as PermissionPresetService | undefined
    if (presets === undefined) {
      await this.#sendWithRetry(chatId, '当前环境未提供 permissionPresets 服务，无法查看或切换权限模式。')
      return
    }
    const state = this.#chats.get(chatId)
    const names = [...presets.names]
    if (rest === '') {
      const currentName = state === undefined ? presets.defaultPreset : presets.current(state.handle.agent.session.events)
      const lines = ['权限模式（✅ 为当前，切换仅对本聊天生效）：']
      names.forEach((name, index) => {
        const spec = presets.resolve(name)
        const mark = name === currentName ? ' ✅' : ''
        lines.push(`${index + 1}. ${spec.name ?? name}（${spec.sandbox} + ${spec.approval === 'ask' ? '越界需审批' : '不审批'}）${mark}`)
      })
      if (currentName === 'custom') lines.push('（当前为自定义组合，不匹配任何预设）')
      lines.push('切换：/permission 序号或名称（如 /permission 1）')
      await this.#sendWithRetry(chatId, lines.join('\n'))
      return
    }
    const chosen = matchPresetName(names, rest)
    if (chosen === 'multiple') {
      await this.#sendWithRetry(chatId, `「${rest}」匹配到多个权限模式，请用 /permission 序号或完整名称指定。`)
      return
    }
    if (chosen === undefined) {
      await this.#sendWithRetry(chatId, `没有匹配「${rest}」的权限模式，发送 /permission 查看列表。`)
      return
    }
    const chat = state ?? await this.#chat(chatId)
    presets.set(chat.handle.agent.session, chosen)
    const spec = presets.resolve(chosen)
    await this.#sendWithRetry(chatId, `已切换到 ${spec.name ?? chosen}（${spec.sandbox} + ${spec.approval === 'ask' ? '越界需审批' : '不审批'}），立即生效。`)
  }

  async #pollLoop(): Promise<void> {
    while (!this.#abort.signal.aborted) {
      try {
        const messages = await this.#client.poll(this.#abort.signal)
        this.#consecutiveFailures = 0
        if (!this.#channelHealthy) this.#log('通道已恢复。')
        this.#channelHealthy = true
        for (const message of messages) await this.#receive(message)
        if (messages.length === 0) await sleep(this.#config.emptyPollDelayMs, this.#abort.signal)
      } catch (error) {
        if (this.#abort.signal.aborted) return
        this.#consecutiveFailures += 1
        if (this.#consecutiveFailures >= 3 && this.#channelHealthy) {
          this.#channelHealthy = false
          this.#log('通道连续失败，判定连接失效（凭据过期或网络中断）。')
        }
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
    if (command === '/model' || command === '/模型' || command.startsWith('/model ') || message.text.trim().startsWith('/模型 ')) {
      const rest = message.text.trim().replace(/^\/(?:model|模型)\s*/u, '').trim()
      await this.#modelCommand(message.chatId, rest)
      return
    }
    if (command === '/permission' || command === '/权限' || message.text.trim().startsWith('/permission ') || message.text.trim().startsWith('/权限 ')) {
      const rest = message.text.trim().replace(/^\/(?:permission|权限)\s*/u, '').trim()
      await this.#permissionCommand(message.chatId, rest)
      return
    }
    // 待审批时的答复拦截：认可/拒绝词消费为审批结果，「网页」转交网页端，
    // 其余消息照常交给 Agent（附一条待办提醒，避免用户忘记还有审批挂着）。
    const approval = this.#pendingApprovals.get(message.chatId)
    if (approval !== undefined) {
      const action = parseApprovalReply(message.text)
      if (action !== undefined) {
        this.#pendingApprovals.delete(message.chatId)
        if (action === 'web') {
          await this.#sendWithRetry(message.chatId, '↗️ 已转到网页端审批面板，请在网页端处理。')
        } else {
          await this.#sendWithRetry(message.chatId, action === 'allowed-once' ? '✅ 已同意，继续执行。' : '⛔ 已拒绝该操作。')
        }
        approval.settle(action)
        return
      }
      await this.#sendWithRetry(message.chatId, `⏳ 有一条审批等待答复（工具：${approval.toolName}）：回复「同意」或「拒绝」，回复「网页」转网页端，或发 /stop 中止任务。`)
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
    // 活引用：/model 修改 current 即可在不重建会话的情况下切换模型。
    const selected: ModelSelectionRef = { current: selection, assembled: undefined }
    const instructions = [
      '本会话与一个微信聊天相连，同时可在 Harness Web UI 中查看。',
      '从微信收到的文件保存在工作区内，用户消息中会列出绝对路径。',
      '要把工作区文件发回微信，在最终回复中单独一行写指令：[[send-file:relative/or/absolute/path]]。',
      '此外，回复正文中提及的工作区内既有文件路径会自动发送给用户，无需额外指令。',
      '仅当用户明确要求或确有必要时才发送文件；显式指令行会从送达微信的文本中移除。',
      '回复将原样送达微信（纯文本），避免使用依赖渲染的复杂 Markdown 表格。',
      '你的回复会自动送达微信，无需对本会话调用 wechat_notify；该工具供其他会话主动推送使用。',
    ].join('\n')
    // 创建路径：挂载 presets + 安装 selection waterfall
    const setup = async (agentCtx: Context): Promise<void> => {
      const agentPresets = this.#ctx.get('agentPresets') as AgentPresetService | undefined
      if (agentPresets === undefined) throw new Error('wechat-gateway: agentPresets 服务不可用')
      await agentPresets.mount(agentCtx)
      installSelection(agentCtx, selected, instructions)
    }
    const persistedSession = this.#store.state.chats[chatId]
    let handle: AgentHandle
    if (persistedSession !== undefined) {
      const active = this.#ctx.agents.get(sessionId(persistedSession))
      if (active !== undefined) {
        // 会话已被 Web UI 等其他持有者打开：附着但不持有销毁权。
        // 只安装 selection waterfall（不重复 mount presets），使 /model 在附着会话也能生效。
        try {
          installSelection(active.ctx, selected, instructions)
        } catch (error) {
          this.#log(`附着时安装 selection waterfall 失败: ${error instanceof Error ? error.message : String(error)}`)
        }
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
    const state = { handle, selectionRef: selected, sentThroughSeq: handle.agent.session.seq, delivery: Promise.resolve(), typing: Promise.resolve() }
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
    connected: () => gateway === undefined
      ? { state: 'disconnected' as const }
      : gateway.channelHealthy
        ? { state: 'connected' as const, ...(gatewayAccount === undefined ? {} : { account: gatewayAccount }) }
        : { state: 'stale' as const },
  })
  await startGateway()
  if (gateway === undefined) process.stderr.write('wechat-gateway: 尚未登录微信。在 Harness Web UI 打开 /wechat-gateway/login 扫码，或运行 npx dsh-wechat-gateway login。\n')
  ctx.effect(() => async () => { await gateway?.dispose() })
}

export { ILinkClient } from './ilink.js'
export type { InboundMessage, ILinkState, ILinkClientOptions } from './ilink.js'
