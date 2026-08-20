import { describe, expect, it } from 'vitest'
import {
  classifyOutbound,
  decryptMedia,
  detectLocalFilePaths,
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

describe('detectLocalFilePaths（正文提及的本地文件）', () => {
  it('Windows 盘符路径（含空格与中文标点语境）', () => {
    const text = '已生成图标：\n本地文件: C:\\Users\\carl.chen.TRTECH\\dsh-weixin-gateway-icon.png，请查收。'
    expect(detectLocalFilePaths(text)).toEqual(['C:\\Users\\carl.chen.TRTECH\\dsh-weixin-gateway-icon.png'])
  })

  it('含空格的路径整体匹配', () => {
    const text = '结果在 C:\\Users\\John Smith\\my report.pdf 这里'
    expect(detectLocalFilePaths(text)).toEqual(['C:\\Users\\John Smith\\my report.pdf'])
  })

  it('POSIX 绝对路径', () => {
    expect(detectLocalFilePaths('输出：/home/alice/out/report.md 已就绪')).toEqual(['/home/alice/out/report.md'])
  })

  it('URL 不匹配（协议与域名部分不当作路径）', () => {
    const text = '图标 URL: https://platform-outputs.agnes-ai.space/images/t2i/275baa6aab3a45ffa191356ca7bec48c.png'
    expect(detectLocalFilePaths(text)).toEqual([])
  })

  it('无扩展名或目录不匹配', () => {
    expect(detectLocalFilePaths('日志目录是 D:\\logs\\today 而非 D:\\logs')).toEqual([])
    expect(detectLocalFilePaths('盘符 C:\\ 本身')).toEqual([])
  })

  it('同一路径去重、多路径按序返回', () => {
    const text = 'C:\\a\\x.png 与 C:\\a\\x.png，还有 /tmp/b.txt'
    expect(detectLocalFilePaths(text)).toEqual(['C:\\a\\x.png', '/tmp/b.txt'])
  })

  it('大小写不同的写法视为同一路径', () => {
    expect(detectLocalFilePaths('C:\\Out\\A.png 与 c:\\out\\a.png')).toEqual(['C:\\Out\\A.png'])
  })

  it('引号与括号内的路径可提取，行尾句号不并入', () => {
    const text = '见 "C:\\out\\图标.png".（另见 /tmp/z.jpeg）'
    expect(detectLocalFilePaths(text)).toEqual(['C:\\out\\图标.png', '/tmp/z.jpeg'])
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
