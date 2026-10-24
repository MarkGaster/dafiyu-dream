// 梦的核心：挑素材 → 压成抽象意象 → 写梦 → 自检 → 存文件。
// 被两处复用：仓库里的 index.js（/dream 命令）与工作区里的命令行脚本。
import { closeSync, existsSync, mkdirSync, openSync, opendirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const THEMES = ['深海', '星舰', '奇幻', '玄幻', '蒸汽朋克', '废土', '太空歌剧', '童话']
export const LENGTHS = {
  short: { segments: [3, 4], chars: [150, 250] },
  standard: { segments: [3, 6], chars: [250, 400] },
  long: { segments: [5, 9], chars: [600, 1000] },
}

const DEFAULT_PERSONA = '你是大肥鱼，一条圆滚滚的鲸鱼小女孩。说话软，爱撒娇，偶尔傲娇，但写东西时很认真。'

/** 狂野度的唯一来源：插件、CLI、核心都从这里读，别再各写一份。 */
export const WILDS = ['low', 'mid', 'high']

/** 禁词表：提示词和自检共用一份，否则两边会漂移。 */
export const BANNED = /梦见|梦里我|象征|隐喻/

/**
 * 输入归一化。放在核心而不是适配层：
 * 命令行和插件走同一套校验，`--days abc` 这种也不会把时间窗悄悄关掉。
 */
export function normalizeOptions(opts = {}) {
  const int = (v, min, max, def) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return def
    return Math.min(max, Math.max(min, Math.trunc(n)))
  }
  return {
    length: Object.hasOwn(LENGTHS, opts.length) ? opts.length : 'standard',
    wild: WILDS.includes(opts.wild) ? opts.wild : 'auto',
    windowDays: int(opts.windowDays, 1, 365, 7),
    k: int(opts.k, 1, 20, 6),
    verbatim: opts.verbatim === true,
  }
}

/** 狂野度阈值：单独抽出来才能测，阈值跟着打分公式改时也有回归。 */
export function pickWild(maxScore, wild = 'auto') {
  if (WILDS.includes(wild)) return wild
  return maxScore >= 0.22 ? 'high' : maxScore >= 0.1 ? 'mid' : 'low'
}

const WILD_RULE = {
  low: '世界遵守物理规则，只是场景和物件被换掉了；没有超自然的事发生。',
  mid: '允许一两件现实中不可能的事：东西自己动、时间重复、人浮起来、声音有形状；但不要每段都来一个。',
  high: '彻底不讲理：身份可以互换、空间可以折叠、语言可以失效、因果可以倒着走；唯一的底线是情绪必须连贯。',
}

const EMOTION = ['开心', '难过', '怕', '想你', '喜欢', '爱', '哭', '笑', '累', '气', '委屈', '骄傲', '害羞', '舍不得', '担心', '感动']
const TURN = ['第一次', '终于', '再也不', '突然', '居然', '没想到']

export function intensity(text) {
  if (!text) return 0
  let s = 0
  s += Math.min(1, (text.match(/[!！?？]/g) || []).length / 6) * 0.1
  s += /\p{Extended_Pictographic}/u.test(text) ? 0.15 : 0
  s += Math.min(1, EMOTION.filter((w) => text.includes(w)).length / 3) * 0.25
  s += text.includes('我') && text.includes('你') ? 0.15 : 0
  const sentences = text.split(/[。！？\n]/).filter((x) => x.trim())
  s += (sentences.filter((x) => x.trim().length < 20).length / Math.max(1, sentences.length)) * 0.1
  s += TURN.some((w) => text.includes(w)) ? 0.15 : 0
  s += /(.)\1{2,}/.test(text) ? 0.1 : 0
  return Math.min(1, s)
}

/** 只取「我说」那一段；取不到就返回空，绝不退化成整块。 */
export function userPart(block) {
  const m = block.match(/\*\*我说：\*\*\s*([\s\S]*?)(?:\n\s*---|\*\*DeepSeek说：\*\*|$)/)
  return m ? m[1].trim() : ''
}

/** 适合做梦的素材：有足够中文，不是代码/表格/链接堆。 */
export function dreamable(text) {
  if (!text || text.length < 8) return false
  if (/```|\|.*\|/.test(text)) return false
  if (/(https?:\/\/|C:\\|\/Users\/)/.test(text)) return false
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length
  return cjk / text.length > 0.45
}

// 资源预算：普通素材目录远远用不到，但恶意/误配置的目录不能拖垮宿主
export const BUDGET = {
  maxScanEntries: 2000,
  maxFiles: 500,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  maxCandidates: 5000,
}

/**
 * 经典的双指针 glob 匹配：**不用正则**。
 * 为什么不用正则：`*a*a*a…b` 翻成 `.*a.*a.*a…b` 会指数级回溯——文件名字符串再短也能把主线程钉死。
 * 这个算法最坏 O(模式长度 × 名字长度)，且名字长度有上限。
 */
export function globMatch(pattern, name) {
  let p = 0
  let s = 0
  let star = -1
  let mark = 0
  while (s < name.length) {
    // 必须**先判星号**：否则当文件名里也有 '*' 时，字面相等分支会把它当普通字符吃掉
    if (p < pattern.length && pattern[p] === '*') {
      star = p
      mark = s
      p++
    } else if (p < pattern.length && (pattern[p] === '?' || pattern[p] === name[s])) {
      p++
      s++
    } else if (star !== -1) {
      p = star + 1
      s = ++mark
    } else {
      return false
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++
  return p === pattern.length
}

const MAX_GLOB_LEN = 64
const MAX_GLOB_COUNT = 5

/**
 * 文件名匹配。只认 glob（`*` / `?`），**不接任意正则**；
 * 复杂度和名字长度都有硬上限，写死的 glob 再刁钻也不会卡住。
 */
export function makeMatcher({ sourceGlob, sourcePattern } = {}) {
  // 旧字段必须显式失败：静默丢弃会让用户以为过滤还在，实际选材范围变大
  if (sourcePattern) {
    throw new Error(
      'sourcePattern（任意正则）已不再支持，请改用 sourceGlob（例如 "chat-*.md,qq-*.md"）。\n'
      + '如果你是从旧版本升级的，请先删掉配置里的 sourcePattern。',
    )
  }
  if (sourceGlob) {
    const patterns = String(sourceGlob).split(',').map((x) => x.trim()).filter(Boolean)
    if (patterns.length > MAX_GLOB_COUNT) throw new Error(`sourceGlob 最多支持 ${MAX_GLOB_COUNT} 个模式`)
    for (const pat of patterns) {
      if (pat.length > MAX_GLOB_LEN) throw new Error(`sourceGlob 模式过长（上限 ${MAX_GLOB_LEN} 字符）：${pat.slice(0, 20)}…`)
    }
    return (name) => name.length <= 255 && patterns.some((pat) => globMatch(pat, name))
  }
  return (name) => /^(?:chat|qq)-\d{4}-\d{2}-\d{2}/.test(name)
}

/**
 * 扫描素材目录。
 * 返回 { items, stats }：stats 把"为什么没选上"分门别类数出来，
 * 否则用户只会看到一句"没有可用素材"，完全不知道是文件名、日期还是格式的问题。
 */
export function collect({ memoryDir, windowDays = 7, sourceGlob, sourcePattern, log = () => {} }) {
  const now = Date.now()
  const match = makeMatcher({ sourceGlob, sourcePattern })
  const out = []
  const stats = {
    entries: 0, notMatched: 0, noDate: 0, outsideWindow: 0,
    noSections: 0, noUserPart: 0, filteredOut: 0, kept: 0,
  }
  let files = 0
  let bytes = 0
  const skipped = { count: 0, reasons: new Set() }
  const skip = (why) => { skipped.count++; skipped.reasons.add(why) }

  // 用 opendir 逐条枚举：readdirSync 会一次性分配整个目录列表，超大目录直接吃掉内存
  const dir = opendirSync(memoryDir)
  let scanned = 0
  try {
    for (;;) {
      const entry = dir.readSync()
      if (!entry) break
      if (scanned++ >= BUDGET.maxScanEntries) { skip('枚举条目超上限'); break }
      if (!entry.isFile()) continue
      stats.entries++
      const file = entry.name
      if (file.length > 255 || !match(file)) { stats.notMatched++; continue }
      const m = file.match(/(\d{4}-\d{2}-\d{2})/)
      if (!m) { stats.noDate++; continue }
      const age = Math.max(0, (now - new Date(`${m[1]}T23:00:00`).getTime()) / 86400000)
      if (age > windowDays) { stats.outsideWindow++; continue }

      if (files >= BUDGET.maxFiles) { skip('文件数超上限'); break }
      if (bytes >= BUDGET.maxTotalBytes) { skip('总字节超上限'); break }

      const full = path.join(memoryDir, file)
      // 限量读取：最多读 `cap` 字节。多读 1 字节用来判断"是否超限"，
      // 但**绝不像 readFileSync 那样把整个文件先塞进内存**。
      const cap = Math.min(BUDGET.maxFileBytes, BUDGET.maxTotalBytes - bytes)
      const read = readCapped(full, cap)
      // 先记账再判错：读了一部分之后才抛 EIO 的那种，字节也已经花掉了
      bytes += read.bytesRead
      if (read.error) continue
      if (read.oversize) { skip('单文件超上限'); continue }

      const text = read.buffer.toString('utf8')
      files++

      const blocks = text.split(/^## /m).slice(1)
      if (!blocks.length) { stats.noSections++; continue }
      for (const block of blocks) {
        if (out.length >= BUDGET.maxCandidates) { skip('候选数超上限'); break }
        const body = userPart(block.split('\n').slice(1).join('\n'))
        if (!body) { stats.noUserPart++; continue }
        if (!dreamable(body)) { stats.filteredOut++; continue }
        const tokens = body.length * 0.7
        const score = intensity(body) * (0.5 + 0.5 * Math.min(1, tokens / 800)) * Math.pow(0.7, age)
        if (score > 0) { out.push({ file, date: m[1], age, text: body, score }); stats.kept++ }
      }
      if (out.length >= BUDGET.maxCandidates) break
    }
  } finally {
    dir.closeSync()
  }
  if (skipped.count) logBudget(skipped, log)
  return { items: out, stats }
}

/**
 * 限量读取：最多分配 `cap + 1` 字节，绝不像 readFileSync 那样先整份读进内存。
 * 多读的 1 字节只用来判断"是否超限"，不做其它用途。
 */
export function readCapped(full, cap) {
  let fd
  try {
    fd = openSync(full, 'r')
  } catch {
    return { buffer: Buffer.alloc(0), bytesRead: 0, oversize: false, error: true }
  }
  const limit = cap + 1
  const buf = Buffer.allocUnsafe(limit)
  let n = 0
  try {
    while (n < limit) {
      const r = readSync(fd, buf, n, limit - n, n)
      if (r <= 0) break
      n += r
    }
  } catch {
    return { buffer: Buffer.alloc(0), bytesRead: n, oversize: false, error: true }
  } finally {
    closeSync(fd)
  }
  if (n > cap) return { buffer: Buffer.alloc(0), bytesRead: n, oversize: true }
  return { buffer: buf.subarray(0, n), bytesRead: n, oversize: false }
}

function logBudget(skipped, log) {
  // 不抛错：超出预算只影响素材多少，不该让整场梦失败。
  // 走 log 而不是 console.warn——后者只进宿主 stderr，用户在聊天里看不到。
  const reasons = [...(skipped.reasons || [])].join('、')
  log(`预算：跳过 ${skipped.count} 项（${reasons}）——上限 枚举 ${BUDGET.maxScanEntries} / 文件 ${BUDGET.maxFiles} / 单文件 ${BUDGET.maxFileBytes} 字节 / 合计 ${BUDGET.maxTotalBytes} 字节 / 候选 ${BUDGET.maxCandidates}`)
}


export function sample(items, k) {
  const pool = items.slice()
  const picked = []
  while (picked.length < k && pool.length) {
    const total = pool.reduce((a, x) => a + x.score, 0)
    let r = Math.random() * total
    let i = 0
    for (; i < pool.length; i++) {
      r -= pool[i].score
      if (r <= 0) break
    }
    picked.push(...pool.splice(Math.min(i, pool.length - 1), 1))
  }
  return picked
}

async function chat({ apiKey, model, messages, maxTokens = 900, temperature = 0.9 }) {
  // 必须带超时：否则一次卡住的请求会把 running 闸一直占着
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, thinking: { type: 'disabled' }, messages, max_tokens: maxTokens, temperature }),
    signal: AbortSignal.timeout(60000),
    redirect: 'error',
  })
  // 只报状态码：body 可能回显请求内容（含原文），statusText 也不可信
  if (!res.ok) throw new Error(`API ${res.status}`)
  // res.json() 失败时，原生 SyntaxError 的 message 会带响应片段 —— 不能让它冒出去
  let data
  try {
    data = await res.json()
  } catch {
    throw new Error('API 返回的不是合法 JSON（状态 200）')
  }
  return { text: data.choices?.[0]?.message?.content?.trim() || '', usage: data.usage || {} }
}

export function checkDream(dream, len, verbatim = '') {
  const problems = []
  const chars = dream.replace(/\s/g, '').length
  const paras = dream.split(/\n\s*\n/).filter((p) => p.trim())
  const segs = paras.length
  if (chars < len.chars[0] || chars > len.chars[1] * 1.2) problems.push(`字数 ${chars}（目标 ${len.chars.join('-')}）`)
  if (segs < len.segments[0] || segs > len.segments[1] + 1) problems.push(`段数 ${segs}（目标 ${len.segments.join('-')}）`)
  if (BANNED.test(dream)) problems.push('出现元叙述或解释')
  if (/^##\s/m.test(dream)) problems.push('出现小标题/编号')
  // 括号旁白是聊天口吻，不是梦
  if (/^\s*[（(][^）)\n]{0,40}[）)]\s*$/m.test(dream)) problems.push('出现括号旁白')
  // 原样片段不许落在最后一段：孤零零贴在结尾，一眼就露馅
  if (verbatim && paras.length && paras[paras.length - 1].includes(verbatim)) problems.push('原样片段落在结尾')
  return { problems, chars, segs }
}

/**
 * 生成一场梦并落盘。
 * @returns {Promise<{
 *   file: string, dream: string, draft: boolean,
 *   problems: string[], chars: number, segs: number,
 *   meta: { theme: string, seed: number, length: string, verbatim: string, sources: string[] }
 * }>}
 */
export async function generateDream(opts) {
  const {
    memoryDir, outDir, personaPath, apiKey, model = 'deepseek-flash',
    dryRun = false, log = () => {},
    sourcePattern, sourceGlob,
  } = opts
  // 归一化放在核心里：插件和命令行都不会绕过窗口/长度/狂野度的校验
  const { length, wild, windowDays, k, verbatim: useVerbatim } = normalizeOptions(opts)
  if (!existsSync(memoryDir)) throw new Error('找不到记忆目录')
  const len = LENGTHS[length]
  const { items: candidates, stats } = collect({ memoryDir, windowDays, sourcePattern, sourceGlob, log })
  const picked = sample(candidates, k)
  log(`候选 ${candidates.length} 条 → 抽中 ${picked.length} 条`)
  if (!picked.length) {
    // 告诉用户是哪条规则把素材筛掉了，而不是只说"没有素材"
    const why = [
      stats.notMatched && `${stats.notMatched} 个文件名不匹配`,
      stats.noDate && `${stats.noDate} 个文件名里没有 YYYY-MM-DD`,
      stats.outsideWindow && `${stats.outsideWindow} 个超出 ${windowDays} 天窗口`,
      stats.noSections && `${stats.noSections} 个没有 "## " 段落`,
      stats.noUserPart && `${stats.noUserPart} 段缺少 "**我说：**" 标记`,
      stats.filteredOut && `${stats.filteredOut} 段内容不合格（含代码/链接/中文太少）`,
    ].filter(Boolean).join('；')
    throw new Error(`没有可用素材（扫描 ${stats.entries} 个文件${why ? '：' + why : ''}）。`
      + '素材需要：文件名含日期、位于窗口内、段落以 "## " 开头、且带 "**我说：**" 标记。')
  }

  const theme = THEMES[Math.floor(Math.random() * THEMES.length)]
  const seed = Math.floor(Math.random() * 9000) + 1000
  // 狂野度：手动给了就用；auto 时由抽中素材里权重最高那条决定
  const maxScore = picked.reduce((a, p) => Math.max(a, p.score), 0)
  const wildLevel = pickWild(maxScore, wild)
  log(`主题：${theme}｜长度：${length}｜狂野：${wildLevel}${wild === 'auto' ? `（自动，最高分 ${maxScore.toFixed(2)}）` : ''}`)
  if (dryRun) return { file: '', dream: '', meta: { candidates: candidates.length, picked, theme }, problems: [], dryRun: true }
  if (!apiKey) throw new Error('缺少 API key')

  const material = picked.map((p, i) => `${i + 1}. ${p.text.slice(0, 220)}`).join('\n')
  const seedsRes = await chat({
    apiKey, model,
    messages: [
      {
        role: 'system',
        content: '你是意象压缩器。读完片段**不要总结**，输出 5 行，每行一个抽象意象，每行不超过 8 个字：\n'
          + '第 1 行一个物件，第 2 行一个动作，第 3 行一处场景，第 4 行一种天气，第 5 行一个声音。\n'
          + '严禁出现原文里的具体名词（股票、代码、报错、插件、模型、记忆、考试之类），严禁出现人名和数字。\n'
          + '要的是"那种感觉"，不是"那件事"。只输出这 5 行。',
      },
      { role: 'user', content: `片段：\n\n${material}` },
    ],
    maxTokens: 200, temperature: 1.0,
  })
  // 校验压缩结果：短、无控制字符（含 DEL 与 C1）、无链接。
  // \p{Cc} 覆盖 0x00–0x1F、0x7F 与 0x80–0x9F，比只排 C0 完整。
  const seeds = seedsRes.text
    .split('\n')
    .map((s) => s.replace(/^[\d.、\s-]+/, '').trim())
    .filter((s) => s && s.length <= 8 && !/\p{Cc}/u.test(s) && !/:\/\/|www\./i.test(s))
    .slice(0, 5)
  if (seeds.length < 3) throw new Error('压缩结果不合格（意象少于 3 个），这次先不写了。')
  // 种子本身可能残留原文：默认只报个数，需要排查时用 debug: true
  log(opts.debug ? `种子：${seeds.join(' / ')}` : `意象 ${seeds.length} 个（已通过格式筛选）`)

  const verbatim = useVerbatim ? (picked
    .map((p) => p.text.split(/[。！？\n]/).map((s) => s.trim()))
    .flat()
    // 去掉首尾的引号、破折号、括号——它们会被一起写进 front matter 和提示词
    .map((s) => s.replace(/^[\s“”"'「」『』（()【】—–-]+|[\s“”"'「」『』（()【】—–-]+$/g, ''))
    .filter((s) => s.length >= 6 && s.length <= 14 && /[\u4e00-\u9fff]/.test(s) && !/[()（）]/.test(s))
    // 纯应答句不要：它们孤零零地贴在结尾，一看就露馅
    .filter((s) => !/^(知道|谢谢|好的|好呀|好哦|嗯|哦|哈|诶|欸|对|可以|收到|明白)/.test(s))
    .sort(() => Math.random() - 0.5)[0] || '') : ''

  // 人格文件也限个大小：它每一场都会整份进 system prompt
  const persona = personaPath && existsSync(personaPath) && statSync(personaPath).size <= 64 * 1024
    ? readFileSync(personaPath, 'utf8').trim()
    : DEFAULT_PERSONA
  const system = `${persona}\n\n## 此刻的任务\n你在写一段梦。规则：\n`
    + '- 用第一人称，像真的睡着时那样，不加解释；**不要括号旁白**（那像聊天，不像梦）\n'
    + `- ${len.segments[0]}–${len.segments[1]} 段，${len.chars[0]}–${len.chars[1]} 字，段落之间只用空行，不要小标题、不要「一二三」\n`
    + `- 目标是 ${len.chars[1]} 字 / ${len.segments[1]} 段以内；验收留 20% 容差（约 ${Math.round(len.chars[1] * 1.2)} 字），但请尽量守住目标值\n`
    + `- 主世界是「${theme}」，可以换世界 0–2 次，换了也不要解释\n`
    + '- 不许出现「梦见」「象征」「隐喻」这类词\n'
    + '- 意象里的东西只保留"感觉"，不许把它的名字写进正文\n'
    + '- 结尾停在一句话上，不总结、不升华\n'
    + `- 狂野度：${WILD_RULE[wildLevel]}\n`
    + (verbatim ? `- 有一句话要一字不改地嵌进去，而且必须**自然长在句子里**（不要单独成段、不要放结尾）：「${verbatim}」\n` : '')
  const user = `意象：${seeds.join('、')}\n\n写这一段梦。`

  let dream = (await chat({ apiKey, model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], maxTokens: 2000, temperature: 0.95 })).text
  let report = checkDream(dream, len, verbatim)
  for (let attempt = 0; attempt < 3 && report.problems.length; attempt++) {
    log(`自检不过：${report.problems.join('；')} → 重试 ${attempt + 1}`)
    const hard = `硬指标（不满足就是废稿）：${len.chars[0]}–${len.chars[1]} 字、${len.segments[0]}–${len.segments[1]} 段。`
      + '宁可删掉一整段，也不要超字数；不要只改标点凑数。'
    dream = (await chat({
      apiKey, model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `${user}\n\n${hard}\n上一版不合格：${report.problems.join('；')}。重写，不要解释。` },
      ],
      maxTokens: 2000, temperature: 0.9,
    })).text
    report = checkDream(dream, len, verbatim)
  }

  // 空内容、或自检全挂到没有任何像样文字，就别落盘、别报成功
  if (!dream.trim()) throw new Error('模型返回了空内容，这次不写文件。')
  // 自检没过但内容非空：可以留，但要明确标成草稿，别混进"成功"里
  const isDraft = report.problems.length > 0

  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  mkdirSync(outDir, { recursive: true })
  const head = [
    '---',
    `date: ${day}`,
    `title: 梦 · ${day}`,
    `sources: ${JSON.stringify([...new Set(picked.map((p) => p.file))])}`,
    `verbatim: ${JSON.stringify(verbatim)}`,
    `theme: ${theme}`,
    `length: ${length}`,
    `wild: ${wildLevel}`,
    'rating: 0',
    `seed: ${seed}`,
    ...(isDraft ? ['status: draft', `problems: "${report.problems.join('；').replace(/"/g, '')}"`] : []),
    '---',
    '',
  ].join('\n')

  // 独占创建（wx）：exists 检查和写入之间可能被别人抢先，只有 wx 能保证不覆盖
  let file = ''
  for (let i = 0; i < 5 && !file; i++) {
    const suffix = i === 0 ? '' : `-${Math.random().toString(36).slice(2, 6)}`
    const candidate = path.join(outDir, `dream-${day}-${seed}${suffix}.md`)
    try {
      writeFileSync(candidate, `${head}${dream}\n`, { encoding: 'utf8', flag: 'wx' })
      file = candidate
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
    }
  }
  if (!file) throw new Error('写入失败：连续 5 次撞名，这次不写了。')
  return { file, dream, draft: isDraft, meta: { theme, seed, length, verbatim, sources: picked.map((p) => p.file) }, problems: report.problems, chars: report.chars, segs: report.segs }
}
