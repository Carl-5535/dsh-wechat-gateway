#!/usr/bin/env node
/**
 * dsh-wechat-gateway 命令行工具：终端扫码登录。
 *
 * 用法：npx dsh-wechat-gateway login [--credential <path>] [--api-base <url>] [--timeout <seconds>]
 */

import { resolve } from 'node:path'
import QRCode from 'qrcode'
import { login } from './qrlogin.js'
import { defaultCredentialPath } from './store.js'

interface CliOptions {
  credentialPath?: string
  apiBase?: string
  timeoutMs?: number
}

function usage(): string {
  return `用法：dsh-wechat-gateway login [选项]

选项：
  --credential <path>  凭据文件路径（默认 $DSH_HOME/wechat-gateway/account.json）
  --api-base <url>     iLink API 入口（默认 https://ilinkai.weixin.qq.com）
  --timeout <seconds>  登录超时（默认 480 秒）
  -h, --help           显示本帮助
`
}

function parse(args: string[]): CliOptions | 'help' {
  if (args[0] !== 'login') {
    if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return 'help'
    throw new Error('仅支持 login 子命令')
  }
  const options: CliOptions = {}
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--help' || arg === '-h') return 'help'
    const value = args[index + 1]
    if (value === undefined) throw new Error(`${arg} 需要一个值`)
    if (arg === '--credential') options.credentialPath = resolve(value)
    else if (arg === '--api-base') options.apiBase = value
    else if (arg === '--timeout') {
      const seconds = Number(value)
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--timeout 必须是正数')
      options.timeoutMs = seconds * 1_000
    } else throw new Error(`未知选项：${arg}`)
    index += 1
  }
  return options
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2))
  if (options === 'help') {
    process.stdout.write(usage())
    return
  }
  const result = await login({
    ...options,
    stdout: {
      write: (chunk: string | Uint8Array) => {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
        // display 是可扫码的 URL：终端再渲染一份二维码，手机微信直接扫屏。
        const url = text.split('\n').find(line => /^https?:\/\//.test(line.trim()))
        process.stdout.write(text)
        if (url !== undefined) {
          try {
            QRCode.toString(url.trim(), { type: 'utf8' }, (error, qr) => {
              if (error === null) process.stdout.write(`\n${qr}\n`)
            })
          } catch {
            // 终端不支持时忽略，链接仍可复制到手机打开。
          }
        }
        return true
      },
    },
  })
  process.stdout.write(`凭据已保存到 ${result.credentialPath}\n机器人账号：${result.credential.accountId}\n`)
  if (result.credential.userId !== undefined) process.stdout.write(`默认白名单（仅本人可触发）：${result.credential.userId}\n`)
}

void main().catch((error: unknown) => {
  process.stderr.write(`dsh-wechat-gateway: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
