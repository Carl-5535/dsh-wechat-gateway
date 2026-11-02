import { describe, expect, it } from 'vitest'
import { parseQuestionReply, questionPrompt } from '../src/index.js'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'

const single: AskUserQuestionItem = {
  id: 'what',
  question: '你说的「过期」是指哪一项？',
  header: '确认对象',
  options: [
    { label: '微信会话保活' },
    { label: '网盘链接续期', description: '分享有有效期' },
    { label: '其他' },
  ],
}

const multi: AskUserQuestionItem = {
  id: 'pick',
  question: '要带上哪些资料？',
  multiSelect: true,
  options: [{ label: '音频' }, { label: 'PDF 文稿' }, { label: '字幕' }],
}

const freeText: AskUserQuestionItem = { id: 'note', question: '还有什么要补充的？' }

describe('questionPrompt 选择题文案', () => {
  it('单选题列出编号与说明', () => {
    const text = questionPrompt(single)
    expect(text).toContain('❓ 需要你选择')
    expect(text).toContain('【确认对象】')
    expect(text).toContain('你说的「过期」是指哪一项？')
    expect(text).toContain('  1. 微信会话保活')
    expect(text).toContain('  2. 网盘链接续期 —— 分享有有效期')
    expect(text).toContain('  3. 其他')
    expect(text).toContain('回复编号选择')
    expect(text).toContain('「网页」')
    expect(text).not.toContain('可多选')
  })

  it('多选题提示可多选', () => {
    const text = questionPrompt(multi)
    expect(text).toContain('回复编号可多选')
    expect(text).toContain('1,3')
  })

  it('多题场景标注第几题', () => {
    expect(questionPrompt(multi, 1, 3)).toContain('❓ 问题 2/3')
    expect(questionPrompt(single, 0, 1)).not.toContain('问题 1/1')
  })

  it('无选项时提示直接回复', () => {
    const text = questionPrompt(freeText)
    expect(text).toContain('直接回复你的回答')
    expect(text).not.toContain('  1. ')
  })

  it('detail 换行逐行缩进', () => {
    const text = questionPrompt({ ...freeText, detail: '第一行\n第二行' })
    expect(text).toContain('  第一行')
    expect(text).toContain('  第二行')
  })
})

describe('parseQuestionReply 选择题答复解析', () => {
  it('单选编号 → 选中对应选项', () => {
    for (const text of ['1', ' 1 ', '１'.replace('１', '1')]) {
      expect(parseQuestionReply(single, text)).toEqual({ kind: 'answer', item: { id: 'what', selected: ['微信会话保活'] } })
    }
    expect(parseQuestionReply(single, '2')).toEqual({ kind: 'answer', item: { id: 'what', selected: ['网盘链接续期'] } })
  })

  it('多选逗号/顿号/空格分隔（保持输入顺序）', () => {
    const expected = { kind: 'answer', item: { id: 'pick', selected: ['音频', '字幕'] } }
    for (const text of ['1,3', '1，3', '1、3', '1 3', ' 1 , 3 ']) {
      expect(parseQuestionReply(multi, text)).toEqual(expected)
    }
    expect(parseQuestionReply(multi, '3,1')).toEqual({ kind: 'answer', item: { id: 'pick', selected: ['字幕', '音频'] } })
  })

  it('多选去重', () => {
    expect(parseQuestionReply(multi, '1,1')).toEqual({ kind: 'answer', item: { id: 'pick', selected: ['音频'] } })
  })

  it('单选却给多个编号 → invalid', () => {
    const reply = parseQuestionReply(single, '1,2')
    expect(reply.kind).toBe('invalid')
  })

  it('编号越界 → invalid', () => {
    for (const text of ['0', '4', '1,9']) {
      expect(parseQuestionReply(single, text).kind).toBe('invalid')
    }
  })

  it('选项标签完全匹配（忽略大小写）', () => {
    const english: AskUserQuestionItem = { id: 'e', question: 'q', options: [{ label: 'Yes' }, { label: 'No' }] }
    expect(parseQuestionReply(english, 'yes')).toEqual({ kind: 'answer', item: { id: 'e', selected: ['Yes'] } })
    expect(parseQuestionReply(english, 'NO')).toEqual({ kind: 'answer', item: { id: 'e', selected: ['No'] } })
  })

  it('其他文本 → 自定义回答', () => {
    expect(parseQuestionReply(single, '我想先保持现状')).toEqual({
      kind: 'answer',
      item: { id: 'what', selected: [], custom: '我想先保持现状' },
    })
  })

  it('无选项时任何非空文本都是自定义回答', () => {
    expect(parseQuestionReply(freeText, '明天下午')).toEqual({
      kind: 'answer',
      item: { id: 'note', selected: [], custom: '明天下午' },
    })
  })

  it('转交词 → web', () => {
    for (const text of ['网页', 'web', 'WEB', '转网页', ' 网页 ']) {
      expect(parseQuestionReply(single, text)).toEqual({ kind: 'web' })
    }
  })

  it('空文本 → invalid', () => {
    for (const text of ['', '   ']) {
      expect(parseQuestionReply(single, text).kind).toBe('invalid')
    }
  })
})
