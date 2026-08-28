/**
 * 浏览器端贡献：侧边栏底部的微信状态入口（sidebar.footer.action 插槽）。
 *
 * 已登录：绿色状态点 + 「微信」；未登录：点开弹层直接展示扫码二维码，
 * 无需跳转独立登录页（/wechat-gateway/login 仍然保留可用）。
 */

import { createElement, useEffect, useRef, useState, type CSSProperties } from 'react'

/** sidebar.footer.action 的 owner props。 */
interface FooterActionFace {
  wide: boolean
}

interface SlotRegistration<T> {
  name: 'sidebar.footer.action'
  id: string
  order: number
  inject: () => T
}

interface ClientContext {
  slots: {
    inject(name: 'sidebar.footer.action', callback: () => Iterable<unknown>): void
    register<T>(options: SlotRegistration<T>, component: (props: T) => unknown): unknown
  }
}

/** /wechat-gateway/api/state 的响应。 */
interface StateResponse {
  status: 'connected' | 'logged-out'
  account?: string
  /** 凭据预计过期时刻（epoch ms），用于展示剩余有效期。 */
  expiresAt?: number
  /** 原始二维码链接（微信落地页 URL，仅作展示/复制用）。 */
  qr?: string | null
  /** 服务端本地渲染的二维码 PNG data URL，<img> 直接可显。 */
  qrImage?: string | null
  message?: string
  needsCode?: boolean
  refresh?: boolean
}

const WECHAT_GREEN = '#07c160'

function wechatIcon(color: string): ReturnType<typeof createElement> {
  // 简化的微信气泡图标（两个圆角气泡 + 眼睛），自包含 SVG，无外部资源。
  return createElement('svg', {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: color, 'aria-hidden': true, style: { flex: 'none' },
  },
    createElement('path', {
      d: 'M9.5 4C5.36 4 2 6.79 2 10.23c0 1.95 1.09 3.69 2.79 4.83l-.7 2.1 2.44-1.23c.63.18 1.3.29 2 .32-.13-.4-.2-.82-.2-1.25 0-2.98 3.02-5.4 6.75-5.4.23 0 .46.01.69.03C15.06 6.53 12.56 4 9.5 4zm-2.6 3.2a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8zm5.2 0a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8z',
    }),
    createElement('path', {
      d: 'M22 15c0-2.9-2.91-5.25-6.5-5.25S9 12.1 9 15s2.91 5.25 6.5 5.25c.6 0 1.18-.07 1.73-.2l2.1 1.06-.6-1.8C21.03 18.28 22 16.74 22 15zm-8.6-1.5a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5zm4.2 0a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5z',
    }))
}

function StatusDot({ connected }: { connected: boolean }): ReturnType<typeof createElement> {
  return createElement('span', {
    'aria-hidden': true,
    style: {
      width: 7, height: 7, borderRadius: '50%', flex: 'none',
      background: connected ? WECHAT_GREEN : 'var(--dsw-alias-label-tertiary, #9a9a9f)',
      boxShadow: connected ? `0 0 0 3px ${WECHAT_GREEN}22` : undefined,
    },
  })
}

/** 凭据剩余有效期展示文案；进入预警窗口（≤4 小时）时标橙提醒。 */
function remainingLabel(expiresAt: number): { text: string; soon: boolean } | null {
  const remaining = expiresAt - Date.now()
  if (remaining <= 0) return null
  const soon = remaining <= 4 * 3_600_000
  if (remaining >= 3_600_000) {
    const hours = remaining / 3_600_000
    return { text: `剩 ${hours >= 10 ? Math.round(hours) : Math.round(hours * 10) / 10} 小时`, soon }
  }
  return { text: `剩 ${Math.max(1, Math.ceil(remaining / 60_000))} 分钟`, soon }
}

/** 弹层横向锚点钳制：优先锚点位置，右侧至少留 12px、左侧至少 8px（弹层宽 300）。 */
export function clampPopoverLeft(anchorLeft: number | undefined, viewportWidth: number): number {
  return Math.max(8, Math.min(anchorLeft ?? 280, viewportWidth - 312))
}

/** 轻量开关（微信绿滑动式）。 */
function Toggle({ on, onChange }: { on: boolean; onChange: (next: boolean) => void }): ReturnType<typeof createElement> {
  return createElement('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': on,
    onClick: () => { onChange(!on) },
    style: {
      appearance: 'none', flex: 'none', position: 'relative', width: 34, height: 20,
      borderRadius: 10, border: 'none', cursor: 'pointer', padding: 0,
      background: on ? WECHAT_GREEN : 'var(--dsw-alias-border-l2, #d5d5da)',
      transition: 'background .15s',
    } as CSSProperties,
  },
    createElement('span', {
      'aria-hidden': true,
      style: {
        position: 'absolute', top: 2, left: on ? 16 : 2, width: 16, height: 16, borderRadius: '50%',
        background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.25)', transition: 'left .15s',
      } as CSSProperties,
    }))
}

function WeChatStatusButton(props: FooterActionFace) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<StateResponse | null>(null)
  const [code, setCode] = useState('')
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null)
  const [workspace, setWorkspace] = useState('')
  const [editingWorkspace, setEditingWorkspace] = useState(false)
  const [browsePath, setBrowsePath] = useState('')
  const [browseEntries, setBrowseEntries] = useState<string[]>([])
  const [browseParent, setBrowseParent] = useState<string | null>(null)
  const [expiryWarn, setExpiryWarn] = useState(true)

  const load = (start = false): void => {
    void fetch(`/wechat-gateway/api/state${start ? '?start=1' : ''}`).then(async response => setState(await response.json() as StateResponse)).catch(() => undefined)
  }

  const loadWorkspace = (): void => {
    void fetch('/wechat-gateway/api/workspace').then(async r => {
      const data = await r.json() as { workspace?: string }
      setWorkspace(data.workspace ?? '')
    }).catch(() => undefined)
  }

  const loadExpiryWarn = (): void => {
    void fetch('/wechat-gateway/api/expiry-warn').then(async r => {
      const data = await r.json() as { enabled?: boolean }
      if (typeof data.enabled === 'boolean') setExpiryWarn(data.enabled)
    }).catch(() => undefined)
  }

  const saveExpiryWarn = (next: boolean): void => {
    setExpiryWarn(next)
    void fetch('/wechat-gateway/api/expiry-warn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    }).then(async r => {
      const data = await r.json() as { enabled?: boolean }
      if (typeof data.enabled === 'boolean') setExpiryWarn(data.enabled)
    }).catch(() => undefined)
  }

  const loadBrowse = (path: string): void => {
    void fetch(`/wechat-gateway/api/browse?path=${encodeURIComponent(path)}`).then(async r => {
      const data = await r.json() as { path?: string; parent?: string | null; entries?: string[]; error?: string }
      if (data.error) return
      setBrowsePath(data.path ?? '')
      setBrowseParent(data.parent ?? null)
      setBrowseEntries(data.entries ?? [])
    }).catch(() => undefined)
  }

  const startEditing = (): void => {
    setEditingWorkspace(true)
    loadBrowse(workspace || '')
  }

  const selectDirectory = (): void => {
    void fetch('/wechat-gateway/api/workspace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: browsePath }),
    }).then(async r => {
      const data = await r.json() as { workspace?: string }
      setWorkspace(data.workspace ?? browsePath)
      setEditingWorkspace(false)
    }).catch(() => undefined)
  }

  // 挂载即取一次状态；弹层打开时 1.5s 轮询推进登录状态机，关闭后 15s 轻量观察掉线。
  useEffect(() => {
    load()
    const interval = window.setInterval(() => { load() }, open ? 1_500 : 15_000)
    return () => { window.clearInterval(interval) }
  }, [open])

  // 服务器要求换码（过期/区域切换）时自动取新码。
  useEffect(() => {
    if (state?.refresh === true) load(true)
  }, [state?.refresh])

  // 弹层是 fixed 定位，锚点只在展开瞬间取一次的话，侧边栏收缩/窗口缩放移动按钮后弹层会留在原地。
  // 打开期间持续重测：按钮宽度随布局变化，ResizeObserver 正好覆盖侧边栏收展；窗口缩放走 resize。
  const measureAnchor = (): void => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (rect !== undefined) setAnchor({ left: rect.right + 12, bottom: window.innerHeight - rect.bottom + 4 })
  }

  useEffect(() => {
    if (!open) return
    measureAnchor()
    const button = buttonRef.current
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measureAnchor)
    if (button !== null && observer !== null) observer.observe(button)
    window.addEventListener('resize', measureAnchor)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measureAnchor)
    }
  }, [open])

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (next) {
      measureAnchor()
      load()
      loadWorkspace()
      loadExpiryWarn()
    } else {
      setEditingWorkspace(false)
    }
  }

  const connected = state?.status === 'connected'
  const expiry = state?.expiresAt === undefined ? null : remainingLabel(state.expiresAt)
  const qrImage = state?.qrImage ?? null
  const anchorBottom = anchor?.bottom ?? 48
  const popover: CSSProperties = {
    position: 'fixed',
    left: `${clampPopoverLeft(anchor?.left, window.innerWidth)}px`,
    bottom: `${anchorBottom}px`,
    width: 300,
    // 纵向钳制：窗口过矮时弹层内部滚动，而不是溢出屏幕顶缘。
    maxHeight: `calc(100vh - ${anchorBottom + 8}px)`,
    overflowY: 'auto',
    zIndex: 1000,
    background: 'var(--dsw-alias-bg-layer-3, #fff)',
    color: 'var(--dsw-alias-label-primary, inherit)',
    border: '1px solid var(--dsw-alias-border-l2, #e3e3e6)',
    borderRadius: '12px',
    boxShadow: '0 8px 30px rgba(0,0,0,.14)',
    padding: '16px 18px',
  }

  const buttonStyle: CSSProperties = {
    appearance: 'none',
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: props.wide ? 'flex-start' : 'center',
    gap: 10,
    padding: props.wide ? '8px 10px' : '8px 0',
    font: 'inherit',
    fontSize: '13px',
    color: 'var(--dsw-alias-label-primary, inherit)',
    background: open ? 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,.05))' : 'transparent',
    border: 0,
    borderRadius: '8px',
    cursor: 'pointer',
  }

  const qr = state?.qr ?? null

  return createElement('div', { style: { width: '100%' } },
    createElement('button', {
      ref: buttonRef,
      type: 'button',
      'aria-expanded': open,
      'aria-label': connected ? '微信已连接' : '连接微信',
      onClick: toggle,
      style: buttonStyle,
    },
      wechatIcon(connected ? WECHAT_GREEN : 'currentColor'),
      createElement(StatusDot, { connected }),
      props.wide ? createElement('span', null, '微信') : null,
    ),
    open ? createElement('div', { style: popover },
      createElement('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 } },
        wechatIcon(WECHAT_GREEN), '微信连接'),
      connected
        ? createElement('div', null,
            createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 8 } },
              createElement(StatusDot, { connected: true }),
              state?.account === undefined ? '已连接' : `已连接 · ${state.account}`,
              expiry === null ? null : createElement('span', {
                style: { color: expiry.soon ? '#d97706' : 'var(--dsw-alias-label-tertiary, #9a9a9f)', whiteSpace: 'nowrap' },
              }, ` · ${expiry.text}`)),
            createElement('div', { style: { fontSize: 12.5, color: 'var(--dsw-alias-label-tertiary, #9a9a9f)', lineHeight: 1.6 } },
              '在微信里直接给本账号发消息即可使用；发送 /help 查看命令。'),
            createElement('div', { style: { marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--dsw-alias-border-l2, #e3e3e6)', display: 'flex', alignItems: 'center', gap: 10 } },
              createElement('div', { style: { flex: 1, minWidth: 0 } },
                createElement('div', { style: { fontSize: 12.5 } }, '到期预警'),
                createElement('div', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary, #9a9a9f)', marginTop: 2 } }, '凭据快过期时微信提醒我；收到消息自动续期')),
              createElement(Toggle, { on: expiryWarn, onChange: saveExpiryWarn })),
            createElement('div', { style: { marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--dsw-alias-border-l2, #e3e3e6)' } },
              createElement('div', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary, #9a9a9f)', marginBottom: 4 } }, '工作目录'),
              editingWorkspace
                ? createElement('div', null,
                    createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #9a9a9f)', marginBottom: 6, wordBreak: 'break-all' } }, browsePath || '(根目录)'),
                    createElement('div', { style: { maxHeight: 200, overflowY: 'auto', border: '1px solid var(--dsw-alias-border-l2, #e3e3e6)', borderRadius: 6, marginBottom: 6 } },
                      browseParent !== null ? createElement('div', {
                        onClick: () => { loadBrowse(browseParent) },
                        style: { padding: '6px 10px', fontSize: 12, cursor: 'pointer', borderBottom: '1px solid var(--dsw-alias-border-l2, #e3e3e6)', color: 'var(--dsw-alias-label-tertiary, #9a9a9f)' },
                      }, '← 上级') : null,
                      browseEntries.length === 0
                        ? createElement('div', { style: { padding: '12px 10px', fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #9a9a9f)', textAlign: 'center' } }, '无子目录')
                        : browseEntries.map(entry => createElement('div', {
                            key: entry,
                            onClick: () => {
                              const next = browsePath === '' ? entry : (browsePath.endsWith('/') || browsePath.endsWith('\\') ? browsePath + entry : browsePath + (browsePath.includes('\\') ? '\\' : '/') + entry)
                              loadBrowse(next)
                            },
                            style: { padding: '6px 10px', fontSize: 12, cursor: 'pointer', borderBottom: '1px solid var(--dsw-alias-border-l2, #e3e3e6)' },
                          }, entry))),
                    createElement('div', { style: { display: 'flex', gap: 6 } },
                      createElement('button', {
                        type: 'button',
                        onClick: selectDirectory,
                        style: { font: 'inherit', fontSize: 12, padding: '4px 10px', borderRadius: 6, border: 'none', background: WECHAT_GREEN, color: '#fff', cursor: 'pointer', flex: 1 },
                      }, '选择此目录'),
                      createElement('button', {
                        type: 'button',
                        onClick: () => { setEditingWorkspace(false) },
                        style: { font: 'inherit', fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2, #e3e3e6)', background: 'transparent', color: 'inherit', cursor: 'pointer', flex: 'none' },
                      }, '取消')))
                : createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5 } },
                    createElement('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, workspace || '默认'),
                    createElement('button', {
                      type: 'button',
                      onClick: startEditing,
                      style: { font: 'inherit', fontSize: 11.5, padding: '2px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2, #e3e3e6)', background: 'transparent', color: 'var(--dsw-alias-label-tertiary, #9a9a9f)', cursor: 'pointer', flex: 'none' },
                    }, '修改'))))
        : createElement('div', null,
            createElement('div', { style: { fontSize: 12.5, color: 'var(--dsw-alias-label-tertiary, #9a9a9f)', marginBottom: 10, textAlign: 'center' } },
              state?.message ?? '正在获取二维码…'),
            qrImage === null
              ? createElement('button', {
                  type: 'button',
                  onClick: () => { load(true) },
                  style: { font: 'inherit', fontSize: 13, padding: '6px 14px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2, #e3e3e6)', background: 'transparent', color: 'inherit', cursor: 'pointer', display: 'block', margin: '0 auto' },
                }, '获取二维码')
              : createElement('div', null,
                  createElement('img', { src: qrImage, alt: '微信登录二维码', style: { width: 180, borderRadius: 10, background: '#fff', padding: 6, display: 'block', margin: '0 auto' } }),
                  qr === null ? null : createElement('div', { style: { fontSize: 11.5, marginTop: 6, wordBreak: 'break-all', textAlign: 'center' } },
                    '扫不出时可将链接复制到手机微信打开：',
                    createElement('a', { href: qr, target: '_blank', rel: 'noreferrer', style: { color: WECHAT_GREEN } }, qr))),
            state?.needsCode === true ? createElement('div', { style: { display: 'flex', gap: 8, marginTop: 10, justifyContent: 'center' } },
              createElement('input', {
                value: code,
                onChange: (event: { currentTarget: { value: string } }) => { setCode(event.currentTarget.value) },
                inputMode: 'numeric',
                maxLength: 8,
                placeholder: '验证码',
                style: { font: 'inherit', fontSize: 13, width: '8em', textAlign: 'center', letterSpacing: 3, padding: '6px 8px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2, #e3e3e6)', background: 'transparent', color: 'inherit' },
              }),
              createElement('button', {
                type: 'button',
                onClick: () => {
                  const value = code.trim()
                  if (/^\d{4,8}$/.test(value)) void fetch(`/wechat-gateway/verify?code=${encodeURIComponent(value)}`, { method: 'POST' }).then(() => { setCode('') }).catch(() => undefined)
                },
                style: { font: 'inherit', fontSize: 13, padding: '6px 14px', borderRadius: 8, border: 'none', background: WECHAT_GREEN, color: '#fff', cursor: 'pointer' },
              }, '验证')) : null,
            createElement('div', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary, #9a9a9f)', marginTop: 10, textAlign: 'center' } },
              '手机微信扫码确认后即可连接')),
    ) : null,
  )
}

export const inject = ['slots']

/** 注册侧边栏底部状态入口；扫码登录直接内嵌完成。 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.footer.action', function* () {
    yield ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'wechat-gateway',
      order: 10,
      inject: () => ({}) as FooterActionFace,
    }, WeChatStatusButton)
  })
}
