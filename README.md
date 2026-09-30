# dsh-plus-mode

**内部测试模式**。它把三件事同时收口，让模型每一步的注意力都落在任务本身：

| 控制点 | 手段 | 默认值 |
|---|---|---|
| 工具数量 | 预设只挂 4 个工具插件行 → 模型看到 **7 个工具** | `read write edit grep glob pwsh todo_write` |
| 系统提示词 | 服从与自我约束、理解人话、知识基线、思考机制、编码习惯、设计风格、交付纪律 | 追加，7 节 |
| 请求参数 | `agent/request` 瀑布里改写 `LlmCallConfig` | `temperature: 0.2` |

## 演示

同一句提示词，同一个模型，只换 agent 预设：

> 使用HTML制作一个SVG鹈鹕骑自行车网页（只要生成HTML文件就可以，其它别管，直接生成）

|  | **内部测试模式** | 官方网页版 |
|---|---|---|
| 思考等级 | Max | 默认 |
| 随机性 | **0.2** | 默认 |
| 产物 | [`pelican-bicycle.html`](pelican-bicycle.html) | [`deepseek_html_20260930_f2afb4.html`](deepseek_html_20260930_f2afb4.html) |

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

## 约束分两层

**能力约束**和**思维约束**是两回事，这里两层都做：

- **能力约束（硬约束，在代码里）**：7 个工具的白名单 + `guard`。模型想调白名单外的工具，调用会被直接拒绝并收到原因。这不是提示词能商量的，是执行层拦下来的。
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
        description: '内部测试模式：不沿用 2026 年 4 月之前的默认做法，配一套全新的思考机制、编码习惯与设计风格；模型只看到 7 个工具。'
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
                allow: [read, write, edit, grep, glob, pwsh, bash, todo_write]
                enforce: true
                hideGlobal: true
              prompt:
                enabled: true
                replace: false
                suppressContext: false
                order: 0
              request:
                enabled: true
                temperature: 0.2
                force: false
```

`cordis.patch.yml` 是启动关键文件，改坏了整个 app 起不来。建议先备份，改完确认它仍是合法 YAML。

**注意两个必填字段。** `@deepseek-ai/dsh-tool-fs-search` 的 `sampleOverCapGlobResults` 和 `@deepseek-ai/dsh-tool-todo` 的 `allowParallelInProgress` 在 schema 里**没有默认值**，漏掉会让整行装载失败并报 `missing required value`。其余工具行（`tool-fs`、`tool-bash`、`tool-pwsh`）可以不带 `config`。`verify.mjs` 里有一条断言专门守这个坑。

### 第 3 步：重启

预设注册表在启动时读取。重启后新会话的模式选择器里会出现「内部测试模式」。

## 使用

在会话的模式切换器里选「内部测试模式」。切换只对**尚未产生任何内容**的会话开放——已经跑过的会话换组合会让历史里的工具调用失去对应工具，所以这个限制是产品规则，不是 bug。

确认生效：让 agent 列出它的工具，应当只有 7 个；或者试调一个白名单外的工具，会收到：

```
精简模式未开放工具 "web_search"；可用工具：read、write、edit、grep、glob、pwsh、bash、todo_write
```

## 调参

改 profile patch 里 `plus-mode` 那一行的 `config`，重启（或热重载）生效：

| 键 | 默认 | 说明 |
|---|---|---|
| `tools.allow` | 8 个名字 | 白名单。两个 shell 名字都写上，实际只存在对应平台那个，不会多出工具 |
| `tools.enforce` | `true` | `false` = 只靠 restrict 收敛，不做硬拒绝 |
| `tools.hideGlobal` | `true` | `false` = 不尝试从工具目录摘除宿主工具 |
| `prompt.replace` | `false` | `true` = 这段规则成为**唯一**提示词段 |
| `prompt.suppressContext` | `false` | `true` = 不再注入动态运行上下文 |
| `prompt.text` | `INTERNAL_TEST_PROMPT` | 不写则用插件内置的「内部测试模式」提示词 |
| `request.temperature` | `0.2` | |
| `request.force` | `false` | `true` = 覆盖上游已设的值，抢到这个旋钮 |
| `request.maxTokens` | 未设置 | 不写就完全不碰这个参数 |

`request` 里除 `temperature` 外的键默认 `undefined`，**不写就不会被注入**——插件只碰你显式给值的参数。

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
- **没带 compaction。** 本预设不含 `compaction-basic` 与 `tool-result-pruner`，长时间运行可能撞上下文上限。需要的话加一个带 `isolate` realm 的 group——服务行必须放在 `isolate` 组里，这是挂载时强制的。
- **`restrict` 可能静默降级。** 失败时插件打一行 `warn` 并继续，`guard` 仍生效，所以工具数量上限有保障，只是模型目录里可能残留几个宿主工具。
- **`temperature` 是建议值不是保证。** 某些模型路由不接受该参数，适配器可能忽略它。
- **绝对路径也受支持。** 如果哪天不想要 junction，控制器行可以写成 `name: 'D:/31702/dsh-plus-mode/index.js'`，官方 README 确认绝对路径保留自身位置并会被转成 `file:` URL。

## 参考

全部实现依据官方文档与本地只读接口：

- [Cordis 入门](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer)
- [第一个 Harness 插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)
- [插件配置](https://deepseek-harness.github.io/deepseek-harness/develop/basic/config)
- [打包与安装插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)
- [事件系统](https://deepseek-harness.github.io/deepseek-harness/develop/framework/events)
- `@deepseek-ai/dsh-agent-preset-registry` 与 `@deepseek-ai/dsh-agent-presets` 的官方包 README
