// 打分与抽样：范围、确定性、边界。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { intensity, sample, dreamable, userPart } from '../dream-core.mjs'

test('情感强度始终在 0..1', () => {
  for (const text of ['', '嗯', '哇！！！好开心！！你真好(≧ω≦)ゞ', 'a'.repeat(500)]) {
    const v = intensity(text)
    assert.ok(v >= 0 && v <= 1, `${JSON.stringify(text.slice(0, 10))} → ${v}`)
  }
})

test('情绪词 + 第二人称 + 感叹号会拉高强度', () => {
  assert.ok(intensity('我好开心！你真好！') > intensity('今天天气一般'))
})

test('空正文不算素材', () => {
  assert.equal(dreamable(''), false)
  assert.equal(dreamable('short'), false)
})

test('代码块与链接不算素材', () => {
  assert.equal(dreamable('```js\nconst a = 1\n```'), false)
  assert.equal(dreamable('看这个 https://example.com 很有意思的样子呢我觉得挺好'), false)
  assert.equal(dreamable('今天在实验室做了一个下午的缺失数据分析，累得不行但还挺有成就感'), true)
})

test('只取「我说」那一段，取不到就返回空', () => {
  const block = '**我说：**\n你好呀\n\n---\n\n**DeepSeek说：**\n大肥鱼在的'
  assert.equal(userPart(block), '你好呀')
  assert.equal(userPart('**DeepSeek说：**\n只有回复没有提问'), '')
})

test('抽样不重复、不超过 k', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ text: `t${i}`, score: 1 + i * 0.1 }))
  const picked = sample(items, 4)
  assert.equal(picked.length, 4)
  const set = new Set(picked.map((p) => p.text))
  assert.equal(set.size, 4)
})

test('权重更高的更常被抽到（粗略统计）', () => {
  const items = [{ text: 'a', score: 1 }, { text: 'b', score: 3 }]
  let a = 0
  for (let i = 0; i < 2000; i++) {
    if (sample(items, 1)[0].text === 'a') a++
  }
  const ratio = a / 2000
  assert.ok(ratio > 0.2 && ratio < 0.35, `a 的比例 ${ratio}，期望约 0.25`)
})
