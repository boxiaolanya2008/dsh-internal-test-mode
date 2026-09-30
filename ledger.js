/**
 * dsh-plus-mode / ledger —— 自研上下文账本。
 *
 * 为什么自建：DSH 的 compaction 走「会话日志的 surface replacement」，
 * 会真的改写历史，代价是持久化事务复杂、出错即损坏日志。本账本换一条路：
 * **不动日志，只做呈现层的归并**。
 *
 * 工作方式：
 *   1. 折叠 `session/event`（仅追加、提交后广播）出每个会话的账本；
 *   2. 把已经结束的轮次压缩成一行要点，最近 N 轮保持展开；
 *   3. 通过 `systemPrompt.context()` 在**每一次模型请求**前渲染这份账本。
 *
 * 第 3 步是关键：`context()` 的 text 是函数形式，每次组装请求都会重新求值，
 * 所以账本不是静态提示词，也不是往历史里追加消息（那会越堆越多），
 * 而是每一轮都反映当下的真实状态。
 *
 * 诚实的边界：本插件**不省 token**。它让模型始终知道「现在到哪了、之前发生过
 * 什么、哪些被归并了」，但不缩减实际上下文。物理压缩是路线 B 的事。
 */

export const name = 'dsh-plus-mode/ledger'

export const inject = ['systemPrompt']

export const DEFAULT_CONFIG = {
  enabled: true,
  // 运行时上下文里的排序位。数值越小越靠前；取中段以便与其它贡献者共存。
  order: 500,
  // 保持展开的最近轮次数，更早的轮次归并成一行。
  recentTurns: 3,
  // 一行要点里最多列几个文件。
  maxFiles: 6,
  // 账本里最多列几次近期工具调用。
  maxRecentTools: 8,
  // 字符到 token 的换算。DSH token meter 用的是 4 字符 ≈ 1 token。
  charsPerToken: 4,
  // 单个字符串字段超过这个长度按该长度计入，避免极长字段把估算带偏。
  textFieldCap: 4096,
}

/**
 * 校验并叠加配置。
 *
 * 与主插件同样的取舍：不引第三方 schema，自己校验并给可操作的错误信息。
 *
 * @param {unknown} raw preset 行传来的 config
 * @returns {typeof DEFAULT_CONFIG} 校验后的配置
 * @throws {TypeError} 字段不合法时抛出，让插件加载直接失败
 */
export function resolveConfig(raw) {
  if (raw !== undefined && raw !== null && typeof raw !== 'object') {
    throw new TypeError(`[${name}] config 必须是对象，收到 ${typeof raw}`)
  }
  const input = raw ?? {}
  const out = { ...DEFAULT_CONFIG, ...input }

  if (typeof out.enabled !== 'boolean') {
    throw new TypeError(`[${name}] enabled 必须是布尔值`)
  }
  for (const key of ['order', 'recentTurns', 'maxFiles', 'maxRecentTools', 'charsPerToken', 'textFieldCap']) {
    if (!Number.isFinite(out[key]) || out[key] < 0) {
      throw new TypeError(`[${name}] ${key} 必须是非负数字`)
    }
  }
  if (out.charsPerToken <= 0) {
    throw new TypeError(`[${name}] charsPerToken 必须大于 0`)
  }
  return out
}

/**
 * 新建一个空账本。
 *
 * @returns {object} 账本状态
 */
export function createLedger() {
  return {
    turns: [],
    steps: 0,
    counts: { user: 0, assistant: 0, toolCall: 0, toolResult: 0, other: 0 },
    chars: 0,
    startedMidway: false,
  }
}

/**
 * 估算一段会话数据里可读文本的字符数。
 *
 * 只统计 `text` 字段并设上限：这个数字用于给模型一个量级感，不是精确计费，
 * 所以宁可少走几层也不做完整遍历。
 *
 * @param {unknown} value 待估算的值
 * @param {number} cap 单个字段的计费上限
 * @param {number} [depth] 当前递归深度
 * @returns {number} 估算字符数
 */
export function estimateChars(value, cap, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return 0
  if (typeof value === 'string') return Math.min(value.length, cap)
  if (typeof value !== 'object') return 0
  if (Array.isArray(value)) {
    let sum = 0
    for (const item of value) sum += estimateChars(item, cap, depth + 1)
    return sum
  }
  let sum = 0
  for (const [key, item] of Object.entries(value)) {
    if (key === 'text' || key === 'content' || key === 'arguments' || key === 'summary') {
      sum += estimateChars(item, cap, depth + 1)
    }
  }
  return sum
}

/**
 * 从工具调用参数里挑出像文件路径的字符串。
 *
 * 不解析 JSON——参数是流式拼出来的字符串，解析失败是常态。用正则捞路径足够用。
 *
 * @param {unknown} args 工具调用参数
 * @returns {string[]} 形似路径的字符串
 */
export function extractPaths(args) {
  if (typeof args !== 'string' || args === '') return []
  const found = new Set()
  // 不能排除反斜杠：Windows 路径在 JSON 参数里是转义过的 `\\`，
  // 一旦写进字符组就永远匹配不上。让正则宽松，靠下面的过滤把关。
  const pattern = /"([^"]{2,180})"/g
  let match
  while ((match = pattern.exec(args)) !== null) {
    const value = match[1]
    if (/^[\w./\\:-]+\.[A-Za-z0-9]{1,8}$/.test(value) || /[/\\]/.test(value)) {
      if (!/^https?:\/\//.test(value)) found.add(value)
    }
  }
  return [...found].slice(0, 8)
}

/**
 * 把一条会话事件折进账本。
 *
 * 事件类型与字段全部按需读取，缺失就跳过——账本是观测设施，
 * 绝不能因为某个字段换了名字就抛错打断整条链。
 *
 * @param {object} ledger 账本状态
 * @param {{ type?: string, data?: unknown }} event 会话事件
 * @param {number} cap 文本字段计费上限
 */
export function foldEvent(ledger, event, cap) {
  const type = event?.type
  const data = event?.data
  const chars = estimateChars(data, cap)
  ledger.chars += chars

  switch (type) {
    case 'turn/start': {
      ledger.turns.push({
        index: ledger.turns.length + 1,
        request: '',
        tools: [],
        files: new Set(),
        chars: 0,
        closed: false,
      })
      break
    }
    case 'turn/end': {
      const turn = ledger.turns[ledger.turns.length - 1]
      if (turn) turn.closed = true
      break
    }
    case 'step/start':
      ledger.steps += 1
      break
    case 'user/message': {
      ledger.counts.user += 1
      const turn = ledger.turns[ledger.turns.length - 1]
      if (turn && turn.request === '') {
        turn.request = firstText(data).slice(0, 120)
      }
      break
    }
    case 'assistant/message':
      ledger.counts.assistant += 1
      break
    case 'tool/call': {
      ledger.counts.toolCall += 1
      const turn = ledger.turns[ledger.turns.length - 1]
      if (turn) {
        const toolName = data?.name ?? data?.toolName ?? '?'
        turn.tools.push(toolName)
        for (const path of extractPaths(data?.arguments)) turn.files.add(path)
        turn.chars += chars
      }
      break
    }
    case 'tool/result':
      ledger.counts.toolResult += 1
      break
    default:
      ledger.counts.other += 1
  }

  const turn = ledger.turns[ledger.turns.length - 1]
  if (turn && !turn.closed) turn.chars += chars
}

/**
 * 取一段数据里第一处文本。
 *
 * @param {unknown} value 数据
 * @returns {string} 文本或空串
 */
function firstText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = firstText(item)
      if (text) return text
    }
    return ''
  }
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    for (const item of Object.values(value)) {
      const text = firstText(item)
      if (text) return text
    }
  }
  return ''
}

/**
 * 把账本渲染成给模型看的一段文本。
 *
 * 措辞刻意区分「已归并要点」与「完整保留」，因为本插件不做物理压缩：
 * 说成「已压缩」会诱导模型以为细节丢失，从而不敢回读。
 *
 * @param {object} ledger 账本状态
 * @param {typeof DEFAULT_CONFIG} config 配置
 * @returns {string} 渲染结果，无内容时为空串
 */
export function renderLedger(ledger, config) {
  if (!ledger || ledger.turns.length === 0) return ''

  const lines = []
  lines.push('## 上下文账本')
  lines.push(
    `本模式自建的进度视图，每次请求重新计算，不是历史原文。` +
      `被归并的轮次其原文仍在会话日志中，需要时可回读。`,
  )
  lines.push('')

  const tokens = Math.round(ledger.chars / config.charsPerToken)
  lines.push(
    `- 进度：第 ${ledger.turns.length} 轮 / 第 ${ledger.steps} 步`,
  )
  lines.push(
    `- 累计：用户消息 ${ledger.counts.user} · 助手回复 ${ledger.counts.assistant} · ` +
      `工具调用 ${ledger.counts.toolCall} · 工具结果 ${ledger.counts.toolResult}`,
  )
  lines.push(`- 规模：约 ${tokens.toLocaleString('en-US')} tokens（${ledger.chars.toLocaleString('en-US')} 字符估算）`)
  if (ledger.startedMidway) {
    lines.push('- 注意：本账本从中途开始记录，更早的轮次未纳入统计')
  }

  const closed = ledger.turns.filter((t) => t.closed)
  const open = ledger.turns.filter((t) => !t.closed)
  const digest = closed.slice(0, Math.max(0, closed.length - config.recentTurns))
  const expanded = closed.slice(Math.max(0, closed.length - config.recentTurns))

  if (digest.length > 0) {
    lines.push('')
    lines.push(`### 已归并轮次（第 1 - ${digest[digest.length - 1].index} 轮，仅要点）`)
    for (const turn of digest) {
      const files = [...turn.files].slice(0, config.maxFiles)
      const shown = files.length > 0 ? `｜文件 ${files.join('、')}` : ''
      const more = turn.files.size > files.length ? `（另有 ${turn.files.size - files.length} 个）` : ''
      const request = turn.request === '' ? '(未记录请求文本)' : turn.request
      lines.push(`- 第 ${turn.index} 轮 — 「${request}」｜工具 ${turn.tools.length} 次${shown}${more}`)
    }
  }

  if (expanded.length > 0) {
    lines.push('')
    lines.push(`### 近期轮次（完整保留）`)
    for (const turn of expanded) {
      const tools = turn.tools.slice(-config.maxFiles)
      lines.push(`- 第 ${turn.index} 轮 — 工具 ${turn.tools.length} 次${tools.length > 0 ? `：${tools.join(' → ')}` : ''}`)
    }
  }

  if (open.length > 0) {
    lines.push('')
    lines.push(`### 当前轮（进行中）`)
    for (const turn of open) {
      const tools = turn.tools.slice(-config.maxRecentTools)
      lines.push(
        `- 第 ${turn.index} 轮 — 请求：「${turn.request || '(未记录)'}」｜工具 ${turn.tools.length} 次` +
          (tools.length > 0 ? `：${tools.join(' → ')}` : ''),
      )
      const files = [...turn.files]
      if (files.length > 0) lines.push(`  触及文件：${files.slice(0, 12).join('、')}${files.length > 12 ? ' …' : ''}`)
    }
  }

  return lines.join('\n')
}

/**
 * 插件入口。
 *
 * @param {object} ctx Cordis 上下文（挂载点为 preset 作用域）
 * @param {unknown} raw preset 行传入的 config
 */
export function apply(ctx, raw) {
  const config = resolveConfig(raw)
  if (!config.enabled) {
    ;(ctx.logger ?? console).info(`[${name}] 已禁用`)
    return
  }

  const ledgers = new Map()

  // session/event 是提交后的广播，因此这里看到的历史已经落盘、可回放。
  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined || id === null) return
    let ledger = ledgers.get(id)
    if (!ledger) {
      ledger = createLedger()
      // 会话在插件装载之前就已开始：账本只覆盖我们看得到的部分，如实标注。
      if (event?.type !== 'turn/start') ledger.startedMidway = true
      ledgers.set(id, ledger)
    }
    foldEvent(ledger, event, config.textFieldCap)
  })

  // 函数形式的 text 在每次请求组装时求值，账本因此始终反映当下。
  ctx.systemPrompt.context({
    name: `${name}/state`,
    order: config.order,
    text: (assembleContext) => {
      const sessionId = assembleContext?.scope?.id
      if (sessionId === undefined || sessionId === null) return ''
      return renderLedger(ledgers.get(sessionId), config)
    },
  })

  ;(ctx.logger ?? console).info(
    `[${name}] 已装载：每轮携带账本，保留最近 ${config.recentTurns} 轮展开`,
  )
}
