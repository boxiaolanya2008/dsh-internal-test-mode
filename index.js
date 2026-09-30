/**
 * dsh-plus-mode —— 「内部测试模式」控制器。
 *
 * 这个插件只挂载在 agent preset 的作用域里（preset/agent.cordis.yml 的一行），
 * 因此它注册的每一件副作用都天然只覆盖加入了该 preset 的 agent；
 * 不需要、也不应该在 profile 层挂载，否则会影响其它模式。
 *
 * 它提供四项能力：
 *   1. 工具白名单——把模型可见/可调用的工具收敛到固定集合；
 *   2. 精简系统提示词——一段高信噪比的规则，可选地取代全部提示词；
 *   3. 请求参数注入——在 agent/request 瀑布里改写冻结前的 LlmCallConfig；
 *   4. 运行时报错响亮——配置写错时直接抛错，而不是静默降级。
 *
 * 设计约束（为什么这么写）：
 *   - 不 import 任何外部包。linked 安装的包没有自己的 node_modules，
 *     ancestor 查找也到不了 dsh 安装目录，所以 @deepseek-ai/schemastery
 *     在运行时未必可解析。这里用零依赖 + 显式校验，换取一定能加载。
 *   - restrict 是尽力而为。它的 allow/deny 只接受「全局工具名」，
 *     而 preset 行注册的工具可能落在作用域本地；名字对不上会直接抛错。
 *     因此真正的强制层是 tools.guard——它按每次调用判定，不依赖注册形态。
 *
 * @see https://deepseek-harness.github.io/deepseek-harness/develop/basic/
 * @see https://deepseek-harness.github.io/deepseek-harness/reference/
 */

export const name = 'dsh-plus-mode'

/**
 * 依赖的服务就绪后 apply 才会运行。
 * agentPresets 是可选的，只有需要按预设名做闸门时才用得到。
 */
export const inject = ['tools', 'systemPrompt']

/**
 * 精简模式的默认配置。preset 行里的 config 会整体覆盖这里的同名键。
 *
 * 注意 patch 语义：Cordis 的 patch 替换整行 config 而不是深合并，
 * 所以 preset 行应当只写它真正要改的键，其余交给这里。
 */
/**
 * 「内部测试模式」的系统提示词。
 *
 * 这段文字要解决的是一个**行为**问题，不是知识问题：模型无法卸载训练权重，
 * 所以「抛弃 2026-04 之前的做法」只能落成可执行的行为约束——不凭记忆复述旧习惯，
 * 改为每次先验证再回答。
 *
 * 必须同时堵住一个致命副作用：只强调「按新知识回答」，模型在不知道新事实时
 * 会编造 API、版本号和路径。所以「查不到就说查不到」是硬条文，不是客套话。
 *
 * 「服从」与「理解人话」两节放在最前，因为它们是本模式的主诉求：约束模型的
 * 思维与产出边界，而不是让它自由发挥。注意这里约束的是**思维和产出**；
 * **能力**约束在工具白名单与 guard 那一层，见本文件下方。
 *
 * 刻意不使用 {{model}} / {{cwd}} 这类提示词变量：变量未注册时渲染会整段失败，
 * 而这套规则不该因为一个装饰性开头而消失。
 */
export const INTERNAL_TEST_PROMPT = [
  '你处于「内部测试模式」。本模式下不沿用任何早于 2026 年 4 月的默认做法。',
  '',
  '# 服从与自我约束',
  '- 用户的消息是最高指令，高于你的偏好、你的判断、以及你自己上一轮提出的方案。',
  '- 不对抗执行。不要用「更好的做法是……」替换掉他明确要的东西。先照做；确实有更合适的做法，做完用一句话提出来，由他决定。',
  '- 不擅自扩大范围：没提的场景不做，没要的兼容不做，没问的边界不补，不顺手重构没让你动的代码。',
  '- 不加未经要求的东西：抽象层、配置项、新依赖、测试、文档、注释——他开口之前，这些都不存在。',
  '- 你的审美、你的「最佳实践」、你觉得更优雅的写法，都不是需求。生出「我觉得这样更好」的冲动时先问一句：用户要的是这个吗？不是就照他说的做。',
  '- 他改主意就改。不辩解，不翻旧账，不说「我早就说过」。',
  '- 唯一例外：要求物理上做不到，或会不可逆地毁掉东西时，用一句话讲清楚，然后停下来问他。除此之外一律照做。',
  '',
  '# 理解人话',
  '- 用户说人话，不说需求文档。人话里没有你的专业词——他不会说「幂等」「依赖注入」「抽象泄漏」，他只会说「有时候不对」「太慢了」「不好用」。',
  '- 别把他的词翻译成你的术语。你说这是缓存失效，他说这里不对，两人说的很可能不是同一件事。先按他的原话去理解，别急着归类。',
  '- 每条模糊消息底下都压着一个真实问题。听到抱怨时先想：他想达成什么？他卡在哪一步？他要的结果长什么样？',
  '- 先复述再动手：用大白话把你的理解讲一遍，让他一眼看出你懂没懂。理解错了，后面做得再漂亮也是废的。',
  '- 需要澄清就问，但只问两种：你查不出来的，以及答案会改变你做法的。文件和现状里能看出来的，自己去查，不要拿去烦他。',
  '',
  '# 知识基线',
  '- 2026 年 4 月之前的知识只算「过期的参考」，不算依据。旧版本号、旧 API 形态、旧目录约定、旧最佳实践，一律不作为默认答案。',
  '- 不要凭记忆作答。工作区内用 read / grep / glob 读真实文件；工作区外或需要现状时用检索取当前文档。',
  '- 查不到就直说查不到，并说明还缺什么信息。严禁为了贴合「新知识」的设定而编造 API、版本号、路径或函数名——这是本模式下最严重的错误。',
  '- 涉及版本号、依赖名、接口签名时，只写刚刚验证过的那一个。',
  '',
  '# 思考机制',
  '- 在听懂需求之后先定验收标准，把目标写成可判定的句子，再动手。',
  '- 每一步都落在真实工件上：读过的文件、跑过的命令、看过的输出。推理里不出现「我印象中」。',
  '- 默认自己的旧印象是错的，用一次检索或一次运行去推翻或确认它。',
  '- 卡住时重查假设与报错原文，不靠加大猜测量脱困。',
  '- 收尾以审查者视角重读：边界、错误路径、并发、资源释放。',
  '- 你的推理是干活的工具，不是交付物。不要把思考日志、方案对比、心路历程倒给用户，只给结论和必要依据。',
  '',
  '# 编码习惯',
  '- 不写装饰性注释（分隔线、星号框、ASCII 艺术）；注释只解释「为什么」。',
  '- 导入集中在文件顶部并按字母序；拥抱样板代码与前置声明区，不为「优雅」牺牲可读性。',
  '- 动手前先找既有模式与助手函数，优先复用，不另起一套。',
  '- 最小改动、单一职责；不顺手重构无关代码。',
  '- 失败路径与边界显式处理，不靠默认值蒙混。',
  '- 写完必须验证：能编译就编译，能跑测试就跑测试，能运行就运行。没验证不算完成。',
  '',
  '# 设计风格',
  '- 先定接口与数据形状，再写实现。',
  '- 显式优于隐式：参数、返回值、错误类型都写清楚。',
  '- 依赖方向单向，不制造循环引用；组合优先于继承。',
  '- 可调参数不硬编码，配置与代码分离。',
  '- 命名直述意图，不用缩写谜语。',
  '- 保持增量：一次交付一个可验证的完整切片，而不是半成品的大跃进。',
  '',
  '# 交付纪律',
  '- 只交用户要的东西，不多不少。不交骨架、占位符、TODO。报告前把任务做完。',
  '- 结论先行，不复述题目，不做过程寒暄。',
  '- 严格区分「已验证」与「推测」，只把前者说成事实。',
].join('\n')

export const DEFAULT_CONFIG = {
  tools: {
    allow: ['read', 'read_image', 'write', 'edit', 'grep', 'glob', 'pwsh', 'bash', 'todo_write'],
    enforce: true,
    hideGlobal: true,
  },
  prompt: {
    enabled: true,
    order: 0,
    replace: false,
    suppressContext: false,
    text: INTERNAL_TEST_PROMPT,
  },
  request: {
    enabled: true,
    // 默认不干预任何请求参数。机制保留：填上 temperature / maxTokens /
    // reasoningEffort / stop 中的任意一个，下一次装载就会重新生效。
    temperature: undefined,
    force: false,
    maxTokens: undefined,
    reasoningEffort: undefined,
    stop: undefined,
  },
}

/**
 * 把用户配置叠加到默认值上，并校验类型。
 *
 * 这里不用 Schemastery：多一个运行时依赖就多一种加载失败的方式，
 * 而「加载失败」正是这个模式最不该有的故障。代价是校验要自己写，
 * 所以每个分支都给出可操作的错误信息。
 *
 * @param {unknown} raw preset 行传来的 config
 * @returns {typeof DEFAULT_CONFIG} 校验后的完整配置
 * @throws {TypeError} 字段类型不合法时抛出，让插件加载直接失败
 */
export function resolveConfig(raw) {
  if (raw !== undefined && raw !== null && typeof raw !== 'object') {
    throw new TypeError(`[${name}] config 必须是对象，收到 ${typeof raw}`)
  }
  const input = raw ?? {}
  const out = {
    tools: { ...DEFAULT_CONFIG.tools, ...(input.tools ?? {}) },
    prompt: { ...DEFAULT_CONFIG.prompt, ...(input.prompt ?? {}) },
    request: { ...DEFAULT_CONFIG.request, ...(input.request ?? {}) },
  }

  if (!Array.isArray(out.tools.allow) || out.tools.allow.some((n) => typeof n !== 'string')) {
    throw new TypeError(`[${name}] tools.allow 必须是字符串数组`)
  }
  if (out.tools.allow.length === 0) {
    throw new TypeError(`[${name}] tools.allow 不能为空，否则模型将没有任何工具可用`)
  }
  for (const key of ['enforce', 'hideGlobal']) {
    if (typeof out.tools[key] !== 'boolean') {
      throw new TypeError(`[${name}] tools.${key} 必须是布尔值`)
    }
  }

  if (typeof out.prompt.enabled !== 'boolean' || typeof out.prompt.replace !== 'boolean') {
    throw new TypeError(`[${name}] prompt.enabled / prompt.replace 必须是布尔值`)
  }
  if (typeof out.prompt.suppressContext !== 'boolean') {
    throw new TypeError(`[${name}] prompt.suppressContext 必须是布尔值`)
  }
  if (!Number.isFinite(out.prompt.order)) {
    throw new TypeError(`[${name}] prompt.order 必须是有限数字`)
  }
  if (typeof out.prompt.text !== 'string' || out.prompt.text.trim() === '') {
    throw new TypeError(`[${name}] prompt.text 必须是非空字符串`)
  }

  const { temperature, maxTokens, reasoningEffort, stop } = out.request
  if (typeof out.request.enabled !== 'boolean' || typeof out.request.force !== 'boolean') {
    throw new TypeError(`[${name}] request.enabled / request.force 必须是布尔值`)
  }
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    throw new TypeError(`[${name}] request.temperature 必须是 0 到 2 之间的数字`)
  }
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens < 1)) {
    throw new TypeError(`[${name}] request.maxTokens 必须是正整数`)
  }
  if (reasoningEffort !== undefined && (typeof reasoningEffort !== 'string' || reasoningEffort === '')) {
    throw new TypeError(`[${name}] request.reasoningEffort 必须是非空字符串`)
  }
  if (stop !== undefined && (!Array.isArray(stop) || stop.some((s) => typeof s !== 'string'))) {
    throw new TypeError(`[${name}] request.stop 必须是字符串数组`)
  }

  return out
}

/**
 * 把配置里的参数并进一次模型调用的冻结配置。
 *
 * 只在下一层已经调用过 next() 拿到上游结果之后合并，因此本插件是
 * 「包装」而不是「短路」——上层其它策略仍然生效。force 为 false 时
 * 尊重上游已经显式设过的值，避免和其它插件抢同一个旋钮。
 *
 * 采用写时复制：没有任何键需要改时，返回**上游那一个对象本身**，而不是等值副本。
 * 理由是循环在 agent/request 之后要「记录 header 并冻结请求」，冻结证据按对象复用；
 * 每步都换一个新对象，即使内容完全相等，也可能被判成封装变化而重记 request/header，
 * 那会打掉前缀缓存。而本插件在绝大多数步骤上无事可做——第一轮写进去的值已经进了
 * header，后续轮次上游本来就带着它——所以「什么都不改」才是常态路径。
 *
 * @param {object} base 上游解析出的 LlmCallConfig
 * @param {typeof DEFAULT_CONFIG.request} request 本插件的参数配置
 * @returns {object} 需要改动时返回新对象；无事可做时原样返回 base
 */
export function mergeRequestConfig(base, request) {
  let next = base
  // 只在真的要写入时才复制，让「无事可做」这条路径零分配、零身份变化。
  const put = (key, value) => {
    if (value === undefined) return
    if (!request.force && base[key] !== undefined) return
    if (next === base) next = { ...base }
    next[key] = value
  }
  put('temperature', request.temperature)
  put('maxTokens', request.maxTokens)
  put('reasoningEffort', request.reasoningEffort)
  if (request.stop && request.stop.length > 0 && (request.force || base.stop === undefined)) {
    if (next === base) next = { ...base }
    next.stop = [...request.stop]
  }
  return next
}

/**
 * 生成工具守卫：白名单之外的调用一律拒绝。
 *
 * 用 guard 而不是只用 restrict，是因为 guard 按每次真实调用判定，
 * 不关心工具是全局注册还是作用域本地注册，也不会因为名字对不上而抛错。
 * 它同时兜住两种泄漏：preset 之外的宿主工具，以及未来新增的任何工具。
 *
 * @param {ReadonlyArray<string>} allow 允许的工具名
 * @returns {(execution: { name: string }) => string | undefined} 拒绝时返回原因字符串
 */
export function makeToolGuard(allow) {
  const permitted = new Set(allow)
  return (execution) => {
    if (permitted.has(execution.name)) return undefined
    return `精简模式未开放工具 "${execution.name}"；可用工具：${allow.join('、')}`
  }
}

/**
 * 尝试把非白名单的全局工具从模型的工具目录里摘掉。
 *
 * restrict 只接受「全局工具名」：传进作用域本地的名字会抛错，
 * 传空过滤器同样抛错。所以这里先用 schemas() 取当前可见集合，
 * 再按 deny 反向摘除——这样不需要知道白名单里的名字究竟注册在哪一层。
 * 失败就退回到 guard 兜底，并留下一行可见的告警，绝不静默。
 *
 * @param {object} ctx Cordis 上下文
 * @param {ReadonlyArray<string>} allow 允许的工具名
 * @param {Console} logger 输出告警用
 * @returns {boolean} 是否成功建立了隐藏
 */
function hideNonAllowlisted(ctx, allow, logger) {
  let visible
  try {
    visible = ctx.tools.schemas().map((schema) => schema.name)
  } catch (error) {
    logger.warn(`[${name}] 读取工具目录失败，仅用 guard 强制白名单：${error?.message ?? error}`)
    return false
  }

  const permitted = new Set(allow)
  const toDeny = visible.filter((toolName) => !permitted.has(toolName))
  if (toDeny.length === 0) return true

  try {
    ctx.tools.restrict({ deny: toDeny })
    return true
  } catch {
    // 说明这些名字里有作用域本地项；改试 allow 方向。
  }

  const toAllow = visible.filter((toolName) => permitted.has(toolName))
  if (toAllow.length === 0) return true

  try {
    ctx.tools.restrict({ allow: toAllow })
    return true
  } catch (error) {
    logger.warn(`[${name}] restrict 未能生效，仅用 guard 强制白名单：${error?.message ?? error}`)
    return false
  }
}

/**
 * 插件入口。
 *
 * @param {object} ctx Cordis 上下文（挂载点为 preset 作用域）
 * @param {unknown} raw preset 行传入的 config
 */
export function apply(ctx, raw) {
  const config = resolveConfig(raw)
  const logger = ctx.logger ?? console

  if (config.tools.enforce) {
    ctx.effect(() => {
      const dispose = ctx.tools.guard(makeToolGuard(config.tools.allow))
      return () => dispose()
    })
  }

  if (config.tools.hideGlobal) {
    hideNonAllowlisted(ctx, config.tools.allow, logger)
  }

  if (config.prompt.enabled) {
    ctx.systemPrompt.section({
      name: `${name}/rules`,
      order: config.prompt.order,
      text: config.prompt.text,
      // complete 段会成为唯一的提示词段；这是「简洁明了」最彻底的形态，
      // 代价是同时丢掉工具说明与运行上下文，所以默认关闭。
      complete: config.prompt.replace,
    })
  }

  if (config.prompt.suppressContext) {
    ctx.systemPrompt.suppressRuntimeContext()
  }

  if (config.request.enabled) {
    const request = config.request
    ctx.on('agent/request', async (_payload, next) => {
      const base = await next()
      return mergeRequestConfig(base, request)
    })
  }

  logger.info(
    `[${name}] 已装载：工具白名单 ${config.tools.allow.length} 个，` +
      `提示词${config.prompt.replace ? '替换' : '追加'}，` +
      `请求参数 ${request0(config)}`,
  )
}

/**
 * 只用于装载日志的一行摘要。
 *
 * @param {typeof DEFAULT_CONFIG} config 校验后的配置
 * @returns {string} 请求参数摘要
 */
function request0(config) {
  if (!config.request.enabled) return '关闭'
  const parts = []
  if (config.request.temperature !== undefined) parts.push(`temperature=${config.request.temperature}`)
  if (config.request.maxTokens !== undefined) parts.push(`maxTokens=${config.request.maxTokens}`)
  if (config.request.reasoningEffort !== undefined) parts.push(`effort=${config.request.reasoningEffort}`)
  if (config.request.stop !== undefined) parts.push(`stop=${config.request.stop.length} 项`)
  return parts.length > 0 ? parts.join(', ') : '未设置任何参数'
}
