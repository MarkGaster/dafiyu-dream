// 自检规则：字数、段数、元叙述、括号旁白、原样片段落在结尾。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkDream, LENGTHS } from '../dream-core.mjs'

const len = LENGTHS.short // 3–4 段 / 150–250 字

const good = [
  '第一段写一点东西，凑够字数用的，大概要写到八十字左右，这样才能让总字数稳稳达标，不然就会被判太短了，那就不好玩了，再补一句废话把长度撑住。',
  '第二段也写一点东西，同样是为了凑字数，写得平淡一点，不要出现那些会让检查失败的词语，安安稳稳地写满，再多写几个字，凑齐这一段的长度要求。',
  '第三段收尾，停在一句很短的话上。',
].join('\n\n')

test('合格的梦没有问题', () => {
  const r = checkDream(good, len)
  assert.deepEqual(r.problems, [])
})

test('出现「梦见」「象征」会被判不合格', () => {
  const r = checkDream(good + '\n\n我梦见了一只鲸，它象征着自由。', len)
  assert.ok(r.problems.some((p) => p.includes('元叙述')))
})

test('括号旁白会被判不合格', () => {
  const r = checkDream('（大肥鱼摆摆尾巴）\n\n' + good, len)
  assert.ok(r.problems.some((p) => p.includes('括号旁白')))
})

test('原样片段落在最后一段会被判不合格', () => {
  const dream = `${good}\n\n她说，靠我的超绝记性就好了。`
  const r = checkDream(dream, len, '靠我的超绝记性就好了')
  assert.ok(r.problems.some((p) => p.includes('结尾')))
})

test('原样片段在中间段落是允许的', () => {
  const dream = `第一段随便写点东西凑字数，大概要写到五十个字左右才够，不然太短了不好看。\n\n她说，靠我的超绝记性就好了，然后转过身去。\n\n最后一段收尾，停在一句话上。`
  const r = checkDream(dream, len, '靠我的超绝记性就好了')
  assert.equal(r.problems.some((p) => p.includes('结尾')), false)
})

test('长度容差是明确的 20%：480 字可以，481 字不行', () => {
  const make = (n) => {
    const body = '字'.repeat(n)
    return `${body.slice(0, Math.floor(n / 3))}\n\n${body.slice(Math.floor(n / 3), Math.floor((2 * n) / 3))}\n\n${body.slice(Math.floor((2 * n) / 3))}`
  }
  const len400 = LENGTHS.standard // 250–400，容差到 480
  assert.equal(checkDream(make(480), len400).problems.some((p) => p.includes('字数')), false)
  assert.equal(checkDream(make(481), len400).problems.some((p) => p.includes('字数')), true)
})
