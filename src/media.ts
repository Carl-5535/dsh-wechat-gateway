/**
 * 微信 CDN 媒体加解密与本地文件工具。
 *
 * iLink 媒体通道使用 AES-128-ECB：上行先加密再上传 CDN，下行下载后解密。
 * ECB 模式无 IV，密钥来自消息体（hex 或 base64 编码的 16 字节）。
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type MediaKind = 'image' | 'voice' | 'file' | 'video'

/** 一条已解密的入站媒体。 */
export interface InboundMedia {
  kind: MediaKind
  name: string
  mediaType: string
  data: Uint8Array
}

/** iLink 消息里的 CDN 引用。 */
export interface CdnMediaRef {
  encrypt_query_param?: string
  aes_key?: string
  full_url?: string
}

/** 按 16 字节对齐后的密文长度（AES 块大小 + PKCS7 填充）。 */
export function paddedSize(size: number): number {
  return Math.ceil((size + 1) / 16) * 16
}

export function encryptMedia(data: Uint8Array, key: Uint8Array): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(data), cipher.final()])
}

/** 解密入站媒体。密钥兼容 base64(16B) 与 base64(hex32) 两种下发形态。 */
export function decryptMedia(data: Uint8Array, encodedKey: string): Buffer {
  const decoded = Buffer.from(encodedKey, 'base64')
  const key = decoded.length === 16
    ? decoded
    : decoded.length === 32 && /^[0-9a-f]{32}$/i.test(decoded.toString('ascii'))
      ? Buffer.from(decoded.toString('ascii'), 'hex')
      : undefined
  if (key === undefined) throw new Error('微信媒体 AES 密钥无效')
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(data), decipher.final()])
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.txt': 'text/plain', '.json': 'application/json',
  '.zip': 'application/zip', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}
const DEFAULT_MIME: Readonly<Record<MediaKind, string>> = {
  image: 'application/octet-stream',
  video: 'video/mp4',
  voice: 'audio/silk',
  file: 'application/octet-stream',
}

export function mediaTypeForName(name: string, kind: MediaKind): string {
  return MIME_TYPES[extname(name).toLowerCase()] ?? DEFAULT_MIME[kind]
}

/** iLink getuploadurl 的 media_type 取值。 */
export function uploadMediaType(kind: MediaKind): number {
  return { image: 1, video: 2, file: 3, voice: 4 }[kind]
}

/** 去掉路径成分与控制字符，产出安全的展示/落盘文件名。 */
export function safeFileName(input: string, fallback: string): string {
  const cleaned = basename(input)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^\p{L}\p{N}._ -]/gu, '_')
    .trim()
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? fallback : cleaned.slice(0, 180)
}

/** 依据扩展名推断出站媒体的类型通道。 */
export function classifyOutbound(name: string): MediaKind {
  const mime = mediaTypeForName(name, 'file')
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  return 'file'
}

/** 把一条入站媒体落盘到媒体目录（按聊天分目录、文件名加时间戳防覆盖），返回绝对路径。 */
export async function saveInboundMedia(root: string, chatKey: string, media: InboundMedia): Promise<string> {
  const directory = join(root, createHash('sha256').update(chatKey).digest('hex').slice(0, 16))
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const name = `${Date.now()}-${randomBytes(6).toString('hex')}-${safeFileName(media.name, `${media.kind}.bin`)}`
  const path = join(directory, name)
  const file = await open(path, 'wx', 0o600)
  try {
    await file.writeFile(media.data)
    await file.sync()
  } finally {
    await file.close()
  }
  return path
}

/**
 * 解析 Agent 请求发送的文件，并用 realpath 证明它位于工作区内（防符号链接逃逸）。
 */
export async function resolveWorkspaceFile(workspace: string, requested: string, maxBytes: number): Promise<{ path: string; name: string; bytes: Buffer }> {
  const candidate = resolve(workspace, requested)
  const workspaceReal = await realpath(workspace)
  const candidateReal = await realpath(candidate)
  const inside = relative(workspaceReal, candidateReal)
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error('出站文件必须位于配置的工作区内')
  }
  const metadata = await stat(candidateReal)
  if (!metadata.isFile()) throw new Error('出站附件不是普通文件')
  if (metadata.size > maxBytes) throw new Error(`出站附件超过 ${maxBytes} 字节限制`)
  return { path: candidateReal, name: safeFileName(candidateReal, 'file.bin'), bytes: await readFile(candidateReal) }
}

/**
 * 提取回复文本中的 [[send-file:路径]] 指令（Agent 显式声明才发文件，
 * 普通 Markdown 链接不会被当作外发请求）。
 */
export function extractFileDirectives(text: string): { text: string; files: string[] } {
  const files: string[] = []
  const output = text
    .replace(/^\s*\[\[send-file:(.+?)\]\]\s*$/gmu, (_match, path: string) => {
      const trimmed = path.trim()
      if (trimmed !== '') files.push(trimmed)
      return ''
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text: output, files }
}

/** 按字符（而非 UTF-16 码元）切分，避免把 emoji / 生僻字劈成两半。 */
export function splitText(text: string, limit: number): string[] {
  const characters = Array.from(text)
  const chunks: string[] = []
  for (let offset = 0; offset < characters.length; offset += limit) {
    chunks.push(characters.slice(offset, offset + limit).join(''))
  }
  return chunks
}
