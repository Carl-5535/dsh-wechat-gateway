import { describe, expect, it } from 'vitest'
import {
  classifyOutbound,
  decryptMedia,
  encryptMedia,
  extractFileDirectives,
  paddedSize,
  safeFileName,
  splitText,
} from '../src/media.js'
import { randomBytes } from 'node:crypto'

describe('splitText', () => {
  it('按码点切分，不劈开代理对字符', () => {
    const text = '😀😅🙄'.repeat(3)
    const chunks = splitText(text, 3)
    expect(chunks).toHaveLength(3)
    expect(chunks.every(chunk => Array.from(chunk).length === 3)).toBe(true)
    expect(chunks.join('')).toBe(text)
  })

  it('短文本返回单块', () => {
    expect(splitText('hello', 10)).toEqual(['hello'])
  })

  it('空文本返回空数组', () => {
    expect(splitText('', 10)).toEqual([])
  })
})

describe('extractFileDirectives', () => {
  it('提取独立成行的 send-file 指令并从文本中移除', () => {
    const result = extractFileDirectives('结果如下。\n[[send-file: report.pdf]]\n完毕')
    expect(result.files).toEqual(['report.pdf'])
    expect(result.text.replace(/\n+/g, '\n')).toBe('结果如下。\n完毕')
  })

  it('支持绝对路径与多个指令', () => {
    const result = extractFileDirectives('[[send-file: /tmp/a.png]]\n正文\n[[send-file:b/c.txt]]')
    expect(result.files).toEqual(['/tmp/a.png', 'b/c.txt'])
    expect(result.text).toBe('正文')
  })

  it('普通 Markdown 链接不会被当作外发请求', () => {
    const result = extractFileDirectives('参见 [报告](report.pdf) 与 https://example.com/x.png')
    expect(result.files).toEqual([])
    expect(result.text).toContain('[报告](report.pdf)')
  })

  it('行内（非独立行）指令不生效', () => {
    const result = extractFileDirectives('前缀 [[send-file:x.txt]] 后缀')
    expect(result.files).toEqual([])
    expect(result.text).toContain('[[send-file:x.txt]]')
  })
})

describe('媒体加解密', () => {
  it('AES-128-ECB 加解密往返一致', () => {
    const key = randomBytes(16)
    const data = Buffer.from('微信媒体加密测试 · WeChat media payload 📎', 'utf8')
    const ciphertext = encryptMedia(data, key)
    expect(ciphertext.byteLength).toBe(paddedSize(data.byteLength))
    // base64(16B key) 形态
    expect(decryptMedia(ciphertext, key.toString('base64'))).toEqual(data)
    // base64(hex32) 形态
    expect(decryptMedia(ciphertext, Buffer.from(key.toString('hex')).toString('base64'))).toEqual(data)
  })

  it('非法密钥被拒绝', () => {
    const ciphertext = encryptMedia(Buffer.from('x'), randomBytes(16))
    expect(() => decryptMedia(ciphertext, Buffer.from('short').toString('base64'))).toThrow(/密钥/)
  })
})

describe('safeFileName', () => {
  it('剥离路径成分与非法字符', () => {
    expect(safeFileName('../../etc/passwd', 'fallback.bin')).toBe('passwd')
    expect(safeFileName('a/b/报告 v1.2.pdf', 'fallback.bin')).toBe('报告 v1.2.pdf')
    expect(safeFileName('   ', 'fallback.bin')).toBe('fallback.bin')
    expect(safeFileName('..', 'fallback.bin')).toBe('fallback.bin')
  })
})

describe('classifyOutbound', () => {
  it('按扩展名分流', () => {
    expect(classifyOutbound('a.png')).toBe('image')
    expect(classifyOutbound('b.mp4')).toBe('video')
    expect(classifyOutbound('c.pdf')).toBe('file')
  })
})
