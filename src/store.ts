/**
 * 私有本地 JSON 存储：登录凭据与网关状态都落在这里。
 *
 * 写入策略：临时文件 + 原子 rename，权限收紧为仅本用户可读（Windows 上跳过 chmod）。
 */

import { constants } from 'node:fs'
import { access, chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

/** 插件私有数据目录，默认 $DSH_HOME/wechat-gateway（DSH_HOME 默认 ~/.dsh）。 */
export function dataDir(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'wechat-gateway')
}

/** 扫码登录成功后写入的凭据文件。 */
export function defaultCredentialPath(): string {
  return join(dataDir(), 'account.json')
}

/** 网关持久状态文件（会话映射、游标、发件箱）。 */
export function defaultStatePath(): string {
  return join(dataDir(), 'state.json')
}

/** iLink 扫码登录换回的凭据。 */
export interface StoredCredential {
  /** 机器人自己的 ilink 账号 id。 */
  accountId: string
  /** Bearer token，仅本地保存。 */
  token: string
  /** 区域化 API 入口，登录时由服务端下发。 */
  apiBase: string
  /** 机器人绑定的微信用户 id（用于默认白名单：只响应自己）。 */
  userId?: string
  savedAt: string
}

/** 读取并校验凭据文件。 */
export async function readCredential(path: string): Promise<StoredCredential> {
  const value = await readPrivateJson<Record<string, unknown>>(path)
  if (typeof value.accountId !== 'string' || value.accountId === '') throw new Error(`${path} 缺少 accountId`)
  if (typeof value.token !== 'string' || value.token === '') throw new Error(`${path} 缺少 token`)
  if (typeof value.apiBase !== 'string' || !/^https?:\/\//.test(value.apiBase)) throw new Error(`${path} 的 apiBase 无效`)
  if (typeof value.savedAt !== 'string' || Number.isNaN(Date.parse(value.savedAt))) throw new Error(`${path} 的 savedAt 无效`)
  if (value.userId !== undefined && typeof value.userId !== 'string') throw new Error(`${path} 的 userId 无效`)
  return {
    accountId: value.accountId,
    token: value.token,
    apiBase: value.apiBase,
    userId: value.userId,
    savedAt: value.savedAt,
  }
}

/** 读取一个私有 JSON 文件（必须是对象，且非 Windows 下权限不得过宽）。 */
export async function readPrivateJson<T>(path: string): Promise<T> {
  const metadata = await stat(path)
  if (!metadata.isFile()) throw new Error(`${path} 不是普通文件`)
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new Error(`${path} 权限过宽，请执行 chmod 600 ${JSON.stringify(path)}`)
  }
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} 必须包含一个 JSON 对象`)
  }
  return value as T
}

/** 原子写入 JSON，文件权限仅本用户可读。 */
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const parent = dirname(path)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(parent, 0o700)
  const temporary = join(parent, `.${randomUUID()}.tmp`)
  const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await file.sync()
  } finally {
    await file.close()
  }
  if (process.platform !== 'win32') await chmod(temporary, 0o600)
  try {
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

/** 判断路径是否存在（其余访问错误照常抛出）。 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
