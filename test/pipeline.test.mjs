// 端到端（不打网络）：把 fetch 换成本地桩，跑完整生成流程。
// 覆盖第三、四轮审查关心的几条：能落盘、草稿语义、front matter 合法、空素材报原因。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateDream, pickWild, BANNED } from '../dream-core.mjs'

const today = (() => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
})()

function fixture(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dream-e2e-'))
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body, 'utf8')
  return dir
}

const sample = `## 10:00 · 一条

**我说：**

今天在实验室做了一下午的数据，累得不行，但是教授说做得挺好，心里还是挺开心的，晚上回去想吃大白米饭。

---

**DeepSeek说：**

（大肥鱼蹭蹭你）
`

const goodDream = [
  '灯光从天花板上落下来，落在我面前的桌子上，桌面上摊着很多纸，纸上的字在慢慢移动，像被水推着走，我伸手按住一张，它就停下来了，停得很轻，好像怕惊动什么，又好像它一直在等我这样做。',
  '有人在旁边坐下，没有说话，只是把一杯温水推到我手边。水面上浮着一点光，我低头看了很久，久到忘记自己本来想说什么，也忘记了外面是什么时辰，只记得杯子的边上有一道很浅的缺口。',
  '后来那点光沉下去了，屋子里只剩下很轻的呼吸声，我也跟着闭上眼睛，慢慢地，把自己收进那一小片暖里，像收好一件旧衣服，叠得方方正正，放在最上面的那一格。那一格很高，我踮起脚才够得到，够到的时候，指尖沾了一点灰。',
].join('\n\n')

function stubFetch(dreamText, { seeds = ['暖手旧物', '轻轻一碰', '桌前微光', '晴转多云', '细响'] } = {}) {
  const calls = []
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body)
    const userText = body.messages.at(-1).content
    calls.push(userText)
    const isDream = String(userText).startsWith('意象：')
    const content = isDream ? dreamText : seeds.join('\n')
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return calls
}

test('完整跑通：两次请求、写出文件、front matter 合法、非草稿', async () => {
  const dir = fixture({ [`chat-${today}-01.md`]: sample })
  const outDir = path.join(dir, 'out')
  const saved = globalThis.fetch
  const calls = stubFetch(goodDream)
  try {
    const r = await generateDream({ memoryDir: dir, outDir, personaPath: '', apiKey: 'sk-test-1234', length: 'standard' })
    assert.equal(calls.length, 2)
    assert.equal(r.draft, false)
    const text = readFileSync(r.file, 'utf8')
    assert.match(text, /^---\n/)
    assert.match(text, /verbatim: ""/)
    assert.match(text, /sources: \["chat-.*\.md"\]/)
  } finally {
    globalThis.fetch = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test('自检一直不过：标成草稿，但文件里有 status: draft 和 problems', async () => {
  const dir = fixture({ [`chat-${today}-01.md`]: sample })
  const outDir = path.join(dir, 'out')
  const saved = globalThis.fetch
  const calls = stubFetch('我梦见了一只鲸。\n\n它象征着自由。\n\n然后我醒了。')
  try {
    const r = await generateDream({ memoryDir: dir, outDir, personaPath: '', apiKey: 'sk-test-1234', length: 'short' })
    assert.equal(calls.length, 5) // 1 压缩 + 1 初稿 + 3 重写
    assert.equal(r.draft, true)
    const text = readFileSync(r.file, 'utf8')
    assert.match(text, /status: draft/)
    assert.match(text, /problems:/)
  } finally {
    globalThis.fetch = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test('文件名里带逗号和方括号，front matter 仍然是合法 YAML', async () => {
  const dir = fixture({ [`a, b] ${today}.md`]: sample })
  const outDir = path.join(dir, 'out')
  const saved = globalThis.fetch
  stubFetch(goodDream)
  try {
    const r = await generateDream({ memoryDir: dir, outDir, personaPath: '', apiKey: 'sk-test-1234', sourceGlob: '*.md', length: 'standard' })
    const text = readFileSync(r.file, 'utf8')
    const line = text.split('\n').find((l) => l.startsWith('sources:'))
    // JSON 字符串数组：引号把逗号和方括号都包住了
    assert.match(line, /^sources: \["a, b\] \d{4}-\d{2}-\d{2}\.md"\]$/)
  } finally {
    globalThis.fetch = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test('没有素材时报出具体原因，而不是只说"没有素材"', async () => {
  const dir = fixture({
    'no-date.md': sample,
    'chat-2020-01-01.md': sample,
  })
  const saved = globalThis.fetch
  stubFetch(goodDream)
  try {
    await assert.rejects(
      () => generateDream({
        memoryDir: dir,
        outDir: path.join(dir, 'out'),
        personaPath: '',
        apiKey: 'sk',
        length: 'short',
        sourceGlob: '*.md', // 先让文件名都进入匹配，才能测到"没有日期"这条规则
      }),
      (err) => /文件名里没有 YYYY-MM-DD/.test(err.message) && /超出 7 天窗口/.test(err.message),
    )
  } finally {
    globalThis.fetch = saved
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pickWild：阈值和手动覆盖', () => {
  assert.equal(pickWild(0.3), 'high')
  assert.equal(pickWild(0.22), 'high')
  assert.equal(pickWild(0.15), 'mid')
  assert.equal(pickWild(0.1), 'mid')
  assert.equal(pickWild(0.05), 'low')
  assert.equal(pickWild(0.9, 'low'), 'low')
})

test('禁词表是一份：象征单独出现也会被判不合格', () => {
  assert.equal(BANNED.test('这里象征着什么'), true)
  assert.equal(BANNED.test('一段普通的文字'), false)
})
