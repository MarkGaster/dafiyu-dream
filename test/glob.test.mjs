// glob 匹配的边界：正常匹配、回溯反例、长度上限、旧字段拒绝。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { globMatch, makeMatcher } from '../dream-core.mjs'

test('普通 glob 正常匹配', () => {
  assert.equal(globMatch('chat-*.md', 'chat-2026-10-23-01.md'), true)
  assert.equal(globMatch('qq-*.md', 'chat-2026-10-23-01.md'), false)
  assert.equal(globMatch('chat-2026-10-2?-01.md', 'chat-2026-10-23-01.md'), true)
  assert.equal(globMatch('*', 'anything'), true)
  assert.equal(globMatch('a*b*c', 'aXXbYYc'), true)
})

test('灾难性回溯的反例必须在毫秒级结束', () => {
  // 上一版用正则实现时，这个组合会把主线程钉死（>1500ms）
  const pattern = '*a'.repeat(20) + 'b'
  const name = 'a'.repeat(45) + '!'
  const started = Date.now()
  assert.equal(globMatch(pattern, name), false)
  const elapsed = Date.now() - started
  assert.ok(elapsed < 200, `匹配耗时 ${elapsed}ms，超过 200ms 说明又有回溯了`)
})

test('过长的模式被拒绝，不会进入匹配', () => {
  assert.throws(() => makeMatcher({ sourceGlob: 'a'.repeat(65) }), /过长/)
  assert.throws(() => makeMatcher({ sourceGlob: 'a,b,c,d,e,f' }), /最多支持/)
})

test('旧的 sourcePattern 必须显式报错，不能静默退回默认筛选', () => {
  assert.throws(() => makeMatcher({ sourcePattern: '^qq-' }), /sourcePattern/)
  assert.throws(() => makeMatcher({ sourcePattern: '^(a+)+$' }), /sourcePattern/)
})

test('默认匹配只认 chat/qq 日期素材', () => {
  const m = makeMatcher()
  assert.equal(m('chat-2026-10-23-01.md'), true)
  assert.equal(m('qq-2026-10-21.md'), true)
  assert.equal(m('README.md'), false)
  assert.equal(m('notes-2026-10-23.md'), false)
})
