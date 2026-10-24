# dafiyu-dream

![dafiyu-dream](docs/assets/banner.png)

> 从最近的对话里挑几段最烫的话，泡成一场**认不出来、但确实是它**的梦。

A dream generator for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): pick the most emotionally charged fragments of recent conversations, compress them into abstract images, write a short dream, self-check it, and save it as a markdown file.

---

## 它做什么

1. **挑素材**：从你导出过的对话 markdown 里按「情感强度 × 长度 × 天数衰减」加权随机抽样
2. **压成意象**：一次调用，把抽中素材的**前 220 字**压成 3–5 个抽象短语（物件 / 动作 / 场景 / 天气 / 声音）
3. **写梦**：第二次调用只拿到这几个短语 + 随机主题 + 人格与固定规则；开启 `verbatim` 时会多一句原句
4. **自检**：字数、段数、元叙述、括号旁白、原样片段位置；不过就最多重写三次（仍不过会标成 status: draft）
5. **落盘**：`dafiyu-dreams/dream-YYYY-MM-DD-<seed>.md`

> 注意：原文确实会发给模型（第 2 步）。详见下面的「隐私」一节。

## 安装

目前只支持从源码目录安装（**还没有发布到 npm**，`package.json` 里是 `private: true`）：

```bash
# 克隆后，在仓库根目录执行
dsh plugin --profile <你的 profile> add link:/absolute/path/to/dafiyu-dream -w
```

`@local/` 前缀是 dsh 给本地链接插件的命名习惯；以后要发 npm 时会改成 `dsh-plugin-dream`。

装完 `/dream` 会出现在输入框的 `/` 菜单里；如果没看到，刷新一下页面。

## 用法

| 输入 | 效果 |
|---|---|
| `/dream` | standard 长度 + 自动狂野度 |
| `/dream short` | 150–250 字 |
| `/dream long` | 600–1000 字 |
| `/dream high` | 最疯狂的档 |
| `/dream long high` | 又长又疯 |

## 配置

全部可选，缺省值按"工作区下找子目录"推：

```yaml
- id: dafiyu-dream
  name: dafiyu-dream
  config:
    sourceDir: dafiyu-memory        # 对话 md 所在目录（相对 workspace 或绝对路径）
    outDir: dafiyu-dreams           # 梦存哪
    personaPath: dafiyu-persona/persona.md   # 可选；没有就用内置的一句话人格
    sourceGlob: 'chat-*.md,qq-*.md'  # 哪些文件名算素材（只支持 * 和 ?，可用逗号写多个）
    apiKey: sk-...                  # 方式一：直接写（配置文件别提交 git）
    apiKeyEnv: DEEPSEEK_API_KEY     # 方式二：从环境变量读（默认就是这个）
    apiKeyFile: ~/.dsh/deepseek.key # 方式三：文件里只放一行 key
    model: deepseek-flash
    length: standard                # short | standard | long
    wild: auto                      # auto | low | mid | high
    windowDays: 7                   # 往前找几天
    k: 6                            # 抽几条素材
    verbatim: false                 # 是否把一句原话一字不改嵌进梦里（默认关）
```

### API key 怎么给

三种，任选其一：

1. **环境变量**（推荐）：`DEEPSEEK_API_KEY=sk-...`。Windows 用 `setx`，macOS/Linux 写进 shell 配置。**改完要重启 DSH**，否则宿主进程读不到。
2. **插件配置** `apiKey: sk-...`：最直接，但会留在 profile 的 `cordis.patch.yml` 里，注意别提交。
3. **key 文件** `apiKeyFile: ~/deepseek.key`：文件内容就是一行 key（也可以放别的东西，插件会从中提取 `sk-` 开头的那段）。

> Windows 上还有一个兜底：如果环境变量是 `setx` 写的、而 DSH 是之前就启动的，插件会去注册表 `HKCU\Environment` 再读一次。这个只对 Windows 有效。

### 狂野度

| 档 | 规则 |
|---|---|
| `low` | 世界遵守物理，只是场景被换掉 |
| `mid` | 允许一两件不可能的事 |
| `high` | 身份互换、空间折叠、语言失效，但情绪必须连贯 |
| `auto` | 按**抽中素材**里最高的加权分决定：≥0.22 → high，≥0.10 → mid，否则 low（权重含长度与天数衰减） |

## 隐私：实际会发出去什么

一场梦最多 **5 次请求**（压缩 1 次 + 写梦 1 次 + 自检不过时最多重写 3 次）。发出去的内容是：

| 请求 | 内容 |
|---|---|
| 压缩 | 每条被抽中素材的**前 220 个 UTF-16 码元原文**（默认最多 6 条） |
| 写梦 / 重试 | **通过格式筛选的 3–5 个短语**（每行 ≤8 字）+ 人格（≤64 KiB 时整份）+ 主题/长度/狂野规则等固定指令 +（开启时）一句原句 |

**请按这个事实理解隐私**：

- 抽象化发生在**远程**。它降低的是"梦读起来不像原文"，**不是"原文不出门"**。
- 那 3–5 个"短语"只保证**格式**（长度、不含控制字符、不含 `://` 或 `www.`），不保证语义：里面可能残留原文片段，也可能夹带短指令。
- 原句嵌入（`verbatim`）**默认关闭**。设为 `true` 后，那句原话会进入请求和落盘的 front matter；关闭它也不阻止模型自己在梦里复述听过的句子。
- 人格文件超过 64 KiB 时**不读取**，改用内置的一句话人格（不会警告）。
- 梦写进配置的 `outDir`，**没有额外 HTTP 上传**；但 `outDir` 若指向网络盘/UNC，写入本身会走网络。
- API key 来自配置 / 环境变量 / 文件（Windows 另有注册表兜底），不写日志；非 2xx 的响应正文不回显，JSON 解析失败也不回显正文片段。

想少发一点：把 `k` 调小、让 `sourceDir` 只放很少的素材，或者先把素材改写成隐喻再喂给它（**本版没有本地抽象器**）。

## 已知限制

- **路径不做沙箱**：`sourceDir` / `outDir` / `personaPath` 是什么就能读写什么。这是本地工具，配置由你掌握；不要指向不可信的目录。
- **提示注入**：素材内容会进入 prompt。压缩结果做了长度与字符校验，但自由文本无法彻底消毒；不要把来路不明的 md 放进 `sourceDir`。单靠一个 md 拿不到你的环境变量或 API key（没有工具授权、重试次数固定）。
- **来源边界**：只读 `sourceDir` 下匹配 `sourceGlob` 的**普通文件**；不递归；目录里的符号链接条目会被 `isFile()` 跳过，但 `sourceDir` 本身若是指向别处的链接，会照着读。
- **资源预算**：枚举最多 2000 条、成功读取最多 500 个文件、单文件 1 MiB、合计 20 MiB、候选 5000 条。文件按**限量读取**处理（最多分配到上限 +1 字节，这一个探测字节是已声明的开销）；被拒绝、甚至读一半报错的字节都计入实际预算；达到上限后不再接纳新文件并打 warning。
- **长度容差**：目标区间是 150–250 / 250–400 / 600–1000 字，检查器另留约 20% 容差（standard 最多约 480 字），超过才算废稿。
- **文件名匹配不接正则**：只认 glob（`*` / `?`，最多 5 个模式、每个 ≤64 字符），用双指针匹配，复杂度受控；配置里出现旧的 `sourcePattern` 会**直接报错**，不会静默忽略。
- **默认工作区**：没配 workspace 时，相对路径以**进程工作目录**为基准，它不一定等于 DSH 的活跃工作区。如果 /dream 报找不到素材目录，请显式设置 sourceDir（或 workspace）。
- Windows 上如果环境变量读不到，会去注册表 `HKCU\Environment` 再读一次（其他平台没有这一步）。

## 素材格式

**这个工具是给中文对话用的**：一段素材里汉字占比低于 45% 会被跳过。

要被选中，一个文件必须同时满足：

| 条件 | 说明 |
|---|---|
| 文件名含 `YYYY-MM-DD` | 日期用来算天数衰减；没日期的文件不参与 |
| 日期在窗口内 | 默认从**今天**往前 7 天（`windowDays` 可改） |
| 每段以 `## ` 开头 | 两个井号加一个空格，不能是 `###` |
| 段落里有 `**我说：**` | 冒号必须是**全角** `：`；只取这一段打分 |

格式长这样：

```markdown
## 10:35 · 一段对话

**我说：**
（你说的话）

---

**DeepSeek说：**
（AI 说的话）
```

筛选是按顺序进行的，所以报错会告诉你卡在哪一步：

```
没有可用素材（扫描 12 个文件：3 个文件名里没有 YYYY-MM-DD；2 个超出 7 天窗口；
4 段缺少 "**我说：**" 标记）
```

## 测试

零依赖，离线跑（不调用模型）：

```bash
npm test          # 等价于 node --test（自动发现 test/ 下的文件）
```

覆盖：glob 匹配（含回溯反例、文件名自带星号、长度上限）、旧字段拒绝、**限量读取**、含控制字符的 key 被拒、自检规则（元叙述/括号旁白/原样片段位置）、打分与抽样的边界。

## 许可

MIT
