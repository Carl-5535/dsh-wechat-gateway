/**
 * 微信 iLink 扫码登录流程。
 *
 * 流程：get_bot_qrcode 取二维码 → 用户手机微信扫码确认 →
 * get_qrcode_status 轮询直到 confirmed，拿到 bot_token / ilink_bot_id。
 *
 * 注意：get_qrcode_status 是服务端长轮询（未扫码时 hold 约 30s 才答 wait），
 * 客户端超时必须大于该 hold 时间，否则永远观察不到「已扫码」。
 */

import { setTimeout as delay } from 'node:timers/promises'
import { defaultCredentialPath, pathExists, readCredential, writePrivateJson, type StoredCredential } from './store.js'
import { validateApiBase } from './ilink.js'

export const DEFAULT_API_BASE = 'https://ilinkai.weixin.qq.com'
const STATUS_POLL_TIMEOUT_MS = 45_000

/** 一次可复用的登录会话（CLI 与 Web 页面共用）。 */
export interface LoginSession {
  /** 服务端二维码 id（轮询状态用）。 */
  qrcode: string
  /** 可展示内容：优先 qrcode_img_content（URL），否则二维码原文。 */
  display: string
  /** 区域化 API 入口，扫码后可能被服务端重定向更新。 */
  apiBase: string
  /** 手机端要求数字验证码时暂存。 */
  verifyCode?: string
}

export interface LoginOptions {
  apiBase?: string
  credentialPath?: string
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
  stdout?: Pick<NodeJS.WriteStream, 'write'>
  signal?: AbortSignal
}

async function requestJson(fetch: typeof globalThis.fetch, apiBase: string, path: string, signal: AbortSignal | undefined, body?: unknown, timeoutMs?: number): Promise<Record<string, unknown>> {
  validateApiBase(apiBase)
  const timeout = AbortSignal.timeout(timeoutMs ?? 30_000)
  const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const response = await fetch(`${apiBase.replace(/\/$/, '')}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    signal: requestSignal,
    redirect: 'error',
    headers: {
      'ilink-app-id': 'bot',
      'ilink-app-clientversion': String((2 << 16) | (2 << 8)),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const responseText = await response.text()
  if (responseText.length > 2 * 1024 * 1024) throw new Error('微信登录响应超过 2 MiB')
  if (!response.ok) throw new Error(`微信登录 HTTP ${response.status}: ${responseText.slice(0, 500)}`)
  const value: unknown = JSON.parse(responseText)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('微信登录返回了非对象响应')
  return value as Record<string, unknown>
}

/** 已保存的本机 token：扫码时声明给服务端，便于识别/接管既有绑定。 */
async function localBotTokens(credentialPath: string): Promise<string[]> {
  if (!await pathExists(credentialPath)) return []
  try {
    const credential = await readCredential(credentialPath)
    return credential.token === '' ? [] : [credential.token]
  } catch {
    return []
  }
}

/** 开启一次扫码登录会话。 */
export async function startLoginSession(options: Pick<LoginOptions, 'apiBase' | 'fetch' | 'signal' | 'credentialPath'> = {}): Promise<LoginSession> {
  const fetch = options.fetch ?? globalThis.fetch
  const apiBase = options.apiBase ?? DEFAULT_API_BASE
  const tokens = await localBotTokens(options.credentialPath ?? defaultCredentialPath())
  // local_token_list：若扫码的微信已绑定本机某个 bot token，服务端返回
  // binded_redirect，本机可直接沿用既有凭据完成接管。
  const result = await requestJson(fetch, apiBase, '/ilink/bot/get_bot_qrcode?bot_type=3', options.signal, { local_token_list: tokens })
  const qrcode = typeof result.qrcode === 'string' ? result.qrcode : ''
  const display = typeof result.qrcode_img_content === 'string' ? result.qrcode_img_content : qrcode
  if (qrcode === '') throw new Error('微信二维码响应缺少 qrcode')
  return { qrcode, display, apiBase }
}

export type LoginPollResult =
  | { status: 'waiting' | 'scanned' }
  | { status: 'redirected' }
  | { status: 'needs-code' | 'code-blocked' }
  | { status: 'already-bound' }
  | { status: 'confirmed'; credential: StoredCredential }
  | { status: 'expired' }

/** 推进一次登录状态轮询；session.apiBase 可能被区域重定向更新。 */
export async function pollLoginSession(session: LoginSession, options: Pick<LoginOptions, 'fetch' | 'signal'> = {}): Promise<LoginPollResult> {
  const verify = session.verifyCode === undefined ? '' : `&verify_code=${encodeURIComponent(session.verifyCode)}`
  let result: Record<string, unknown>
  try {
    result = await requestJson(options.fetch ?? globalThis.fetch, session.apiBase, `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(session.qrcode)}${verify}`, options.signal, undefined, STATUS_POLL_TIMEOUT_MS)
  } catch (error) {
    if (options.signal?.aborted === true) throw error
    // 服务端 hold 期间的网络抖动/超时只说明「尚不知扫码状态」，视为继续等待。
    return { status: 'waiting' }
  }
  if (result.status === 'expired') return { status: 'expired' }
  if (result.status === 'need_verifycode') return { status: 'needs-code' }
  if (result.status === 'verify_code_blocked') {
    session.verifyCode = undefined
    return { status: 'code-blocked' }
  }
  if (result.status === 'binded_redirect') return { status: 'already-bound' }
  if (result.status === 'scaned_but_redirect' && typeof result.redirect_host === 'string' && result.redirect_host !== '') {
    session.apiBase = `https://${result.redirect_host}`
    return { status: 'redirected' }
  }
  if (result.status === 'confirmed') {
    const accountId = typeof result.ilink_bot_id === 'string' ? result.ilink_bot_id : ''
    const token = typeof result.bot_token === 'string' ? result.bot_token : ''
    if (accountId === '' || token === '') throw new Error('微信确认登录但凭据不完整')
    return {
      status: 'confirmed',
      credential: {
        accountId,
        token,
        apiBase: typeof result.baseurl === 'string' && result.baseurl !== '' ? result.baseurl : session.apiBase,
        userId: typeof result.ilink_user_id === 'string' ? result.ilink_user_id : undefined,
        savedAt: new Date().toISOString(),
      },
    }
  }
  if (result.status === 'scaned') session.verifyCode = undefined
  return { status: result.status === 'scaned' ? 'scanned' : 'waiting' }
}

/** 命令行扫码登录：终端展示二维码，直到确认后写入凭据文件。 */
export async function login(options: LoginOptions = {}): Promise<{ credentialPath: string; credential: StoredCredential }> {
  const fetch = options.fetch ?? globalThis.fetch
  const stdout = options.stdout ?? process.stdout
  const credentialPath = options.credentialPath ?? defaultCredentialPath()
  const session = await startLoginSession({ fetch, apiBase: options.apiBase, signal: options.signal, credentialPath })
  stdout.write(`请用手机微信打开或扫码：\n${session.display}\n`)
  const deadline = Date.now() + (options.timeoutMs ?? 8 * 60_000)
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new Error('登录已取消')
    await delay(1_000, undefined, { signal: options.signal })
    const result = await pollLoginSession(session, { fetch, signal: options.signal })
    if (result.status === 'expired') throw new Error('二维码已过期，请重新执行登录')
    if (result.status === 'confirmed') {
      await writePrivateJson(credentialPath, result.credential)
      return { credentialPath, credential: result.credential }
    }
    if (result.status === 'already-bound') {
      // 扫码账号已绑定本机既有 token：沿用旧凭据直接接管。
      if (await pathExists(credentialPath)) {
        try {
          const credential = await readCredential(credentialPath)
          return { credentialPath, credential }
        } catch {
          // 凭据损坏则继续轮询等新凭据。
        }
      }
      continue
    }
  }
  throw new Error('登录超时')
}
