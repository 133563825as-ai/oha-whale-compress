import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { createConfigStore } from './config-store.js'
import { resolveDshHome } from './home.js'
import { TEMPLATES, effectivePrompt } from './prompt-templates.js'

/**
 * 自定义压缩引擎。
 *
 * 它 **运行在 preset 的 `isolate: compaction` realm 里** —— cordis 禁止跨 fiber
 * 覆盖服务（`RegistryService.set` 抛 "in multiple fibers"），所以这是唯一能接管
 * 压缩的路径。与 host 层面板的通信通道是 `config.json`。
 *
 * 分流规则（spec §5.3）：
 *   提示词空 + 模型空        → super.summarize()，与原生逐字节一致
 *   提示词空 + 模型非空      → 内置默认模板（原生提示词是框架私有常量，拿不到）
 *   提示词非空              → 自定义调用
 * 非手动触发（自动压力 / 溢出恢复）一律 super，不受本类影响。
 */
export class WhaleCompactionEngine extends BasicCompactionEngine {
  /** 本次压缩是否由用户手动触发。`summarize()` 入参没有触发来源，只能在此打标记。 */
  #manual = new WeakSet()
  #home

  constructor (ctx, config = {}) {
    super(ctx, config)
    this.#home = resolveDshHome(ctx)
  }

  /**
   * 查询某 agent 是否处于「手动压缩」标记中。公开以便测试。
   * @param {object} agent - 目标 agent。
   * @returns {boolean} 是否在标记中。
   */
  isManual (agent) {
    return this.#manual.has(agent)
  }

  /**
   * 手动压缩入口：打标记 → 委托基类 → 无论成败都清标记。
   * 安全性：`super.compactNow` 内部是 `agent.runMaintenance(...)`，排他且要求
   * agent 空闲，标记期间不会有同一 agent 的自动压缩穿插。
   */
  async compactNow (agent, signal, sourceCommandId) {
    this.#manual.add(agent)
    try {
      return await super.compactNow(agent, signal, sourceCommandId)
    } finally {
      this.#manual.delete(agent)
    }
  }

  /**
   * 唯一的定制 hook（基类 d.ts 明确声明）。
   * 注意框架只拿 `.summary` 去 frame + 定价 + 提交，durable 写入仍归框架。
   */
  async summarize (input, agent, signal) {
    // 非手动：完全交还基类，不加任何重试（自动压缩已有框架自带的两层重试）
    if (!this.isManual(agent)) return await super.summarize(input, agent, signal)

    // 每次压缩都新建 store 重新读盘：host 层面板的 save() 与 preset realm 里的引擎
    // 是两个实例，而引擎实例通常活得比一次面板保存更久 —— 常驻缓存会让「改完提示词
    // 立刻压缩」用上旧配置（spec §4.2 要求 summarize() 时读配置）。压缩是低频操作，
    // 一次小文件读取的代价可接受。
    const cfg = await createConfigStore(this.#home).get()
    const configuredModel = cfg.provider !== '' && cfg.model !== ''
    let prompt = effectivePrompt(cfg)

    // spec §11 A：没给提示词但指定了模型时，用内置默认模板
    if (prompt.trim() === '' && !configuredModel) {
      return await withRetry(() => super.summarize(input, agent, signal), { signal })
    }
    if (prompt.trim() === '') prompt = TEMPLATES.default.text

    const target = configuredModel
      ? { provider: cfg.provider, model: cfg.model }
      : resolveRouteTarget(agent)
    if (target === undefined) {
      throw new Error('no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields')
    }

    const options = {
      provider: target.provider,
      model: target.model,
      messages: [
        ...input.messages,
        createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'plugin', plugin: 'dsh-oha-whale-compress' }
        })
      ],
      ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
      maxTokens: this.config.maxTokens,
      sessionId: agent.session.id,
      purpose: 'compaction',
      ...(signal === undefined ? {} : { signal })
    }

    const assembler = await withRetry(() => streamToAssembler(this.ctx, options), { signal })
    return buildSummaryResult(assembler, options.provider, options.model, options.maxTokens)
  }
}

/**
 * 复刻 `dsh-compaction-basic/lib/index.js:269–280` 的模型 fallback 链
 * （`resolveTargetPolicy` / `conversationTarget` 均无运行时导出）。
 * @param {object} agent - 目标 agent。
 * @returns {{ provider: string, model: string } | undefined} 解析出的路由，或 undefined。
 */
export function resolveRouteTarget (agent) {
  const latest = agent.session !== undefined && typeof agent.session.requestHeader === 'function'
    ? agent.session.requestHeader()
    : undefined
  const routed = latest === undefined ? undefined : latest.config
  if (routed !== undefined && typeof routed.provider === 'string' && routed.provider.length > 0 &&
      typeof routed.model === 'string' && routed.model.length > 0) {
    return { provider: routed.provider, model: routed.model }
  }
  const options = agent.options
  if (options !== undefined && typeof options.provider === 'string' && options.provider.length > 0 &&
      typeof options.model === 'string' && options.model.length > 0) {
    return { provider: options.provider, model: options.model }
  }
  return undefined
}

/**
 * 复刻 `dsh-compaction-basic/lib/index.js:337` 的 `finishError`（无运行时导出）。
 * @param {{ kind: string, failure?: { message: string, code: string } }} finish - 流结束状态。
 * @returns {Error | undefined} 应当抛出的错误，或 undefined 表示正常结束。
 */
export function finishError (finish) {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message)
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens': {
      const error = new Error('summarization truncated at the token cap (incomplete checkpoint)')
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

/**
 * 跑一次流式摘要并装配。
 * 这是本引擎里唯一会被重试的操作（纯读取，无副作用）。
 * @param {object} ctx - 提供 llm 服务的上下文。
 * @param {object} options - `ctx.llm.stream` 的调用参数。
 * @returns {Promise<object>} 已完成装配的 BlockAssembler。
 */
export async function streamToAssembler (ctx, options) {
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  const error = finishError(assembler.finish)
  if (error !== undefined) throw error
  return assembler
}

/**
 * 按 `SummaryResult` 契约装配返回值（`lib/types/summarizer.d.ts`）。
 * @param {object} assembler - 已完成的 BlockAssembler。
 * @param {string} provider - 实际使用的 provider。
 * @param {string} model - 实际使用的 model。
 * @param {number} maxTokens - 本次调用的输出上限。
 * @returns {object} SummaryResult。
 */
export function buildSummaryResult (assembler, provider, model, maxTokens) {
  const rawOutput = assembler.blocks()
  const summary = rawOutput.filter((block) => block.type === 'text')
  if (!summary.some((block) => block.text.trim().length > 0)) {
    throw new Error('summarization produced no text summary content')
  }
  return {
    summary,
    rawOutput,
    llmStreamCall: true,
    provider,
    model,
    maxTokens,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage })
  }
}

/** 手动压缩重试次数（总尝试次数）。 */
const MANUAL_ATTEMPTS = 3
/** 重试退避基数（毫秒），实际等待为 baseMs * 2^(n-1)。 */
const MANUAL_BASE_MS = 300

/**
 * 判断一个错误是否值得重试。
 *
 * 只排除两类**确定性**失败：用户中止、以及输出被 token 上限截断。
 * 其余（网络断流等）都重试 —— 这正是框架缺陷 A：手动压缩零重试，
 * 而普通回合有 `dsh-llm-retry`、自动压缩有 `compactionRetries`。
 * @param {unknown} error - 捕获到的错误。
 * @param {AbortSignal | undefined} signal - 本次压缩的中止信号。
 * @returns {boolean} 是否应当重试。
 */
export function shouldRetry (error, signal) {
  if (signal !== undefined && signal.aborted) return false
  if (error !== null && typeof error === 'object' && error.code === 'MAX_TOKENS') return false
  return true
}

/**
 * 带指数退避的重试包装。
 * @param {() => Promise<T>} fn - 幂等的异步操作。
 * @param {{ attempts?: number, baseMs?: number, signal?: AbortSignal }} [opts] - 重试参数。
 * @returns {Promise<T>} 首次成功的结果。
 * @template T
 */
export async function withRetry (fn, opts = {}) {
  const attempts = opts.attempts ?? MANUAL_ATTEMPTS
  const baseMs = opts.baseMs ?? MANUAL_BASE_MS
  let last
  for (let n = 1; n <= attempts; n += 1) {
    try {
      return await fn()
    } catch (error) {
      last = error
      if (!shouldRetry(error, opts.signal) || n === attempts) throw error
      await new Promise((resolve) => setTimeout(resolve, baseMs * 2 ** (n - 1)))
    }
  }
  throw last
}

export default WhaleCompactionEngine
