/**
 * dsh-plus-mode 自检。
 *
 * 不依赖 harness、不依赖任何第三方包：用假的 ctx 把 apply() 真跑一遍，
 * 断言它确实注册了预期的副作用，而不是只做语法检查。
 * 用法：node verify.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const {
  DEFAULT_CONFIG,
  INTERNAL_TEST_PROMPT,
  apply,
  makeToolGuard,
  mergeRequestConfig,
  name,
  resolveConfig,
} = await import('./index.js')

const root = new URL('./', import.meta.url)
let passed = 0

/**
 * 极简测试运行器。
 *
 * @param {string} label 用例名
 * @param {() => void} body 断言体
 */
function test(label, body) {
  try {
    body()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    console.error(`fail  ${label}`)
    throw error
  }
}

/**
 * 造一个只记录调用的 Cordis 上下文替身。
 *
 * @param {{ schemas?: Array<{ name: string }> }} [options] 工具目录等注入点
 * @returns {object} 替身上下文，附带 calls 便于断言
 */
function fakeContext(options = {}) {
  const calls = { guard: [], restrict: [], section: [], suppress: 0, on: [] }
  const disposers = []
  const ctx = {
    calls,
    logger: { info() {}, warn() {} },
    tools: {
      schemas: () => options.schemas ?? [],
      guard(guard) {
        calls.guard.push(guard)
        return () => disposers.push('guard')
      },
      restrict(filter) {
        calls.restrict.push(filter)
        if (options.restrictThrows) throw new Error('unknown tool name')
        return () => disposers.push('restrict')
      },
    },
    systemPrompt: {
      section(section) {
        calls.section.push(section)
        return () => disposers.push('section')
      },
      suppressRuntimeContext() {
        calls.suppress += 1
        return () => disposers.push('suppress')
      },
    },
    effect(fn) {
      fn()
      return () => disposers.push('effect')
    },
    on(event, handler) {
      calls.on.push({ event, handler })
      return () => disposers.push('on')
    },
  }
  return { ctx, calls, disposers }
}

console.log(`\n${name} @ ${fileURLToPath(root)}\n`)

console.log('导出面')
test('导出 name / apply / DEFAULT_CONFIG', () => {
  assert.equal(name, 'dsh-plus-mode')
  assert.equal(typeof apply, 'function')
  assert.equal(typeof DEFAULT_CONFIG.tools.allow, 'object')
})

console.log('\n配置校验')
test('空配置回落到默认值', () => {
  const config = resolveConfig(undefined)
  assert.equal(config.request.temperature, 0.2)
  assert.equal(config.request.force, false)
  assert.equal(config.prompt.replace, false)
  assert.equal(config.tools.enforce, true)
})

test('局部覆盖只改指定键', () => {
  const config = resolveConfig({ request: { temperature: 0 } })
  assert.equal(config.request.temperature, 0)
  assert.equal(config.request.enabled, true)
  assert.equal(config.tools.allow.length, DEFAULT_CONFIG.tools.allow.length)
})

test('temperature 越界抛错', () => {
  assert.throws(() => resolveConfig({ request: { temperature: 3 } }), /temperature/)
})

test('空白名单抛错', () => {
  assert.throws(() => resolveConfig({ tools: { allow: [] } }), /allow 不能为空/)
})

test('非对象 config 抛错', () => {
  assert.throws(() => resolveConfig('nope'), /必须是对象/)
})

console.log('\n工具守卫')
test('放行白名单内的工具', () => {
  const guard = makeToolGuard(['read', 'grep'])
  assert.equal(guard({ name: 'read' }), undefined)
  assert.equal(guard({ name: 'grep' }), undefined)
})

test('拒绝白名单外的工具并说明原因', () => {
  const guard = makeToolGuard(['read'])
  const reason = guard({ name: 'plugin_manager' })
  assert.match(reason, /精简模式未开放工具 "plugin_manager"/)
  assert.match(reason, /read/)
})

test('默认白名单含 read_image（原生看图工具，由 dsh-tool-fs 注册）', () => {
  const allow = DEFAULT_CONFIG.tools.allow
  assert.ok(allow.includes('read_image'), '缺少 read_image')
  for (const required of ['read', 'write', 'edit', 'grep', 'glob', 'todo_write']) {
    assert.ok(allow.includes(required), `缺少 ${required}`)
  }
  assert.ok(
    allow.includes('pwsh') || allow.includes('bash'),
    '至少要有一个 shell 工具',
  )
})

test('看图的守卫判定与其它工具一致', () => {
  const guard = makeToolGuard(DEFAULT_CONFIG.tools.allow)
  assert.equal(guard({ name: 'read_image' }), undefined, 'read_image 应当放行')
  assert.match(guard({ name: 'web_search' }), /未开放/, '不在默认白名单的 web_search 应被拒')
})

console.log('\n请求参数合并')
test('默认不覆盖上游已设的值', () => {
  const merged = mergeRequestConfig({ provider: 'p', model: 'm', temperature: 1 }, DEFAULT_CONFIG.request)
  assert.equal(merged.temperature, 1)
  assert.equal(merged.provider, 'p')
})

test('上游未设时注入默认 temperature', () => {
  const merged = mergeRequestConfig({ provider: 'p', model: 'm' }, DEFAULT_CONFIG.request)
  assert.equal(merged.temperature, 0.2)
})

test('force=true 时覆盖上游', () => {
  const request = { ...DEFAULT_CONFIG.request, force: true }
  const merged = mergeRequestConfig({ temperature: 1, model: 'm' }, request)
  assert.equal(merged.temperature, 0.2)
})

test('undefined 参数不写入配置', () => {
  const merged = mergeRequestConfig({ model: 'm' }, DEFAULT_CONFIG.request)
  assert.equal('maxTokens' in merged, false)
  assert.equal('reasoningEffort' in merged, false)
})

test('stop 数组被复制而非共享引用', () => {
  const stop = ['</s>']
  const request = { ...DEFAULT_CONFIG.request, stop }
  const merged = mergeRequestConfig({ model: 'm' }, request)
  assert.deepEqual(merged.stop, ['</s>'])
  assert.notEqual(merged.stop, stop)
})

test('无事可做时返回上游对象本身（否则每步重记 header 会打掉前缀缓存）', () => {
  const base = { provider: 'p', model: 'm', temperature: 0.2 }
  const merged = mergeRequestConfig(base, DEFAULT_CONFIG.request)
  assert.equal(merged, base, '应当返回同一个对象引用，而不是等值副本')
  assert.equal(Object.keys(merged).length, 3, '不应凭空多出键')
})

test('需要改动时才新建对象，且不污染上游', () => {
  const base = { provider: 'p', model: 'm' }
  const merged = mergeRequestConfig(base, DEFAULT_CONFIG.request)
  assert.notEqual(merged, base, '写入了 temperature，应当是副本')
  assert.equal(merged.temperature, 0.2)
  assert.equal('temperature' in base, false, '上游对象不能被动过')
  assert.equal(base.model, 'm')
})

test('上游带温度时同样零改动（第二轮的常态路径）', () => {
  const base = { provider: 'p', model: 'm', temperature: 0.7 }
  const merged = mergeRequestConfig(base, DEFAULT_CONFIG.request)
  assert.equal(merged, base)
  assert.equal(merged.temperature, 0.7, '不该覆盖上游已设的值')
})

console.log('\napply 装载行为')
test('注册 guard、restrict、提示词段与请求监听器', () => {
  const { ctx, calls } = fakeContext({
    schemas: [{ name: 'read' }, { name: 'grep' }, { name: 'plugin_manager' }],
  })
  apply(ctx, undefined)

  assert.equal(calls.guard.length, 1)
  assert.equal(calls.section.length, 1)
  assert.equal(calls.restrict.length, 1)
  assert.deepEqual(calls.restrict[0].deny, ['plugin_manager'])
  assert.equal(calls.on.length, 1)
  assert.equal(calls.on[0].event, 'agent/request')
})

test('提示词段名与 order 来自配置', () => {
  const { ctx, calls } = fakeContext()
  apply(ctx, { prompt: { order: 42, text: 'x' } })
  assert.equal(calls.section[0].name, 'dsh-plus-mode/rules')
  assert.equal(calls.section[0].order, 42)
  assert.equal(calls.section[0].complete, false)
})

test('replace=true 产生 complete 段', () => {
  const { ctx, calls } = fakeContext()
  apply(ctx, { prompt: { replace: true, text: 'x' } })
  assert.equal(calls.section[0].complete, true)
})

test('restrict 抛错时先试 deny 再试 allow，最终仍保留 guard', () => {
  const fallback = fakeContext({
    restrictThrows: true,
    schemas: [{ name: 'read' }, { name: 'plugin_manager' }],
  })
  apply(fallback.ctx, undefined)
  assert.equal(fallback.calls.restrict.length, 2, '应当尝试 deny 与 allow 两个方向')
  assert.deepEqual(fallback.calls.restrict[0].deny, ['plugin_manager'])
  assert.deepEqual(fallback.calls.restrict[1].allow, ['read'])
  assert.equal(fallback.calls.guard.length, 1, 'restrict 全败时 guard 必须仍在')
})

test('enforce=false 时不注册 guard', () => {
  const { ctx, calls } = fakeContext()
  apply(ctx, { tools: { enforce: false, hideGlobal: false } })
  assert.equal(calls.guard.length, 0)
  assert.equal(calls.restrict.length, 0)
})

test('request.enabled=false 时不注册监听器', () => {
  const { ctx, calls } = fakeContext()
  apply(ctx, { request: { enabled: false } })
  assert.equal(calls.on.length, 0)
})

test('监听器包装下游结果而不短路', async () => {
  const { ctx, calls } = fakeContext()
  apply(ctx, { request: { temperature: 0.5 } })
  const handler = calls.on[0].handler
  let nextCalled = false
  const result = await handler({}, async () => {
    nextCalled = true
    return { provider: 'p', model: 'm' }
  })
  assert.equal(nextCalled, true)
  assert.equal(result.temperature, 0.5)
})

test('suppressContext=true 时抑制运行上下文', () => {
  const { ctx, calls } = fakeContext()
  apply(ctx, { prompt: { suppressContext: true } })
  assert.equal(calls.suppress, 1)
})

console.log('\n预设文件')
test('preset.yml 声明了名称与描述', () => {
  const text = readFileSync(new URL('preset/preset.yml', root), 'utf8')
  assert.match(text, /^name:\s*\S+/m)
  assert.match(text, /^description:\s*\S+/m)
})

test('agent.cordis.yml 不含制表符缩进', () => {
  const text = readFileSync(new URL('preset/agent.cordis.yml', root), 'utf8')
  assert.equal(/^\t/m.test(text), false, 'YAML 不允许用制表符缩进')
})

test('工具行与控制器行齐备', () => {
  const text = readFileSync(new URL('preset/agent.cordis.yml', root), 'utf8')
  const ids = [...text.matchAll(/^\s*-\s+id:\s*(\S+)/gm)].map((m) => m[1])
  for (const id of ['tool-fs', 'tool-fs-search', 'tool-todo', 'plus-mode']) {
    assert.ok(ids.includes(id), `缺少 ${id} 行`)
  }
  assert.ok(ids.includes('tool-pwsh') && ids.includes('tool-bash'), '缺少 shell 工具行')
})

test('预设引用的插件包名与本包一致', () => {
  const text = readFileSync(new URL('preset/agent.cordis.yml', root), 'utf8')
  assert.match(text, new RegExp(`name:\\s*'${name}'`))
})

test('必填配置字段已给出（漏掉会让整行装载失败）', () => {
  const text = readFileSync(new URL('preset/agent.cordis.yml', root), 'utf8')
  const required = {
    'tool-fs-search': 'sampleOverCapGlobResults',
    'tool-todo': 'allowParallelInProgress',
  }
  for (const [rowId, key] of Object.entries(required)) {
    // 取该行到下一个同级 id 之间的文本，避免跨行误判。
    const block = text.match(new RegExp(`- id: ${rowId}\\n(.*?)(?=\\n- id: |$)`, 's'))?.[0] ?? ''
    assert.ok(block !== '', `找不到 ${rowId} 行`)
    assert.ok(block.includes(`${key}:`), `${rowId} 缺少必填字段 ${key}`)
  }
})

console.log('\n内部测试模式提示词')
test('不含提示词变量（变量未注册会让整段渲染失败）', () => {
  assert.equal(INTERNAL_TEST_PROMPT.includes('{{'), false, '不要使用 {{...}} 变量')
})

test('声明了 2026 年 4 月这条知识基线', () => {
  assert.match(INTERNAL_TEST_PROMPT, /2026 年 4 月/)
})

test('带上了防编造条款（否则「按新知识回答」会诱导幻觉）', () => {
  assert.match(INTERNAL_TEST_PROMPT, /严禁/, '缺少禁令')
  assert.match(INTERNAL_TEST_PROMPT, /编造/, '缺少反编造条文')
  assert.match(INTERNAL_TEST_PROMPT, /查不到就直说/, '缺少「不知道就说不知道」的出口')
})

test('覆盖七个约定章节', () => {
  const sections = [
    '# 服从与自我约束',
    '# 理解人话',
    '# 知识基线',
    '# 思考机制',
    '# 编码习惯',
    '# 设计风格',
    '# 交付纪律',
  ]
  for (const section of sections) {
    assert.ok(INTERNAL_TEST_PROMPT.includes(section), `缺少章节 ${section}`)
  }
})

test('服从排在最高位置（主诉求不能沉底）', () => {
  const first = INTERNAL_TEST_PROMPT.indexOf('# 服从与自我约束')
  assert.ok(first > -1, '缺少服从章节')
  for (const later of ['# 理解人话', '# 知识基线', '# 思考机制', '# 编码习惯']) {
    assert.ok(first < INTERNAL_TEST_PROMPT.indexOf(later), `${later} 排到了服从前头`)
  }
})

test('服从条文覆盖禁擅自扩范围与禁加未要求的东西', () => {
  assert.match(INTERNAL_TEST_PROMPT, /不擅自扩大范围/, '缺少范围约束')
  assert.match(INTERNAL_TEST_PROMPT, /他开口之前，这些都不存在/, '缺少「不加未要求的东西」')
  assert.match(INTERNAL_TEST_PROMPT, /唯一例外/, '缺少例外出口')
})

test('理解人话条文说明人话里没有专业词、底下压着真问题', () => {
  assert.match(INTERNAL_TEST_PROMPT, /人话里没有你的专业词/, '缺少「人话无专业词」')
  assert.match(INTERNAL_TEST_PROMPT, /都压着一个真实问题/, '缺少「底层真实问题」')
  assert.match(INTERNAL_TEST_PROMPT, /不要拿去烦他/, '缺少「能查就别问」')
})

test('默认配置真的用上了这段提示词', () => {
  assert.equal(DEFAULT_CONFIG.prompt.text, INTERNAL_TEST_PROMPT)
  assert.equal(resolveConfig(undefined).prompt.text, INTERNAL_TEST_PROMPT)
})

console.log(`\n全部通过：${passed} 项\n`)
