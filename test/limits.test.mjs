// 第三轮审查抓到的三个具体缺陷的回归测试：
//   N1 限量读取（不能整份读进内存）
//   N3 文件名里自带星号时的匹配
//   N4 含控制字符的 key 必须被拒绝、且不出现在错误文本里
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { globMatch, readCapped } from '../dream-core.mjs'
import { apply } from '../index.js'

test('N3：文件名本身带星号时也要能匹配', () => {
  assert.equal(globMatch('*', '*a'), true)
  assert.equal(globMatch('chat-*.md', 'chat-*2026-10-23.md'), true)
  assert.equal(globMatch('a*b', 'a*b'), true)
})

test('N1：超过上限的文件只读上限 +1 字节，判为 oversize', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dream-'))
  const file = path.join(dir, 'big.md')
  writeFileSync(file, 'x'.repeat(1000))
  try {
    const r = readCapped(file, 100)
    assert.equal(r.oversize, true)
    assert.equal(r.bytesRead, 101)
    assert.equal(r.buffer.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('N1：没超上限的文件正常返回内容', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dream-'))
  const file = path.join(dir, 'small.md')
  writeFileSync(file, 'hello')
  try {
    const r = readCapped(file, 100)
    assert.equal(r.oversize, false)
    assert.equal(r.bytesRead, 5)
    assert.equal(r.buffer.toString('utf8'), 'hello')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function fakeCtx() {
  let def = null
  const ctx = { inject: (names, fn) => fn({ commands: { register: (d) => { def = d } } }) }
  return { ctx, get: () => def }
}

test('N4：含控制字符的 key 一律在请求前拒绝（C0 / DEL / C1）', async () => {
  const cases = ['\n', '\t', '\u0000', '\u007f', '\u0080', '\u0085', '\u009f']
  for (const ch of cases) {
    const { ctx, get } = fakeCtx()
    const secret = 'sk-secret-with-control-1234567890'
    apply(ctx, { apiKey: `${secret}${ch}X`, sourceDir: os.tmpdir(), outDir: os.tmpdir() })
    const res = await get().handler({ rawInput: 'short' })
    assert.equal(res.kind, 'error', `控件 ${JSON.stringify(ch)} 应该被拒绝`)
    assert.match(res.text, /控制字符/)
    assert.equal(res.text.includes(secret), false)
  }
})

test('N4：配置里的旧字段 sourcePattern 会返回错误，而不是静默回退', async () => {
  const { ctx, get } = fakeCtx()
  const saved = process.env.DEEPSEEK_API_KEY
  try {
    process.env.DEEPSEEK_API_KEY = 'sk-test-1234'
    apply(ctx, { sourcePattern: '^qq-', sourceDir: os.tmpdir(), outDir: os.tmpdir() })
    const res = await get().handler({ rawInput: 'short' })
    assert.equal(res.kind, 'error')
    assert.match(res.text, /sourcePattern/)
  } finally {
    // 断言失败也不能把环境变量泄漏给后面的测试
    if (saved === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = saved
  }
})
