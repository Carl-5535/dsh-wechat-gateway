/**
 * DSH Web UI 内置的扫码登录页（仅限本机回环访问）。
 *
 * 挂载在 /wechat-gateway/login，页面自动轮询登录状态，
 * 扫码确认后凭据落盘并回调网关重启。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { setTimeout as delay } from 'node:timers/promises'
import QRCode from 'qrcode'
import { writePrivateJson } from './store.js'
import { pollLoginSession, startLoginSession, type LoginSession } from './qrlogin.js'

interface LoginRouteOptions {
  credentialPath: string
  apiBase?: string
  /** 登录成功后的回调（重启网关）。 */
  onCredential: () => Promise<void>
  /** 网关连接状态（三态）：connected 通道可用；stale 网关在跑但通道已失效（凭据过期/断网）；disconnected 未登录。 */
  connected?: () => { state: 'connected' | 'stale' | 'disconnected'; account?: string }
}

interface StatusResult {
  done: boolean
  ok: boolean
  message: string
  needsCode?: boolean
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function pageHtml(qrImage: string, qrLink: string, statusUrl: string, verifyUrl: string): string {
  const escapedLink = qrLink.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>微信连接 · DSH</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; min-height: 100vh;
         display: flex; align-items: center; justify-content: center; background: #f7f7f9; color: #1c1c1e; }
  @media (prefers-color-scheme: dark) { body { background: #161618; color: #f2f2f4; } .card { background: #232326 !important; } }
  .card { background: #fff; border-radius: 16px; padding: 40px 44px; max-width: 420px; width: 90%;
          box-shadow: 0 8px 30px rgba(0,0,0,.08); text-align: center; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  p.state { color: #888; min-height: 22px; margin: 4px 0 18px; }
  .qr { margin: 0 auto 10px; max-width: 240px; }
  .qr img { width: 100%; border-radius: 10px; background: #fff; padding: 4px; display: block; }
  p.link-wrap { font-size: 12px; margin: 0 0 18px; word-break: break-all; }
  a.link { color: #07c160; }
  input { font: inherit; padding: 8px 10px; border-radius: 8px; border: 1px solid #ccc;
          width: 9em; text-align: center; letter-spacing: 4px; }
  button { font: inherit; margin-left: 8px; padding: 8px 14px; border-radius: 8px; border: none;
           background: #07c160; color: #fff; cursor: pointer; }
  .ok { color: #07c160; font-weight: 600; }
  .hidden { display: none; }
</style>
</head>
<body>
<div class="card">
  <h1>连接微信</h1>
  <p class="state" id="state">等待扫码…</p>
  <div class="qr"><img id="qr" src="${qrImage}" alt="微信登录二维码"></div>
  <p class="link-wrap">扫不出时可将链接复制到手机微信打开：<br><a class="link" id="qr-link" href="${escapedLink}">${escapedLink}</a></p>
  <div id="verifyRow" class="hidden">
    <input id="code" inputmode="numeric" maxlength="8" placeholder="验证码">
    <button id="submit">验证</button>
  </div>
</div>
<script>
(async () => {
  const state = document.getElementById('state')
  const verifyRow = document.getElementById('verifyRow')
  const submit = document.getElementById('submit')
  const code = document.getElementById('code')
  submit.addEventListener('click', async () => {
    const value = code.value.trim()
    if (/^\\d{4,8}$/.test(value)) {
      await fetch('${verifyUrl}?code=' + encodeURIComponent(value), { method: 'POST' })
      verifyRow.classList.add('hidden')
    }
  })
  let lastImage = null
  for (;;) {
    let data
    try { data = await (await fetch('${statusUrl}')).json() } catch { await new Promise(r => setTimeout(r, 2000)); continue }
    state.textContent = data.message
    if (data.qrImage && data.qrImage !== lastImage) {
      lastImage = data.qrImage
      document.getElementById('qr').src = data.qrImage
      if (data.qr) document.getElementById('qr-link').href = data.qr
    }
    if (data.needsCode) { verifyRow.classList.remove('hidden'); code.focus() }
    if (data.refresh) location.reload()
    if (data.done) { state.className = 'state ok'; break }
    await new Promise(r => setTimeout(r, 1500))
  }
})()
</script>
</body>
</html>`
}

/** 在 Web UI 上注册 /wechat-gateway 登录路由。 */
export function mountLoginRoute(ctx: Context, options: LoginRouteOptions): void {
  let session: LoginSession | undefined
  // 首次 /api/state 查询自动开一个登录会话（每进程只自动一次），
  // 之后的新二维码必须由用户显式请求，避免无人值守时无限换码。
  let autoStarted = false
  // 登录状态机的最新视图。get_qrcode_status 是服务端长轮询（hold 10-30s），
  // 因此由宿主侧的后台循环推进状态机，HTTP 接口只读缓存、毫秒级返回。
  let cache: StatusResult = { done: false, ok: false, message: '点击获取二维码。' }
  let qrSnapshot: { qr: string; qrImage: string } | undefined
  let pollLoop: Promise<void> | undefined

  /** 开启（或按需创建）登录会话，并确保后台轮询循环在跑。 */
  const beginSession = async (start: boolean): Promise<void> => {
    if (start || (session === undefined && !autoStarted)) {
      autoStarted = true
      session = await startLoginSession({ apiBase: options.apiBase, credentialPath: options.credentialPath })
      qrSnapshot = { qr: session.display, qrImage: await QRCode.toDataURL(session.display, { margin: 1, width: 240 }) }
      cache = { done: false, ok: false, message: '等待扫码…' }
    }
    advance()
  }

  /** 后台轮询循环：同一时刻至多一个，会话被替换时自动退出。 */
  const advance = (): void => {
    const current = session
    if (current === undefined || pollLoop !== undefined) return
    pollLoop = (async () => {
      try {
        while (session === current) {
          const result = await pollLoginSession(current)
          if (session !== current) return
          if (result.status === 'confirmed') {
            await writePrivateJson(options.credentialPath, result.credential)
            await options.onCredential()
            session = undefined
            cache = { done: true, ok: true, message: '连接成功。' }
            return
          }
          if (result.status === 'expired') {
            session = undefined
            cache = { done: false, ok: false, message: '二维码已过期，点击重新获取。' }
            return
          }
          if (result.status === 'needs-code') {
            cache = { done: false, ok: false, needsCode: true, message: '请输入手机微信显示的数字。' }
          } else if (result.status === 'code-blocked') {
            cache = { done: false, ok: false, needsCode: true, message: '尝试次数过多，请稍后重新扫码。' }
          } else if (result.status === 'already-bound') {
            session = undefined
            cache = { done: true, ok: true, message: '该账号已绑定本机，网关将直接沿用现有凭据。' }
            return
          } else {
            cache = { done: false, ok: false, message: result.status === 'scanned' ? '已扫码，请在手机上确认。' : '等待扫码…' }
          }
          await delay(1_000)
        }
      } catch {
        cache = { done: false, ok: false, message: '暂时无法连接，请稍后重试。' }
      } finally {
        pollLoop = undefined
        if (session !== undefined) advance()
      }
    })()
  }

  /** /api/state：侧边栏状态组件的机读视图（纯缓存读，不触碰长轮询）。 */
  const apiState = async (start: boolean): Promise<Record<string, unknown>> => {
    const connection = options.connected?.()
    if (connection?.state === 'connected') return { status: 'connected', ...(connection.account === undefined ? {} : { account: connection.account }) }
    if (connection?.state === 'stale') {
      // 凭据已失效：旧登录会话一并作废，引导用户重新扫码。
      session = undefined
      return { status: 'logged-out', qr: null, message: '连接已失效（凭据过期或网络中断），点击重新获取二维码。' }
    }
    await beginSession(start)
    return {
      status: 'logged-out',
      qr: session === undefined ? null : qrSnapshot?.qr ?? null,
      qrImage: session === undefined ? null : qrSnapshot?.qrImage ?? null,
      message: cache.message,
      ...(cache.needsCode === undefined ? {} : { needsCode: cache.needsCode }),
    }
  }

  ctx.inject(['webServer'], (webCtx) => {
    const route: WebRoute = {
      kind: 'prefix',
      path: '/wechat-gateway',
      handler: async (request, response) => {
        response.setHeader('cache-control', 'no-store')
        response.setHeader('x-content-type-options', 'nosniff')
        if (!isLoopback(request.socket.remoteAddress)) {
          response.writeHead(403).end('微信登录页面仅允许本机访问。')
          return
        }
        const path = request.url?.split('?')[0]
        if (path === '/wechat-gateway/api/state') {
          response.setHeader('content-type', 'application/json; charset=utf-8')
          const start = new URL(request.url ?? '', 'http://localhost').searchParams.get('start') === '1'
          try {
            response.end(JSON.stringify(await apiState(start)))
          } catch (error) {
            response.writeHead(502).end(JSON.stringify({ status: 'logged-out', qr: null, message: `暂时无法连接：${error instanceof Error ? error.message : String(error)}` }))
          }
          return
        }
        if (path === '/wechat-gateway/status') {
          response.setHeader('content-type', 'application/json; charset=utf-8')
          advance()
          response.end(JSON.stringify({
            ...cache,
            ...(session === undefined || qrSnapshot === undefined ? {} : qrSnapshot),
          }))
          return
        }
        if (path === '/wechat-gateway/verify') {
          response.setHeader('content-type', 'application/json; charset=utf-8')
          if (request.method !== 'POST') {
            response.writeHead(405).end(JSON.stringify({ ok: false, message: '请求方式不正确。' }))
            return
          }
          const codeValue = new URL(request.url ?? '', 'http://localhost').searchParams.get('code')?.trim()
          if (session === undefined || codeValue === undefined || !/^\d{4,8}$/.test(codeValue)) {
            response.writeHead(400).end(JSON.stringify({ ok: false, message: '请输入手机微信显示的数字。' }))
            return
          }
          session.verifyCode = codeValue
          response.end(JSON.stringify({ ok: true, message: '正在验证…' }))
          return
        }
        if (path === '/wechat-gateway/login') {
          await beginSession(true)
          response.setHeader('content-type', 'text/html; charset=utf-8')
          response.end(pageHtml(
            qrSnapshot?.qrImage ?? '',
            qrSnapshot?.qr ?? '',
            '/wechat-gateway/status',
            '/wechat-gateway/verify',
          ))
          return
        }
        response.writeHead(404).end('Not found')
      },
    }
    webCtx.effect(() => webCtx.webServer.register(route), 'wechat-gateway: 浏览器扫码登录')
  })
}
