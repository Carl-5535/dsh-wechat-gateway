import { describe, expect, it, vi } from 'vitest'
import { pollLoginSession, startLoginSession, type LoginSession } from '../src/qrlogin.js'

const API = 'https://ilinkai.weixin.qq.com'

function fetchReturning(valueFor: (path: string) => Record<string, unknown>): typeof fetch {
  return vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = String(input)
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    return new Response(JSON.stringify(valueFor(path)), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

describe('startLoginSession', () => {
  it('解析二维码与展示地址', async () => {
    const fetch = fetchReturning(() => ({ qrcode: 'qr-1', qrcode_img_content: 'https://img/qr.png' }))
    const session = await startLoginSession({ fetch, apiBase: API })
    expect(session).toMatchObject({ qrcode: 'qr-1', display: 'https://img/qr.png', apiBase: API })
  })

  it('缺少 qrcode 时报错', async () => {
    const fetch = fetchReturning(() => ({ ok: 1 }))
    await expect(startLoginSession({ fetch, apiBase: API })).rejects.toThrow(/qrcode/)
  })
})

describe('pollLoginSession 状态机', () => {
  function session(): LoginSession {
    return { qrcode: 'qr-1', display: 'x', apiBase: API }
  }

  it('wait/scaned → waiting/scanned', async () => {
    expect((await pollLoginSession(session(), { fetch: fetchReturning(() => ({ status: 'wait' })) })).status).toBe('waiting')
    expect((await pollLoginSession(session(), { fetch: fetchReturning(() => ({ status: 'scaned' })) })).status).toBe('scanned')
  })

  it('confirmed → 返回完整凭据', async () => {
    const fetch = fetchReturning(() => ({
      status: 'confirmed',
      ilink_bot_id: 'bot-9',
      bot_token: 'tok-9',
      baseurl: 'https://sz.ilinkai.weixin.qq.com',
      ilink_user_id: 'owner-1',
    }))
    const result = await pollLoginSession(session(), { fetch })
    expect(result.status).toBe('confirmed')
    if (result.status !== 'confirmed') return
    expect(result.credential).toMatchObject({
      accountId: 'bot-9',
      token: 'tok-9',
      apiBase: 'https://sz.ilinkai.weixin.qq.com',
      userId: 'owner-1',
    })
    expect(Number.isNaN(Date.parse(result.credential.savedAt))).toBe(false)
  })

  it('scaned_but_redirect → 更新区域 apiBase', async () => {
    const s = session()
    const fetch = fetchReturning(() => ({ status: 'scaned_but_redirect', redirect_host: 'gz.ilinkai.weixin.qq.com' }))
    expect((await pollLoginSession(s, { fetch })).status).toBe('redirected')
    expect(s.apiBase).toBe('https://gz.ilinkai.weixin.qq.com')
  })

  it('验证码状态', async () => {
    expect((await pollLoginSession(session(), { fetch: fetchReturning(() => ({ status: 'need_verifycode' })) })).status).toBe('needs-code')
    const blocked = session()
    blocked.verifyCode = '1234'
    expect((await pollLoginSession(blocked, { fetch: fetchReturning(() => ({ status: 'verify_code_blocked' })) })).status).toBe('code-blocked')
    expect(blocked.verifyCode).toBeUndefined()
  })

  it('expired', async () => {
    expect((await pollLoginSession(session(), { fetch: fetchReturning(() => ({ status: 'expired' })) })).status).toBe('expired')
  })

  it('网络错误视为继续等待（服务端 hold 语义）', async () => {
    const fetch = vi.fn(async () => { throw new Error('network reset') }) as unknown as typeof fetch
    expect((await pollLoginSession(session(), { fetch })).status).toBe('waiting')
  })
})
