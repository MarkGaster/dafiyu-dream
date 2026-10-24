// 大肥鱼的梦 · DSH 插件：注册 `/dream` 命令，直接生成一场梦。
//
// 设计要点（都是踩过的坑）：
//   - 不导出 Config：cordis 把纯对象当 schema 会静默 failed。
//   - 命令 handler 返回 { kind, text }，与 dsh-project-memory 的 /tasks 一致。
//   - 同一时刻只允许一场梦（running 闸），避免连点两次烧两份 token。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { generateDream, LENGTHS, WILDS } from './dream-core.mjs'

export const name = 'dafiyu-dream'
export const inject = ['commands']

/** `~/x` → 家目录；相对路径 → 相对 base。 */
function resolvePath(p, base) {
  if (!p) return ''
  const expanded = String(p).replace(/^~(?=$|[\\/])/, os.homedir())
  return path.resolve(base, expanded)
}

/** 只接受有限的整数：Infinity / NaN / 小数 / 超大值都退回默认值。 */
function clampInt(v, min, max, def) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/**
 * 配置解析：所有路径都可以不填，按「工作区根 → 默认子目录」推。
 * 原则：**不假设用户和作者用同一套目录**，缺哪个就报哪个。
 */
function resolveConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  // 旧字段必须**显式失败**：留着不管会让用户以为过滤还在，实际选材范围变大
  if (raw.sourcePattern !== undefined) {
    throw new Error('配置里的 sourcePattern 已不再支持。请改成 sourceGlob（例如 "chat-*.md,qq-*.md"）后重启 DSH。')
  }
  const base = resolvePath(raw.workspace || process.cwd(), process.cwd())
  const sourceDir = resolvePath(raw.sourceDir || 'dafiyu-memory', base)
  const outDir = resolvePath(raw.outDir || 'dafiyu-dreams', base)
  const personaPath = resolvePath(raw.personaPath || 'dafiyu-persona/persona.md', base)
  const sourceGlob = raw.sourceGlob ? String(raw.sourceGlob) : ''
  return {
    ...raw,
    base,
    sourceDir,
    outDir,
    personaPath,
    // 这个也要展开 ~，否则 README 里写的 ~/.dsh/deepseek.key 会失效
    apiKeyFile: raw.apiKeyFile ? resolvePath(raw.apiKeyFile, base) : '',
    model: raw.model || 'deepseek-flash',
    // `constructor` 这种键会命中 Object 原型，必须用 hasOwn
    length: Object.hasOwn(LENGTHS, raw.length) ? raw.length : 'standard',
    wild: [...WILDS, 'auto'].includes(raw.wild) ? raw.wild : 'auto',
    windowDays: clampInt(raw.windowDays, 1, 365, 7),
    k: clampInt(raw.k, 1, 20, 6),
  }
}

function validate(cfg) {
  if (!existsSync(cfg.sourceDir)) {
    return `找不到素材目录：${cfg.sourceDir}\n`
      + '请在插件配置里设置 sourceDir（放着你导出过的对话 md 的目录），或把它放在工作区下的 dafiyu-memory/。'
  }
  if (!statSync(cfg.sourceDir).isDirectory()) return `sourceDir 不是目录：${cfg.sourceDir}`
  return ''
}

/**
 * 找 API key。三种通用方式，按顺序试：
 *   1. 插件配置的 apiKey（最直接，但会留在配置文件里）
 *   2. 环境变量（默认 DEEPSEEK_API_KEY，可用 apiKeyEnv 改名）
 *   3. apiKeyFile 指向的文件：整份文件就是 key，读进来 trim 即可
 * 另外保留一个 Windows 专属兜底：注册表 HKCU\Environment（setx 写进去、宿主进程却读不到的情况）。
 */
function resolveKey(cfg) {
  if (cfg.apiKey) return String(cfg.apiKey).trim()

  const envName = cfg.apiKeyEnv || 'DEEPSEEK_API_KEY'
  if (process.env[envName]) return String(process.env[envName]).trim()

  if (cfg.apiKeyFile && existsSync(cfg.apiKeyFile)) {
    try {
      const text = readFileSync(cfg.apiKeyFile, 'utf8').trim()
      // 兼容“文件里只放 key”和“文件里是 config.mjs 那种带 apiKey: 的写法”
      const m = text.match(/sk-[A-Za-z0-9]+/)
      if (m) return m[0]
    } catch {
      /* 读不到就继续往下 */
    }
  }

  if (process.platform === 'win32') {
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', envName], { encoding: 'utf8' })
      const m = out.match(new RegExp(`${envName}\\s+REG_\\w+\\s+(\\S+)`))
      if (m) return m[1]
    } catch {
      /* 读不到就算了，下面会报缺 key */
    }
  }
  return ''
}

const KEY_HELP = '没找到 API key。三选一：\n'
  + '① 设置环境变量 DEEPSEEK_API_KEY（改完要重启 DSH）\n'
  + '② 在插件配置里写 apiKey: sk-...\n'
  + '③ 把 key 单独存成文件，用 apiKeyFile: /path/to/key 指向它'

export function apply(ctx, config) {
  // 配置错误不能让整个插件 fiber 挂掉：记下来，等用户敲 /dream 时说清楚
  let cfg = null
  let cfgError = ''
  try {
    cfg = resolveConfig(config)
  } catch (err) {
    cfgError = err?.message || String(err)
  }
  let running = false

  const definition = {
    name: 'dream',
    description: '做一场梦：从最近的对话里挑素材，写一段不像日记的梦（可选 short / standard / long 与 low / mid / high）',
    handler: async (invocation) => {
      if (cfgError) return { kind: 'error', text: `插件配置有问题：${cfgError}` }
      const raw = String(invocation?.rawInput || '').trim()
      const tokens = raw.split(/\s+/).filter(Boolean)
      // 两个词都能省：/dream、/dream long、/dream high、/dream long high
      const length = tokens.find((t) => Object.hasOwn(LENGTHS, t)) || cfg.length
      const wild = tokens.find((t) => WILDS.includes(t)) || cfg.wild
      if (running) return { kind: 'error', text: '上一场梦还没醒呢，等一下下。' }

      const bad = validate(cfg)
      if (bad) return { kind: 'error', text: bad }

      const apiKey = resolveKey(cfg)
      if (!apiKey) return { kind: 'error', text: KEY_HELP }
      // 控制字符（C0 + DEL + C1，用 \p{Cc} 覆盖全）会让 HTTP 头构造抛异常，
      // 而原生的异常消息里可能带着整个 key
      if (/\p{Cc}/u.test(apiKey)) {
        return { kind: 'error', text: 'API key 里含有控制字符（比如换行或制表符），请检查配置/环境变量后重试。' }
      }

      running = true
      const logs = []
      try {
        const result = await generateDream({
          memoryDir: cfg.sourceDir,
          outDir: cfg.outDir,
          personaPath: existsSync(cfg.personaPath) ? cfg.personaPath : '',
          apiKey,
          model: cfg.model,
          length,
          wild,
          windowDays: cfg.windowDays,
          k: cfg.k,
          sourceGlob: cfg.sourceGlob,
          verbatim: cfg.verbatim === true,
          log: (m) => logs.push(m),
        })
        const tail = result.draft
          ? `\n\n（这一篇自检没过，已标成草稿存下：${result.problems.join('；')}）`
          : ''
        return {
          kind: 'success',
          text: `${result.dream}\n\n---\n${logs.join('\n')}\n已存：${result.file}${tail}`,
        }
      } catch (err) {
        // 统一出口脱敏：先把真实 key 抹掉，再抹 sk- 形状的串。
        // 原生异常（比如 Request 头校验）会把整个 key 拼进 message，只靠正则不够。
        let msg = String(err?.message || err)
        if (apiKey) msg = msg.split(apiKey).join('sk-***')
        msg = msg.replace(/sk-[^\s"'`]{4,}/g, 'sk-***')
        return { kind: 'error', text: `梦没做成：${msg}` }
      } finally {
        running = false
      }
    },
  }

  ctx.inject(['commands'], (commandsCtx) => {
    commandsCtx.commands.register(definition)
  })
}
