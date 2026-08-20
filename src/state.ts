/**
 * 网关持久状态：聊天→DSH 会话映射、iLink 轮询游标、消息去重表、发件箱。
 *
 * 目标是重启后无损续跑：未发完的回复从 outbox 断点继续，聊天会话 resume，
 * 已处理过的消息 id 不再重复消费。
 */

import { join } from 'node:path'
import { readPrivateJson, writePrivateJson, pathExists, dataDir } from './store.js'
import type { ILinkState } from './ilink.js'

const STATE_VERSION = 1

/** 单聊/群聊的待发送内容（分块文本 + 待发文件），带断点游标。 */
export interface OutboxItem {
  chunks: string[]
  files: string[]
  next: number
  nextFile: number
}

export interface GatewayState {
  version: 1
  /** chatId → DSH 会话 id。 */
  chats: Record<string, string>
  /** 最近处理过的 iLink 消息 id（有界）。 */
  seenMessageIds: string[]
  protocol: ILinkState
  outbox: Record<string, OutboxItem>
  /** 运行时覆盖的工作目录（空串或缺失时回退到 config.workspace）。 */
  workspace?: string
}

export function defaultStatePath(): string {
  return join(dataDir(), 'state.json')
}

function emptyState(): GatewayState {
  return { version: STATE_VERSION, chats: {}, seenMessageIds: [], protocol: { updatesBuffer: '', contextTokens: {} }, outbox: {}, workspace: undefined }
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`状态文件 ${field} 必须是对象`)
  return value as Record<string, unknown>
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  const output: Record<string, string> = {}
  for (const [key, item] of Object.entries(asRecord(value, field))) {
    if (typeof item !== 'string') throw new Error(`状态文件 ${field}.${key} 必须是字符串`)
    output[key] = item
  }
  return output
}

/** 加载并严格校验状态文件；不存在时返回空状态。 */
export async function loadGatewayState(path: string): Promise<GatewayState> {
  if (!await pathExists(path)) return emptyState()
  const value = await readPrivateJson<Record<string, unknown>>(path)
  if (value.version !== STATE_VERSION) throw new Error(`不支持的状态文件版本: ${String(value.version)}`)
  if (!Array.isArray(value.seenMessageIds) || value.seenMessageIds.some(item => typeof item !== 'string')) {
    throw new Error('状态文件 seenMessageIds 必须是字符串数组')
  }
  const protocolSource = asRecord(value.protocol, 'protocol')
  if (typeof protocolSource.updatesBuffer !== 'string') throw new Error('状态文件 protocol.updatesBuffer 必须是字符串')
  const contextTokens = protocolSource.contextTokens === undefined ? {} : stringRecord(protocolSource.contextTokens, 'protocol.contextTokens')
  const outboxSource = value.outbox === undefined ? {} : asRecord(value.outbox, 'outbox')
  const outbox: Record<string, OutboxItem> = {}
  for (const [chatId, item] of Object.entries(outboxSource)) {
    const record = asRecord(item, `outbox.${chatId}`)
    const chunks = record.chunks
    if (!Array.isArray(chunks) || chunks.some(chunk => typeof chunk !== 'string')) throw new Error(`状态文件 outbox.${chatId}.chunks 必须是字符串数组`)
    const files = record.files === undefined ? [] : record.files
    if (!Array.isArray(files) || files.some(file => typeof file !== 'string')) throw new Error(`状态文件 outbox.${chatId}.files 必须是字符串数组`)
    const next = typeof record.next === 'number' ? record.next : 0
    const nextFile = typeof record.nextFile === 'number' ? record.nextFile : 0
    if (!Number.isInteger(next) || next < 0 || next > chunks.length) throw new Error(`状态文件 outbox.${chatId}.next 无效`)
    if (!Number.isInteger(nextFile) || nextFile < 0 || nextFile > files.length) throw new Error(`状态文件 outbox.${chatId}.nextFile 无效`)
    outbox[chatId] = { chunks: [...chunks], files: [...files], next, nextFile }
  }
  return {
    version: STATE_VERSION,
    chats: stringRecord(value.chats, 'chats'),
    seenMessageIds: [...value.seenMessageIds],
    protocol: { updatesBuffer: protocolSource.updatesBuffer, contextTokens },
    outbox,
    workspace: typeof value.workspace === 'string' ? value.workspace : undefined,
  }
}

/** 串行化写盘：后一次 save 覆盖前一次的快照，避免交错写坏文件。 */
export class GatewayStateStore {
  readonly path: string
  readonly state: GatewayState
  #pending: Promise<void> = Promise.resolve()

  constructor(path: string, state: GatewayState) {
    this.path = path
    this.state = state
  }

  save(): Promise<void> {
    this.#pending = this.#pending.then(async () => {
      await writePrivateJson(this.path, structuredClone(this.state))
    })
    return this.#pending
  }
}
