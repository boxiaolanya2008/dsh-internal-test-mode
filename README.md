# dsh-plus-mode

**内部测试模式**。它把三件事同时收口，让模型每一步的注意力都落在任务本身：

| 控制点 | 手段 | 默认值 |
|---|---|---|
| 工具数量 | 预设只挂 4 个工具插件行 → 模型看到 **8 个工具** | `read read_image write edit grep glob pwsh todo_write` |
| 系统提示词 | 服从与自我约束、理解人话、知识基线、思考机制、编码习惯、设计风格、交付纪律 | 追加，7 节 |
| 请求参数 | `agent/request` 瀑布里改写 `LlmCallConfig` | **默认不干预**（机制保留，填参数即生效） |

## 演示

同一句提示词，同一个模型，只换 agent 预设：

> 使用HTML制作一个SVG鹈鹕骑自行车网页（只要生成HTML文件就可以，其它别管，直接生成）

|  | **内部测试模式** | 官方网页版 |
|---|---|---|
| 思考等级 | Max | 默认 |
| 随机性 | 0.2（演示时的设置） | 默认 |
| 产物 | [`pelican-bicycle.html`](pelican-bicycle.html) | [`deepseek_html_20260930_f2afb4.html`](deepseek_html_20260930_f2afb4.html) |

> **注**：这次演示跑在本模式的早期设置下（当时默认 `temperature: 0.2`）。上表记录的是**演示当时的条件**，不是当前默认值——当前版本已默认不干预随机性。若要在同样条件下复现，需在 patch 里显式填回 `temperature: 0.2`。

**内部测试模式**（思考等级 Max，temperature 0.2）

![内部测试模式效果](image/image.png)

**官方网页版**

![官方网页版效果](image/image2.png)

### 两个产物的客观差异

| 指标 | 内部测试模式 | 官方网页版 |
|---|---|---|
| 文件大小 | 11,491 B | 12,596 B |
| 行数 | 231 | 274 |
| `<path>` 元素 | **31** | 24 |
| `<circle>` 元素 | **18** | 13 |
| `<g>` 分组 | **15** | 10 |
| `<script>` | 0 | 1 |

内部测试模式的 SVG 结构更细——路径、圆、分组都更多——但文件反而更小、行数更少。差别来自结构更紧凑，而不是堆标记。另一个可见差别是它没有插入 `<script>`，官方版有一段。

**这只是单次样本，不能当统计结论。** 不过方向和提示词里的规则一致：条文写着「只交用户要的东西，不多不少」「不加未经要求的东西」，产物就把预算全花在用户要的那一件事上，没有顺带塞进没人要的交互脚本。

## 自研上下文账本（ledger.js）

这是本项目**自己实现的**上下文告知机制，不依赖 DSH 的 compaction。

**工作方式**

1. 折叠 `session/event`（提交后广播的仅追加事件流）出每个会话的账本；
2. 已结束的轮次压成一行要点，最近 N 轮保持展开；
3. 通过 `systemPrompt.context()` 在**每一次模型请求**前渲染账本。

第 3 步是关键设计。`context()` 的 `text` 接受函数形式，每次请求组装都会重新求值——所以账本不是静态提示词，也**不是往历史里追加消息**（那样会越堆越多），而是每一轮都反映当下的真实状态。这比「每次用户发消息时携带」更细：每一步模型请求都带着它。

**账本长这样**

```markdown
## 上下文账本
本模式自建的进度视图，每次请求重新计算，不是历史原文。被归并的轮次其原文仍在会话日志中，需要时可回读。

- 进度：第 3 轮 / 第 3 步
- 累计：用户消息 3 · 助手回复 1 · 工具调用 3 · 工具结果 1
- 规模：约 534 tokens（2,135 字符估算）

### 近期轮次（完整保留）
- 第 1 轮 — 工具 2 次：read → write
- 第 2 轮 — 工具 1 次：edit

### 当前轮（进行中）
- 第 3 轮 — 请求：「现在推送」｜工具 0 次
```

**措辞上的一个刻意选择**：账本区分「已归并要点」与「完整保留」，而不是说「已压缩」。因为它**不真的压缩**——说成压缩会诱导模型以为细节丢了，从而不敢回读。措辞必须和机制一致，否则就是在骗模型。

| 配置键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | |
| `order` | `500` | 运行时上下文里的排序位 |
| `recentTurns` | `3` | 保持展开的最近轮次数，更早的归并成一行 |
| `maxFiles` | `6` | 一行要点里最多列几个文件 |
| `maxRecentTools` | `8` | 当前轮最多列几次工具调用 |
| `charsPerToken` | `4` | 字符到 token 的换算，与 DSH token meter 的启发式一致 |
| `textFieldCap` | `4096` | 单个文本字段的计费上限，避免超长字段带偏估算 |

## 约束分两层

**能力约束**和**思维约束**是两回事，这里两层都做：

- **能力约束（硬约束，在代码里）**：8 个工具的白名单 + `guard`。模型想调白名单外的工具，调用会被直接拒绝并收到原因。这不是提示词能商量的，是执行层拦下来的。
- **思维约束（软约束，在提示词里）**：约束模型怎么想、产出多少、边界在哪。提示词能显著改变倾向，但它不是强制机制——别指望它像 guard 那样可靠。

## 那段提示词

模式的核心是 `index.js` 里的 `INTERNAL_TEST_PROMPT`，七节。前两节是本模式的主诉求：

| 节 | 管什么 |
|---|---|
| **服从与自我约束** | 用户消息是最高指令；不对抗执行、不擅自扩大范围、不加未经要求的东西 |
| **理解人话** | 人话里没有专业词，只有模糊消息；每条下面压着一个真实问题 |
| 知识基线 | 2026-04 之前只算「过期的参考」；不凭记忆作答；查不到就直说 |
| 思考机制 | 听懂之后先定验收标准；每步落在真实工件上；推理不是交付物 |
| 编码习惯 | 无装饰性注释；导入置顶按字母序；先复用；最小改动；改完必须验证 |
| 设计风格 | 先定接口与数据形状；显式优于隐式；依赖单向；参数不硬编码 |
| 交付纪律 | 只交要的东西，不多不少；结论先行；区分「已验证」与「推测」 |

### 三处我主动加的约束，理由在这里

**1. 防编造条款。** 提示词改不了模型权重，所以「抛弃旧知识」不可能字面实现——它真正生效的是**行为**层面。而只说「按新知识回答」，模型在不知道新事实时会**编造 API、版本号和路径**，那比旧知识更糟。所以条文里写死了「查不到就直说查不到，并说明还缺什么信息」「严禁为了贴合设定而编造」。

**2. 服从的例外出口。** 「一律照做」后面跟了一句：要求物理上做不到、或会不可逆地毁掉东西时，用一句话讲清楚然后停下来问。**只留这一条**——不加这句，模型会照着一个已经删库的命令跑下去；加多了，服从就漏气了。

**3. 推理不是交付物。** 这是「别倒一堆垃圾」在输出层面的对应条文：思考日志、方案对比、心路历程都留在内部，只把结论和必要依据交出来。

工具收敛是**两层**的，这是本项目的关键设计：

- **收敛层（`restrict`）** 把非白名单的全局工具从模型的工具目录里摘掉——目录短了，schema 少了，前缀更稳。
- **强制层（`guard`）** 按每次真实调用判定，白名单外的调用一律拒绝，并返回可读原因。

为什么两层都要：`restrict` 只认「全局工具名」，传进作用域本地注册的名字会直接抛错，而预设行注册的工具可能落在作用域本地。所以 `restrict` 是尽力而为的优化，`guard` 才是不会失效的那道闸。

## 目录结构

```
dsh-plus-mode/
├── index.js                  插件主体：白名单 / 提示词 / 请求参数
├── verify.mjs                自检：用假 ctx 真跑一遍 apply()
├── package.json              普通依赖包（刻意不声明 dsh.bundle）
└── preset/                   组合的可读镜像，实际生效的是 profile patch 里内联的那份
    ├── preset.yml
    └── agent.cordis.yml
```

`package.json` 里**故意没有** `dsh.bundle`。组合包（bundle）会在 profile 层插入行、对所有会话生效；而我们要的是「只有选了这个模式的会话才受限」，所以本包只作为库被预设引用。

## 安装机制（这里踩过坑，务必看完）

**不要往 `$DSH_HOME/.agent-presets/` 放预设。** 那个目录由 `@deepseek-ai/dsh-agent-presets` 扫描，而本 profile 挂载的是另一个包——声明式的 `@deepseek-ai/dsh-agent-preset-registry`。官方 README 写得很直接：

> The registry neither scans directories nor accepts preset paths.

两者职责不同：

| 包 | 作用 | 本 profile |
|---|---|---|
| `@deepseek-ai/dsh-agent-presets` | 扫描 `roots` 配置的目录，从 `agent.cordis.yml` 装载 | **未挂载** |
| `@deepseek-ai/dsh-agent-preset-registry` | 声明式注册表，预设由插件行声明 | 已挂载 |

所以在 `.agent-presets/` 下建目录**永远不会生效**（那里现存的 `bench-omni` 同样没生效过）。正确做法是官方 README 给的那一句：

> A new preset or an override of a shipped one is a bundle patch: an `insert` of a `@deepseek-ai/dsh-agent-preset` row.

## 安装

两处，都在工作区之外。已经装好了，下面是复现步骤。

```powershell
$HOME_DSH = "$env:USERPROFILE\.dsh"
$PROFILE_DIR = "$HOME_DSH\profiles\desktop"
```

### 第 1 步：让插件包可被解析

预设行里的包名从**宿主组合**解析，不是从预设目录。所以插件包要落在 profile 的 `node_modules` 上。本 profile 的 `@local/tokensqueezer` 就是这么装的，照抄：

```powershell
$link = "$PROFILE_DIR\node_modules\dsh-plus-mode"
New-Item -ItemType Junction -Path $link -Target "D:\31702\dsh-plus-mode"
```

并在 `$PROFILE_DIR\package.json` 的 `dependencies` 里加一行（**不要**加进 `dsh.profile.bundles`，那样会对所有模式生效）：

```json
"dsh-plus-mode": "link:D:/31702/dsh-plus-mode"
```

### 第 2 步：在 profile patch 里声明预设

往 `$PROFILE_DIR\cordis.patch.yml` **末尾追加**这个 insert 块：

```yaml
- insert:
    - id: preset-plus-mode
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: plus-mode
        name: 内部测试模式
        description: '内部测试模式：不沿用 2026 年 4 月之前的默认做法，配一套全新的思考机制、编码习惯与设计风格；模型只看到 8 个工具。'
        plugins:
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
          - id: tool-fs-search
            name: '@deepseek-ai/dsh-tool-fs-search'
            config:
              sampleOverCapGlobResults: false
          - id: tool-bash
            name: '@deepseek-ai/dsh-tool-bash'
            disabled: !!js process.platform === 'win32'
          - id: tool-pwsh
            name: '@deepseek-ai/dsh-tool-pwsh'
            disabled: !!js process.platform !== 'win32'
          - id: tool-todo
            name: '@deepseek-ai/dsh-tool-todo'
            config:
              allowParallelInProgress: true
          - id: plus-mode
            name: 'dsh-plus-mode'
            config:
              tools:
                allow: [read, read_image, write, edit, grep, glob, pwsh, bash, todo_write]
                enforce: true
                hideGlobal: true
              prompt:
                enabled: true
                replace: false
                suppressContext: false
                order: 0
              request:
                enabled: true
                force: false
```

`cordis.patch.yml` 是启动关键文件，改坏了整个 app 起不来。建议先备份，改完确认它仍是合法 YAML。

**注意两个必填字段。** `@deepseek-ai/dsh-tool-fs-search` 的 `sampleOverCapGlobResults` 和 `@deepseek-ai/dsh-tool-todo` 的 `allowParallelInProgress` 在 schema 里**没有默认值**，漏掉会让整行装载失败并报 `missing required value`。其余工具行（`tool-fs`、`tool-bash`、`tool-pwsh`）可以不带 `config`。`verify.mjs` 里有一条断言专门守这个坑。

**`read_image` 不需要新的插件行。** 原生看图工具由 `@deepseek-ai/dsh-tool-fs` 注册——官方对该包 0.2.0-rc.2 的描述是 "the model-facing **read, read_image, write, and edit** tools"，和 `read`/`write`/`edit` 同属一个包。所以开放看图能力只是把 `read_image` 加进 `tools.allow`，插件行一行都不用加。

（注意别被 npm 上 `latest` 标签的旧 README 误导：那条标签指向 8 月的 0.0.1-rc.1，其中写着 "PDF/image/multimodal content are deferred"。该说法在运行时对应的 0.2.0-rc.2 里已经不成立。）

### 第 3 步：重启

预设注册表在启动时读取。重启后新会话的模式选择器里会出现「内部测试模式」。

## 使用

在会话的模式切换器里选「内部测试模式」。切换只对**尚未产生任何内容**的会话开放——已经跑过的会话换组合会让历史里的工具调用失去对应工具，所以这个限制是产品规则，不是 bug。

确认生效：让 agent 列出它的工具，应当只有 7 个；或者试调一个白名单外的工具，会收到：

```
精简模式未开放工具 "web_search"；可用工具：read、read_image、write、edit、grep、glob、pwsh、bash、todo_write
```

## 调参

改 profile patch 里 `plus-mode` 那一行的 `config`，重启（或热重载）生效：

| 键 | 默认 | 说明 |
|---|---|---|
| `tools.allow` | 9 个名字 | 白名单。两个 shell 名字都写上，实际只存在对应平台那个，不会多出工具 |
| `tools.enforce` | `true` | `false` = 只靠 restrict 收敛，不做硬拒绝 |
| `tools.hideGlobal` | `true` | `false` = 不尝试从工具目录摘除宿主工具 |
| `prompt.replace` | `false` | `true` = 这段规则成为**唯一**提示词段 |
| `prompt.suppressContext` | `false` | `true` = 不再注入动态运行上下文 |
| `prompt.text` | `INTERNAL_TEST_PROMPT` | 不写则用插件内置的「内部测试模式」提示词 |
| `request.temperature` | 未设置 | 不写就不碰这个参数 |
| `request.force` | `false` | `true` = 覆盖上游已设的值，抢到这个旋钮 |
| `request.maxTokens` | 未设置 | 不写就完全不碰这个参数 |

`request` 段默认是**彻底的直通**：四个参数全部为 `undefined` 时，合并函数原样返回上游对象，一次分配都不做。要重新控制随机性，在 patch 里填上 `temperature` 即可：

```yaml
              request:
                enabled: true
                temperature: 0.2
                force: false
```

`force: false` 时，若上游已有别的插件设过同一个键，本插件让路；想要确定性控制就设 `force: true`。

### 换成「只有一小段提示词」的极限形态

```yaml
prompt:
  replace: true      # complete 段：成为唯一提示词段
  suppressContext: true
```

这会丢掉工具说明和运行上下文，前缀长度降到最低、缓存命中最稳，但模型对工具用法只能靠 schema 自己推断。是否划算取决于评测集，建议两种都跑一遍再定。

## 自检

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node "D:\31702\dsh-plus-mode\verify.mjs"
```

25 项断言，覆盖配置校验、守卫判定、参数合并、`apply()` 的装载行为、以及预设文件结构。不需要 harness、不需要联网、不需要装任何依赖。

## 已知边界

- **工作区 `preset/` 与 profile patch 是两份。** 生效的是 patch 里内联的那份；改 `preset/` 不会自动同步过去。这是声明式预设的固有约束——`plugins` 列表必须内联，没法引用外部文件。
- **不使用 DSH 自带的 compaction。** `dsh-compaction-basic` 走的是会话日志的 *surface replacement*（追加 `{ surfaceOp: { op:'replace', start, end }, sourceEventSeqs }` 真的改写历史），事务复杂且出错即持久损坏日志。本项目自建账本，走「不动日志、只做呈现层归并」的路线。详见下一节。
- **账本不省 token。** 它让模型始终知道进度、历史构成、哪些轮次被归并了，但不缩减实际上下文。物理压缩是后续路线 B 的事。
- **`restrict` 可能静默降级。** 失败时插件打一行 `warn` 并继续，`guard` 仍生效，所以工具数量上限有保障，只是模型目录里可能残留几个宿主工具。
- **`temperature` 是建议值不是保证。** 某些模型路由不接受该参数，适配器可能忽略它。
- **绝对路径也受支持。** 如果哪天不想要 junction，控制器行可以写成 `name: 'D:/31702/dsh-plus-mode/index.js'`，官方 README 确认绝对路径保留自身位置并会被转成 `file:` URL。

## 开发：热加载

改插件代码默认要重启整个 Harness。原因查清了：**base bundle 用 `root: []` 启用 HMR**——空数组表示不监视任何源码模块，只保留显式配置监视（profile patch 等）。而且默认根目录是 profile，本项目在工作区里，天然不在监视范围。

已在 profile patch 末尾打开：

```yaml
- id: hmr
  disabled: false
  config:
    base: 'D:/31702/dsh-plus-mode'
    root: ['.']
    ignored: ['**/node_modules', '**/.*', 'cache', 'data']
    debounce: 100
```

`base` 是模块监视的基准目录，`root` 是相对它的监视根。四个键**全部显式写出**——patch 替换整行 `config` 而不是深合并，漏掉的键会回落到 schema 默认值，写出来更不容易被将来默认值的变化坑到。

### 生效范围

| 改动 | 是否热加载 |
|---|---|
| `index.js` / `ledger.js` 源码 | ✅ 保存即重载 |
| profile patch 里的 `config` | ✅ 本来就是热更新 |
| `package.json` 的 `exports` / 新增文件 | ⚠️ 模块图变了，重启更稳 |
| 换插件包版本、装新依赖 | ❌ 官方明确要求重启 |

### 为什么我们的插件能安全热加载

Cordis 里**每个注册都是一次可逆的 effect**，插件卸载时会自动撤销。我们的两处关键注册——`tools.guard()` 和 `systemPrompt.context()`——都通过 `ctx.effect()` / `ctx.on()` 挂载，重载时旧的会被清掉，不会出现「守卫叠加两层」。

账本的状态放在 `apply()` 的闭包里，重载即重建、旧的自然被回收。

### 两个要留意的副作用

- **重载会改变请求前缀**。本插件贡献提示词段和上下文，重载后模型看到的前缀变了，KV cache 从变化点起失效。这是预期行为，不是 bug。
- **不要在模型轮次进行中重载**。会话正跑着的时候换掉工具守卫，会让本轮后续的工具调用按新规则判定。改完等这一轮结束再保存。

## 参考

全部实现依据官方文档与本地只读接口：

- [Cordis 入门](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer)
- [第一个 Harness 插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)
- [插件配置](https://deepseek-harness.github.io/deepseek-harness/develop/basic/config)
- [打包与安装插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)
- [事件系统](https://deepseek-harness.github.io/deepseek-harness/develop/framework/events)
- `@deepseek-ai/dsh-agent-preset-registry` 与 `@deepseek-ai/dsh-agent-presets` 的官方包 README
