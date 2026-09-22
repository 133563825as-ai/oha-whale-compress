import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { WhaleCompactionEngine } from '../src/engine.js'
import { createConfigStore } from '../src/config-store.js'
import { TEMPLATES } from '../src/prompt-templates.js'

/** 造一个临时 DSH_HOME 并写入 config.json。 */
async function homeWith (config) {
  const home = await mkdtemp(join(tmpdir(), 'whale-eng-'))
  if (config !== undefined) {
    const dir = join(home, 'storages', 'dsh-oha-whale-compress')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'config.json'), JSON.stringify(config))
  }
  return home
}

/** 用给定 config 造引擎，并返回捕获到的 LLM 请求。 */
async function makeEngine (config, home) {
  process.env.DSH_HOME = home
  const captured = []
  const ctx = new Context()
  ctx.provide('llm', {
    async *stream (options) {
      captured.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '# SUMMARY\n- ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  })
  ctx.provide('tokenMeter', {})
  return { engine: new WhaleCompactionEngine(ctx, {}), captured, ctx }
}

const agent = {
  session: { id: 's1', requestHeader: () => undefined },
  options: {}
}

/**
 * 带路由的 agent：原生与自定义两条路径都靠它解析出 provider/model。
 * 上面的 `agent` 三处路由全空，只适用于「必须抛 no provider/model」的用例。
 */
const routedAgent = {
  session: { id: 's1', requestHeader: () => ({ config: { provider: 'p', model: 'm', length: 0 } }) },
  options: {}
}

const input = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }

/** 图片块 fixture（形状取自 `dsh-llm` 的 `ImageBlock` / `ImageAttachmentRef`）。 */
const IMAGE_BLOCK = {
  type: 'image',
  attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 128, width: 4, height: 4, name: 'x.png' }
}

/**
 * 剔除 message 上随机生成的 `id`：`createUserMessage` 每次调用都会生成一个新的
 * UUID，所以两次独立调用产出的请求不可能整对象深度相等。剔除后比较的仍是**其余
 * 全部字段**，断言强度不降 —— 它钉住的正是「除随机 id 外逐字段相同」。
 */
const withoutId = ({ id, ...rest }) => rest

/** 归一化整条 LLM 请求：仅剔除各 message 的随机 id。 */
const normalize = (request) => ({ ...request, messages: request.messages.map(withoutId) })

/**
 * 断言两条 LLM 请求「除随机 message id 外逐字段相同」。
 * 先把消息数量与追加的压缩指令形状显式钉死，再做整请求对比 ——
 * 否则「两边都没抛错」会被误当成「走了同一条路径」。
 * @param {object} actual - 我们的引擎发出的请求。
 * @param {object} expected - 原生基类发出的请求。
 */
function assertSameRequest (actual, expected) {
  assert.equal(actual.messages.length, expected.messages.length, '消息数量必须一致')
  assert.deepEqual(withoutId(actual.messages.at(-1)), withoutId(expected.messages.at(-1)), '追加的压缩指令必须逐字段相同')
  assert.deepEqual(normalize(actual), normalize(expected))
}

/**
 * 用同一个 home 与 agent 跑一次原生基类 `BasicCompactionEngine`，返回它捕获到的请求。
 * @param {string} home - dsh home 目录。
 * @param {object} target - 目标 agent。
 * @returns {Promise<object[]>} 捕获到的 LLM 请求列表。
 */
async function captureBase (home, target) {
  process.env.DSH_HOME = home
  const ctx = new Context()
  const captured = []
  ctx.provide('llm', {
    async *stream (options) {
      captured.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '# SUMMARY\n- ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  })
  ctx.provide('tokenMeter', {})
  await new BasicCompactionEngine(ctx, {}).summarize(input, target, undefined)
  return captured
}

test('未配置时与原生基类产出完全相同的 LLM 请求（drop-in 回归对照）', async () => {
  const home = await homeWith(undefined)
  const { engine, captured } = await makeEngine(undefined, home)
  await engine.summarize(input, routedAgent, undefined)

  const baseCaptured = await captureBase(home, routedAgent)

  assert.equal(captured.length, 1)
  assert.equal(baseCaptured.length, 1)
  assertSameRequest(captured[0], baseCaptured[0])
})

test('手动 + 完全未配置：仍回落原生基类，请求与原生逐字段一致（spec §5.3）', async () => {
  const home = await homeWith(undefined)
  const { engine, captured } = await makeEngine(undefined, home)
  engine.isManual = () => true

  await engine.summarize(input, routedAgent, undefined)
  assert.equal(captured.length, 1, '必须只发一次 LLM 调用')

  const baseCaptured = await captureBase(home, routedAgent)
  assert.equal(baseCaptured.length, 1)
  assertSameRequest(captured[0], baseCaptured[0])
})

test('非手动 + 已配置提示词：仍走原生基类（自动压缩不被劫持）', async () => {
  const home = await homeWith({ promptTemplate: 'terse', provider: '', model: '' })
  const { engine, captured } = await makeEngine(undefined, home)
  await engine.summarize(input, routedAgent, undefined) // 故意不标记手动

  assert.equal(captured.length, 1)
  const baseCaptured = await captureBase(home, routedAgent)
  assert.equal(baseCaptured.length, 1)
  assertSameRequest(captured[0], baseCaptured[0])
})

test('面板改完配置后立刻压缩：必须用磁盘上的新配置（配置时效性）', async () => {
  const home = await homeWith({ promptTemplate: 'terse', provider: '', model: '' })
  const { engine, captured } = await makeEngine(undefined, home)
  engine.isManual = () => true

  await engine.summarize(input, routedAgent, undefined)
  assert.ok(JSON.stringify(captured[0].messages).includes(TEMPLATES.terse.text.slice(0, 30)))

  // 模拟面板在引擎存活期间保存了新配置（host 侧经 createConfigStore 落盘）
  await createConfigStore(home).save({ promptTemplate: 'handoff' })

  await engine.summarize(input, routedAgent, undefined)
  assert.equal(captured.length, 2, '第二次压缩必须再发一次 LLM 调用')
  const body = JSON.stringify(captured[1].messages)
  assert.ok(body.includes(TEMPLATES.handoff.text.slice(0, 30)), '第二次必须用新配置的模板')
  assert.ok(!body.includes(TEMPLATES.terse.text.slice(0, 30)), '不得沿用旧配置的模板')
})

test('手动 + 内置模板：自定义提示词进入请求', async () => {
  const home = await homeWith({ promptTemplate: 'terse', provider: '', model: '' })
  const { engine, captured } = await makeEngine(undefined, home)

  // 只把 agent 标记为「手动」，其余走真实分流
  const marked = new Set([routedAgent])
  engine.isManual = (a) => marked.has(a)

  const result = await engine.summarize(input, routedAgent, undefined)
  const body = JSON.stringify(captured[0].messages)
  // 取不含换行的前缀：JSON.stringify 会把换行转义成 \n，跨行的切片永远匹配不上
  assert.ok(body.includes(TEMPLATES.terse.text.slice(0, 30)))
  assert.equal(result.llmStreamCall, true)
  assert.equal(result.summary[0].type, 'text')
  // SummaryResult 契约形状（dsh-compaction-basic/lib/types/summarizer.d.ts）：
  // 本地 fake stream 不发 usage 块，故 usage 键按契约不出现
  assert.deepEqual(Object.keys(result).sort(), ['llmStreamCall', 'maxTokens', 'model', 'provider', 'rawOutput', 'summary'])
  assert.equal(result.provider, 'p')
  assert.equal(result.model, 'm')
  assert.equal(typeof result.maxTokens, 'number')
  assert.ok(Array.isArray(result.rawOutput))
})

test('自定义路径：图片块不进 summary，只留 text 块（rawOutput 仍保留原样）', async () => {
  const home = await homeWith({ promptTemplate: 'terse', provider: '', model: '' })
  process.env.DSH_HOME = home
  const ctx = new Context()
  ctx.provide('llm', {
    async *stream () {
      // 图片块只能经 block-end 落地：BlockAssembler 对 block-start 之外的未知块
      // 不自行装配，block-end 携带的 block 会原样进入 blocks()
      yield { type: 'block-start', index: 0, blockType: 'image' }
      yield { type: 'block-end', index: 0, block: IMAGE_BLOCK }
      yield { type: 'block-start', index: 1, blockType: 'text' }
      yield { type: 'text-delta', index: 1, text: '# SUMMARY' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  })
  ctx.provide('tokenMeter', {})
  const engine = new WhaleCompactionEngine(ctx, {})
  engine.isManual = () => true

  const result = await engine.summarize(input, routedAgent, undefined)
  assert.equal(result.rawOutput.length, 2)
  assert.ok(result.rawOutput.some((block) => block.type === 'image'))
  assert.equal(result.summary.length, 1)
  assert.ok(result.summary.every((block) => block.type === 'text'))
})

test('手动 + 指定 provider/model：请求使用它们', async () => {
  const home = await homeWith({ promptTemplate: 'terse', provider: 'pp', model: 'mm' })
  const { engine, captured } = await makeEngine(undefined, home)
  engine.isManual = () => true
  await engine.summarize(input, agent, undefined)
  assert.equal(captured[0].provider, 'pp')
  assert.equal(captured[0].model, 'mm')
})

test('手动 + 模板 native 但指定了模型：使用内置默认模板（spec §11 A）', async () => {
  const home = await homeWith({ promptTemplate: 'native', prompt: '', provider: 'pp', model: 'mm' })
  const { engine, captured } = await makeEngine(undefined, home)
  engine.isManual = () => true
  await engine.summarize(input, agent, undefined)
  const body = JSON.stringify(captured[0].messages)
  assert.ok(body.includes(TEMPLATES.default.text.slice(0, 30)))
})

test('手动 + promptTemplate=custom：用 prompt 原文', async () => {
  const home = await homeWith({ promptTemplate: 'custom', prompt: 'CUSTOM-MARKER-XYZ', provider: '', model: '' })
  const { engine, captured } = await makeEngine(undefined, home)
  engine.isManual = () => true

  const agentWithRoute = {
    session: { id: 's1', requestHeader: () => ({ config: { provider: 'route-p', model: 'route-m', length: 0 } }) },
    options: {}
  }
  await engine.summarize(input, agentWithRoute, undefined)
  assert.ok(JSON.stringify(captured[0].messages).includes('CUSTOM-MARKER-XYZ'))
  assert.equal(captured[0].provider, 'route-p')
  assert.equal(captured[0].model, 'route-m')
})

test('手动 + 模型留空：按 fallback 链落到 agent.options', async () => {
  const home = await homeWith({ promptTemplate: 'terse', provider: '', model: '' })
  const { engine, captured } = await makeEngine(undefined, home)
  engine.isManual = () => true
  const routed = {
    session: { id: 's1', requestHeader: () => undefined },
    options: { provider: 'opt-p', model: 'opt-m' }
  }
  await engine.summarize(input, routed, undefined)
  assert.equal(captured[0].provider, 'opt-p')
  assert.equal(captured[0].model, 'opt-m')
})

test('手动 + 三处都没有模型：抛出明确错误', async () => {
  const home = await homeWith({ promptTemplate: 'terse', provider: '', model: '' })
  const { engine } = await makeEngine(undefined, home)
  engine.isManual = () => true
  await assert.rejects(
    () => engine.summarize(input, agent, undefined),
    /no provider\/model available for summarization/
  )
})

test('compactNow 在委托期间打标记，结束后清除', async () => {
  const home = await homeWith(undefined)
  const { engine } = await makeEngine(undefined, home)
  let during = null
  const stub = {
    session: { id: 's1' },
    options: {},
    runMaintenance: async () => { during = engine.isManual(stub); throw new Error('stop here') }
  }
  await assert.rejects(() => engine.compactNow(stub, new AbortController().signal, undefined))
  assert.equal(during, true, '委托期间必须处于手动标记状态')
  assert.equal(engine.isManual(stub), false, '结束后必须清除标记')
})

test('finishError 复刻：error 分支带出底层 code', async () => {
  const home = await homeWith({ promptTemplate: 'terse', provider: '', model: '' })
  process.env.DSH_HOME = home
  const ctx = new Context()
  ctx.provide('llm', {
    async *stream () {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'TRANSPORT' } } }
    }
  })
  ctx.provide('tokenMeter', {})
  const engine = new WhaleCompactionEngine(ctx, {})
  engine.isManual = () => true
  await assert.rejects(() => engine.summarize(input, routedAgent, undefined), (e) => {
    assert.equal(e.message, 'boom')
    assert.equal(e.code, 'TRANSPORT')
    return true
  })
})

import { withRetry, shouldRetry } from '../src/engine.js'

test('shouldRetry：中止与 MAX_TOKENS 不重试', () => {
  const ac = new AbortController()
  ac.abort()
  assert.equal(shouldRetry(new Error('x'), ac.signal), false)
  const maxTok = new Error('truncated')
  maxTok.code = 'MAX_TOKENS'
  assert.equal(shouldRetry(maxTok, undefined), false)
  assert.equal(shouldRetry(new Error('transport boom'), undefined), true)
})

test('withRetry：前两次失败第三次成功', async () => {
  let n = 0
  const result = await withRetry(async () => {
    n += 1
    if (n < 3) throw new Error('transient')
    return 'ok'
  }, { attempts: 3, baseMs: 1 })
  assert.equal(result, 'ok')
  assert.equal(n, 3)
})

test('withRetry：用尽后抛出最后一个错误', async () => {
  let n = 0
  await assert.rejects(
    () => withRetry(async () => { n += 1; throw new Error(`fail-${n}`) }, { attempts: 3, baseMs: 1 }),
    /fail-3/
  )
})

test('withRetry：MAX_TOKENS 立即抛出，不重试', async () => {
  let n = 0
  await assert.rejects(() => withRetry(async () => {
    n += 1
    const e = new Error('truncated')
    e.code = 'MAX_TOKENS'
    throw e
  }, { attempts: 3, baseMs: 1 }))
  assert.equal(n, 1)
})

test('手动 + 自定义路径：底层瞬时失败会被重试救回', async () => {
  const home = await homeWith({ promptTemplate: 'terse', provider: '', model: '' })
  process.env.DSH_HOME = home
  let calls = 0
  const ctx = new Context()
  ctx.provide('llm', {
    async *stream () {
      calls += 1
      if (calls === 1) throw new Error('stream from https://api.deepseek.com failed')
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '# SUMMARY\n- ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  })
  ctx.provide('tokenMeter', {})
  const engine = new WhaleCompactionEngine(ctx, {})
  engine.isManual = () => true
  // routedAgent 是 Task 3 已建立的「带路由」夹具；自定义路径必须用它，
  // 否则 resolveRouteTarget 返回 undefined 并抛 no provider/model available
  const result = await engine.summarize(input, routedAgent, undefined)
  assert.equal(calls, 2)
  assert.equal(result.llmStreamCall, true)
})

test('非手动（守卫 1）：底层瞬时失败原样抛出，且一次都不重试', async () => {
  const home = await homeWith({ promptTemplate: 'terse', provider: '', model: '' })
  process.env.DSH_HOME = home
  const boom = new Error('stream from https://api.deepseek.com failed')
  let calls = 0
  const ctx = new Context()
  ctx.provide('llm', {
    async *stream () {
      calls += 1
      throw boom
    }
  })
  ctx.provide('tokenMeter', {})
  const engine = new WhaleCompactionEngine(ctx, {})
  // 故意不标记手动：自动压缩已有框架自带的 compactionRetries / maxOverflowRetries，
  // 这里再加一层就会与之相乘；且必须原样抛出，不能被重试层包裹。
  await assert.rejects(() => engine.summarize(input, routedAgent, undefined), (e) => {
    assert.equal(e, boom, '非手动支路必须原样抛出底层错误')
    return true
  })
  assert.equal(calls, 1, '守卫 1 不得重试：LLM 流只能被调用一次')
})

test('compactNow：底层失败不得重试（runMaintenance 恰好调用一次）', async () => {
  const home = await homeWith(undefined)
  const { engine } = await makeEngine(undefined, home)
  let calls = 0
  const stub = {
    session: { id: 's1' },
    options: {},
    runMaintenance: async () => {
      calls += 1
      throw new Error('stream from https://api.deepseek.com failed')
    }
  }
  // compactNow 内部有 runMaintenance（排他）与 durable 提交副作用，重放会破坏状态
  await assert.rejects(() => engine.compactNow(stub, new AbortController().signal, undefined))
  assert.equal(calls, 1, 'compactNow 绝不能被重试：runMaintenance 只能进入一次')
  assert.equal(engine.isManual(stub), false, '失败后仍须清除手动标记')
})

test('手动 + 原生支路（守卫 2）：瞬时失败会被重试救回', async () => {
  const home = await homeWith({ promptTemplate: 'native', prompt: '', provider: '', model: '' })
  process.env.DSH_HOME = home
  let calls = 0
  const ctx = new Context()
  ctx.provide('llm', {
    async *stream () {
      calls += 1
      if (calls === 1) throw new Error('stream from https://api.deepseek.com failed')
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '# SUMMARY\n- ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  })
  ctx.provide('tokenMeter', {})
  const engine = new WhaleCompactionEngine(ctx, {})
  engine.isManual = () => true
  // native + provider/model 都空 → 守卫 2：交还基类的纯摘要调用（只读对话前缀 + 一次 LLM），
  // 无副作用，因此这条支路也带重试；routedAgent 提供基类所需的路由
  const result = await engine.summarize(input, routedAgent, undefined)
  assert.equal(calls, 2, '守卫 2 的瞬时失败必须被重试救回')
  assert.equal(result.llmStreamCall, true)
})
