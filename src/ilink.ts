/**
 * 微信 iLink Bot HTTP 协议客户端。
 *
 * 通道为腾讯官方 iLink Bot API（即微信「插件/ClawBot」机器人通道）。
 * 收消息：POST /ilink/bot/getupdates 长轮询（服务端 hold 到有更新或超时）；
 * 发消息：POST /ilink/bot/sendmessage；打字状态：getconfig + sendtyping；
 * 媒体：getuploadurl → CDN 上传密文 → sendmessage 引用。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  classifyOutbound,
  decryptMedia,
  encryptMedia,
  mediaTypeForName,
  paddedSize,
  safeFileName,
  uploadMediaType,
  type CdnMediaRef,
  type InboundMedia,
  type MediaKind,
} from './media.js'

/** 协议代际，与官方 ClawBot 插件保持一致。 */
const CHANNEL_VERSION = '2.2.0'
const CLIENT_VERSION = (2 << 16) | (2 << 8)
const MAX_RESPONSE_CHARS = 2 * 1024 * 1024

function baseInfo(): { channel_version: string; bot_agent: string } {
  return { channel_version: CHANNEL_VERSION, bot_agent: 'DeepSeek' }
}

/** 归一化后的入站消息。 */
export interface InboundMessage {
  /** iLink 消息 id，用于去重（可能为空）。 */
  id: string
  /** 会话标识：单聊为对方 userId，群聊为 roomId。 */
  chatId: string
  /** 发送者 userId。 */
  userId: string
  group: boolean
  text: string
  media: InboundMedia[]
  mediaErrors: string[]
}

/** 可安全持久化的轮询游标（不含凭据）。 */
export interface ILinkState {
  updatesBuffer: string
  contextTokens: Record<string, string>
}

export interface ILinkClientOptions {
  token: string
  accountId?: string
  apiBase: string
  cdnBase?: string
  fetch?: typeof globalThis.fetch
  state?: ILinkState
  onStateChange?: (state: ILinkState) => Promise<void> | void
  requestTimeoutMs?: number
  maxMediaBytes?: number
}

interface WireItem {
  type: number
  text_item?: { text?: string }
  image_item?: { media?: CdnMediaRef; aeskey?: string }
  voice_item?: { media?: CdnMediaRef }
  file_item?: { media?: CdnMediaRef; file_name?: string }
  video_item?: { media?: CdnMediaRef }
}

interface WireMessage {
  message_id?: string | number
  from_user_id?: string
  room_id?: string
  chat_room_id?: string
  context_token?: string
  item_list?: WireItem[]
}

interface ApiResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WireMessage[]
  get_updates_buf?: string
}

interface ConfigResponse extends ApiResponse {
  typing_ticket?: string
}

interface UploadResponse extends ApiResponse {
  upload_param?: string
  upload_full_url?: string
}

/** 校验 API 入口：凭据只会发往 HTTPS（回环地址放行 HTTP 以便本地测试）。 */
export function validateApiBase(apiBase: string): void {
  const parsed = new URL(apiBase)
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname))) {
    throw new Error('微信 API 入口必须使用 HTTPS（仅回环地址允许 HTTP）')
  }
}

interface DownloadSpec {
  kind: MediaKind
  ref?: CdnMediaRef
  key?: string
  name: string
}

function downloadSpec(item: WireItem): DownloadSpec | undefined {
  switch (item.type) {
    case 2:
      return {
        kind: 'image',
        ref: item.image_item?.media,
        // 图片的 aeskey 有 hex / base64-ref 两种下发形态，统一成 base64。
        key: item.image_item?.aeskey === undefined
          ? item.image_item?.media?.aes_key
          : Buffer.from(item.image_item.aeskey, 'hex').toString('base64'),
        name: 'image.jpg',
      }
    case 3:
      return { kind: 'voice', ref: item.voice_item?.media, key: item.voice_item?.media?.aes_key, name: 'voice.silk' }
    case 4:
      return { kind: 'file', ref: item.file_item?.media, key: item.file_item?.media?.aes_key, name: safeFileName(item.file_item?.file_name ?? '', 'file.bin') }
    case 5:
      return { kind: 'video', ref: item.video_item?.media, key: item.video_item?.media?.aes_key, name: 'video.mp4' }
    default:
      return undefined
  }
}

export class ILinkClient {
  readonly #token: string
  readonly #accountId: string
  readonly #apiBase: string
  readonly #cdnBase: string
  readonly #fetch: typeof globalThis.fetch
  readonly #onStateChange: ((state: ILinkState) => Promise<void> | void) | undefined
  readonly #requestTimeoutMs: number
  readonly #maxMediaBytes: number
  readonly #contextTokens = new Map<string, string>()
  #updatesBuffer: string

  constructor(options: ILinkClientOptions) {
    this.#token = options.token
    this.#accountId = options.accountId ?? ''
    this.#apiBase = options.apiBase.replace(/\/$/, '')
    this.#cdnBase = (options.cdnBase ?? 'https://novac2c.cdn.weixin.qq.com/c2c').replace(/\/$/, '')
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#onStateChange = options.onStateChange
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 90_000
    this.#maxMediaBytes = options.maxMediaBytes ?? 100 * 1024 * 1024
    this.#updatesBuffer = options.state?.updatesBuffer ?? ''
    validateApiBase(this.#apiBase)
    validateApiBase(this.#cdnBase)
    for (const [chatId, token] of Object.entries(options.state?.contextTokens ?? {})) this.#contextTokens.set(chatId, token)
  }

  /** 长轮询一次，返回本轮收到的新消息（服务端无更新时会阻塞到超时）。 */
  async poll(signal: AbortSignal): Promise<InboundMessage[]> {
    const result = await this.#post<ApiResponse>('/ilink/bot/getupdates', {
      get_updates_buf: this.#updatesBuffer,
      base_info: baseInfo(),
    }, signal)
    this.#assertSuccess(result, 'getupdates')
    if (result.get_updates_buf !== undefined && result.get_updates_buf !== this.#updatesBuffer) {
      this.#updatesBuffer = result.get_updates_buf
      await this.#notifyStateChange()
    }
    const messages: InboundMessage[] = []
    for (const message of result.msgs ?? []) {
      const userId = message.from_user_id ?? ''
      if (userId === '' || userId === this.#accountId) continue
      const text = (message.item_list ?? [])
        .filter(item => item.type === 1)
        .map(item => item.text_item?.text ?? '')
        .filter(Boolean)
        .join('\n')
        .trim()
      const downloaded = await this.#downloadItems(message.item_list ?? [], signal)
      if (text === '' && downloaded.media.length === 0 && downloaded.errors.length === 0) continue
      const roomId = message.room_id || message.chat_room_id
      const group = roomId !== undefined && roomId !== ''
      const chatId = group ? roomId : userId
      // context_token 与会话绑定，回复时必须带回，失效则清除重试。
      if (message.context_token !== undefined && message.context_token !== '') {
        this.#contextTokens.set(chatId, message.context_token)
        await this.#notifyStateChange()
      }
      messages.push({ id: String(message.message_id ?? ''), chatId, userId, group, text, media: downloaded.media, mediaErrors: downloaded.errors })
    }
    return messages
  }

  /** 发送一条纯文本。 */
  async sendText(chatId: string, text: string, signal?: AbortSignal): Promise<void> {
    await this.#sendItems(chatId, [{ type: 1, text_item: { text } }], signal)
  }

  /** 设置/清除「正在输入」状态（需要先换取 per-chat ticket）。 */
  async sendTyping(chatId: string, typing: boolean, signal?: AbortSignal): Promise<void> {
    const timeout = AbortSignal.timeout(Math.min(this.#requestTimeoutMs, 5_000))
    const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const config = await this.#post<ConfigResponse>('/ilink/bot/getconfig', {
      ilink_user_id: chatId,
      ...this.#contextOptional(chatId),
      base_info: baseInfo(),
    }, requestSignal)
    this.#assertSuccess(config, 'getconfig')
    if (config.typing_ticket === undefined || config.typing_ticket === '') throw new Error('getconfig 未返回 typing_ticket')
    const result = await this.#post<ApiResponse>('/ilink/bot/sendtyping', {
      ilink_user_id: chatId,
      typing_ticket: config.typing_ticket,
      status: typing ? 1 : 2,
      base_info: baseInfo(),
    }, requestSignal)
    this.#assertSuccess(result, 'sendtyping')
  }

  /** 加密并上传一个本地文件，然后作为原生媒体消息发出。 */
  async sendMedia(chatId: string, name: string, data: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (data.byteLength > this.#maxMediaBytes) throw new Error(`微信媒体超过 ${this.#maxMediaBytes} 字节限制`)
    const kind = classifyOutbound(name)
    const filekey = randomBytes(16).toString('hex')
    const key = randomBytes(16)
    const ciphertext = encryptMedia(data, key)
    const upload = await this.#post<UploadResponse>('/ilink/bot/getuploadurl', {
      filekey,
      media_type: uploadMediaType(kind),
      to_user_id: chatId,
      rawsize: data.byteLength,
      rawfilemd5: createHash('md5').update(data).digest('hex'),
      filesize: paddedSize(data.byteLength),
      no_need_thumb: true,
      aeskey: key.toString('hex'),
      base_info: baseInfo(),
    }, signal)
    this.#assertSuccess(upload, 'getuploadurl')
    const uploadUrl = upload.upload_full_url?.trim()
      || (upload.upload_param === undefined ? '' : `${this.#cdnBase}/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param)}&filekey=${encodeURIComponent(filekey)}`)
    if (uploadUrl === '') throw new Error('getuploadurl 未返回上传地址')
    this.#assertCdnOrigin(uploadUrl)
    const response = await this.#fetch(uploadUrl, {
      method: 'POST', signal, redirect: 'error', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(ciphertext),
    })
    if (!response.ok) throw new Error(`微信 CDN 上传失败 HTTP ${response.status}`)
    const downloadParam = response.headers.get('x-encrypted-param')
    if (downloadParam === null || downloadParam === '') throw new Error('微信 CDN 上传未返回 x-encrypted-param')
    const media = { encrypt_query_param: downloadParam, aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1 }
    const item = kind === 'image'
      ? { type: 2, image_item: { media, mid_size: ciphertext.byteLength } }
      : kind === 'video'
        ? { type: 5, video_item: { media, video_size: ciphertext.byteLength } }
        : { type: 4, file_item: { media, file_name: safeFileName(name, 'file.bin'), len: String(data.byteLength) } }
    await this.#sendItems(chatId, [item], signal)
  }

  #contextOptional(chatId: string): { context_token?: string } {
    const token = this.#contextTokens.get(chatId)
    return token === undefined ? {} : { context_token: token }
  }

  async #sendItems(chatId: string, items: unknown[], signal?: AbortSignal): Promise<void> {
    const message: Record<string, unknown> = {
      from_user_id: '',
      to_user_id: chatId,
      client_id: `dsh-${randomUUID()}`,
      message_type: 2,
      message_state: 2,
      item_list: items,
      ...this.#contextOptional(chatId),
    }
    const result = await this.#post<ApiResponse>('/ilink/bot/sendmessage', {
      base_info: baseInfo(),
      msg: message,
    }, signal)
    try {
      this.#assertSuccess(result, 'sendmessage')
    } catch (error) {
      // 一次失败的 context_token 会让整条 sendmessage 被拒；丢弃后重发一次。
      if (!this.#contextTokens.has(chatId)) throw error
      this.#contextTokens.delete(chatId)
      await this.#notifyStateChange()
      await this.#sendItems(chatId, items, signal)
    }
  }

  async #downloadItems(items: WireItem[], signal: AbortSignal): Promise<{ media: InboundMedia[]; errors: string[] }> {
    const media: InboundMedia[] = []
    const errors: string[] = []
    for (const item of items) {
      const spec = downloadSpec(item)
      if (spec === undefined || spec.ref === undefined) continue
      try {
        if (spec.key === undefined) throw new Error('媒体缺少 AES 密钥')
        const url = spec.ref.full_url?.trim()
          || (spec.ref.encrypt_query_param === undefined ? '' : `${this.#cdnBase}/download?encrypted_query_param=${encodeURIComponent(spec.ref.encrypt_query_param)}`)
        if (url === '') throw new Error('媒体缺少下载地址')
        this.#assertCdnOrigin(url)
        const response = await this.#fetch(url, { signal, redirect: 'error' })
        if (!response.ok) throw new Error(`CDN 下载失败 HTTP ${response.status}`)
        const declared = Number(response.headers.get('content-length') ?? 0)
        if (declared > this.#maxMediaBytes + 16) throw new Error(`媒体超过 ${this.#maxMediaBytes} 字节限制`)
        const encrypted = new Uint8Array(await response.arrayBuffer())
        if (encrypted.byteLength > this.#maxMediaBytes + 16) throw new Error(`媒体超过 ${this.#maxMediaBytes} 字节限制`)
        const data = decryptMedia(encrypted, spec.key)
        if (data.byteLength > this.#maxMediaBytes) throw new Error(`媒体超过 ${this.#maxMediaBytes} 字节限制`)
        media.push({ kind: spec.kind, name: spec.name, mediaType: mediaTypeForName(spec.name, spec.kind), data })
      } catch (error) {
        if (signal.aborted) throw error
        errors.push(`${spec.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { media, errors }
  }

  /** 媒体 URL 必须与配置的 CDN 同源，防止响应里夹带任意外链。 */
  #assertCdnOrigin(value: string): void {
    const parsed = new URL(value)
    const cdn = new URL(this.#cdnBase)
    if (parsed.protocol !== cdn.protocol || parsed.hostname !== cdn.hostname || parsed.port !== cdn.port) {
      throw new Error('微信媒体地址不在配置的 CDN 源内')
    }
  }

  async #notifyStateChange(): Promise<void> {
    await this.#onStateChange?.({ updatesBuffer: this.#updatesBuffer, contextTokens: Object.fromEntries(this.#contextTokens) })
  }

  async #post<T>(path: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    const uin = randomBytes(4).readUInt32BE().toString()
    const timeout = AbortSignal.timeout(this.#requestTimeoutMs)
    const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const response = await this.#fetch(`${this.#apiBase}${path}`, {
      method: 'POST',
      signal: requestSignal,
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        authorizationtype: 'ilink_bot_token',
        authorization: `Bearer ${this.#token}`,
        'x-wechat-uin': Buffer.from(uin).toString('base64'),
        'ilink-app-id': 'bot',
        'ilink-app-clientversion': String(CLIENT_VERSION),
      },
      body: JSON.stringify(payload),
    })
    const responseText = await response.text()
    if (responseText.length > MAX_RESPONSE_CHARS) throw new Error('微信响应超过 2 MiB')
    if (!response.ok) throw new Error(`微信 HTTP ${response.status}: ${responseText.slice(0, 500)}`)
    return JSON.parse(responseText) as T
  }

  #assertSuccess(result: ApiResponse, operation: string): void {
    if ((result.ret ?? 0) !== 0 || (result.errcode ?? 0) !== 0) {
      throw new Error(`${operation} 失败 (ret=${result.ret ?? 0}, errcode=${result.errcode ?? 0}): ${result.errmsg ?? '未知错误'}`)
    }
  }
}
