# 自定义压缩 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `dsh-oha-whale-compress` 面板上配置的「压缩提示词 / provider / model」真正生效 —— 仅作用于用户手动触发的压缩，并通过一键注入把它装进用户已有的 agent preset。

**Architecture:** 新增 `src/engine.js`（`BasicCompactionEngine` 子类，运行在 preset 的 `isolate: compaction` realm 里），通过已有的 `config.json` 与 host 层面板通信；用 `compactNow()` 覆写在 `WeakSet` 里打「本次是手动」标记，`summarize()` 据此分流 —— 未配置时原样委托 `super.summarize()`（与原生逐字节一致），其余走自定义 LLM 调用。新增 `src/injector.js` 对 preset YAML 做**单行文本替换**（绝不重新序列化）。

**Tech Stack:** Node.js ≥ 22（实测 v24.19.0）、ESM、`node:test`（零依赖，实测可用）、`@deepseek-ai/dsh-compaction-basic` / `@deepseek-ai/dsh-llm`（宿主提供，peer）、Cordis 服务/realm 模型。

**Spec:** `docs/superpowers/specs/2026-09-11-custom-compaction-design.md`

## Global Constraints

- **不改框架包**：`node_modules` 里的 `@deepseek-ai/*` 一律只读，不 patch、不 fork。
- **不改 shipped preset**：只允许写 `~/.dsh/.agent-presets/` 下（`user` trust）的 preset；`SHIPPED_PRESET_ROOT` 一律拒绝。
- **绝不重新序列化 YAML**：注入器只做单行文本替换，禁止 `js-yaml` parse→dump（会抹掉注释与 `!!js` 表达式）。
- **非手动触发的压缩不受影响**：自动压力压缩与上下文溢出恢复一律走 `super.summarize()`。
- **禁止「临时改 `this.config` 再调 `super`」的写法**：会与并行中的其它会话的自动压缩抢共享状态。
- **`keepN` 本轮不生效**：UI 上必须标注「暂未生效」，不得隐藏、不得暗示可用。
- **自定义路径返回值必须满足 `SummaryResult` 契约**：`{ summary, rawOutput, llmStreamCall: true, provider, model, maxTokens, usage? }`，其中 `summary` 必须全是 `type === 'text'` 的块。
- **引擎抛错不得拖垮会话**：只影响本次压缩；`finally` 必须清掉手动标记。
- **零运行时依赖**：`dependencies` 保持为空（宿主 peer 除外）。
- **测试命令**：`node --test`（不带参数，自动发现 `test/` 下的测试文件）。**不要用目录形式 `node --test test/`** —— Node 24.19 会把它当成入口文件解析并报 `Cannot find module '.../test'`（pass 0 失败，实测确认）。不使用任何测试框架依赖。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/home.js`（新建） | 解析 dsh home —— host 与引擎共用，避免两处逻辑漂移 |
| `src/prompt-templates.js`（新建） | 内置提示词模板的 id/标签/文本 + `effectivePrompt()` 解析 |
| `src/config-store.js`（改） | 追加 `promptTemplate` / `prompt` 字段，保持向后兼容 |
| `src/engine.js`（新建） | `WhaleCompactionEngine`：手动标记、分流、自定义 LLM 调用、重试 |
| `src/injector.js`（新建） | preset 行的查找/替换/备份/幂等/还原 + 写权限策略 |
| `src/index.js`（改） | 改用 `src/home.js` |
| `src/http.js`（改） | `/configure` 收新字段；新增 `/presets`、`/inject` 路由 |
| `client/client.js`（改） | 模板下拉 + 自定义文本域；快捷面板补 provider/model；`keepN` 标注；文案修正 |
| `package.json`（改） | 新增 `./engine` 子路径导出；声明 peerDependencies；加 `test` script |
| `test/*.test.mjs`（新建） | 各任务的单测 |

---

### Task 0: 版本控制基线

> ⚠️ **本任务会新建 git 仓库。** 该目录当前不是 git 仓库（`git rev-parse` 报 fatal），
> 但已有 `.gitignore`（内容 `node_modules/` + `*.log`）与 `LICENSE`，且目标是开源分发。
> 频繁提交需要它。**若你不想建，跳过本任务，并把后续每个 Commit 步骤换成对
> `docs/superpowers/snapshots/` 的文件快照。**

**Files:**
- Create: `.git/`（由 `git init` 建立）
- Verify: `.gitignore`

- [ ] **Step 1: 确认 .gitignore 覆盖 node_modules**

Run: `cat .gitignore`
Expected: 输出含 `node_modules/` 与 `*.log` 两行

- [ ] **Step 2: 初始化仓库**

```bash
cd /root/dsha-oha-whale-compress && git init -b main
```

- [ ] **Step 3: 确认 node_modules 不会被跟踪**

Run: `git status --porcelain | grep -c node_modules || true`
Expected: `0`

- [ ] **Step 4: 首次提交**

```bash
cd /root/dsha-oha-whale-compress
git add -A
git commit -m "chore: 建立版本控制基线（含自定义压缩设计 spec）"
```

- [ ] **Step 5: 确认提交内容干净**

Run: `git show --stat --oneline HEAD | head -20`
Expected: 只含源码/文档，**不含** `node_modules`

---

### Task 1: 抽出 `src/home.js` + 扩展 config-store

**Files:**
- Create: `src/home.js`
- Create: `test/config-store.test.mjs`
- Modify: `src/config-store.js:4-8`（DEFAULTS）
- Modify: `src/index.js:1-14`（删掉内联 `resolveDshHome`，改 import）

**Interfaces:**
- Produces:
  - `resolveDshHome(ctx: object | undefined): string` —— 解析 dsh home 绝对路径
  - `createConfigStore(home: string): { get(): Promise<Config>, save(patch: object): Promise<Config>, file: string }`
  - `Config = { provider: string, model: string, keepN: number, promptTemplate: string, prompt: string }`
  - `DEFAULTS.promptTemplate === 'native'`（见 Task 2 语义：`native` = 不自定义提示词）

- [ ] **Step 1: 写失败的测试**

Create `test/config-store.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConfigStore } from '../src/config-store.js'
import { resolveDshHome } from '../src/home.js'

test('resolveDshHome 优先用 ctx.dshHomePath()', () => {
  assert.equal(resolveDshHome({ dshHomePath: () => '/custom/home' }), '/custom/home')
})

test('resolveDshHome 回落到 DSH_HOME 环境变量', () => {
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = '/env/home'
  try {
    assert.equal(resolveDshHome({}), '/env/home')
    assert.equal(resolveDshHome(undefined), '/env/home')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
})

test('config-store 缺失文件时给出含新字段的默认值', async () => {
  const home = await mkdtemp(join(tmpdir(), 'whale-cfg-'))
  const store = createConfigStore(home)
  const cfg = await store.get()
  assert.deepEqual(cfg, {
    provider: '',
    model: '',
    keepN: 1000,
    promptTemplate: 'native',
    prompt: ''
  })
})

test('config-store 读取旧版文件时补齐新字段（向后兼容）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'whale-cfg-'))
  const dir = join(home, 'storages', 'dsh-oha-whale-compress')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'config.json'), JSON.stringify({ provider: 'p', model: 'm', keepN: 7 }))
  const store = createConfigStore(home)
  const cfg = await store.get()
  assert.equal(cfg.provider, 'p')
  assert.equal(cfg.promptTemplate, 'native')
  assert.equal(cfg.prompt, '')
})

test('config-store save 落盘且能读回', async () => {
  const home = await mkdtemp(join(tmpdir(), 'whale-cfg-'))
  const store = createConfigStore(home)
  await store.save({ promptTemplate: 'terse', prompt: 'hi' })
  const raw = JSON.parse(await readFile(store.file, 'utf8'))
  assert.equal(raw.promptTemplate, 'terse')
  assert.equal(raw.prompt, 'hi')
  assert.equal((await store.get()).prompt, 'hi')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /root/dsha-oha-whale-compress && node --test test/config-store.test.mjs`
Expected: FAIL —— `Cannot find module '../src/home.js'`，且默认值断言缺少 `promptTemplate` / `prompt`

- [ ] **Step 3: 建 `src/home.js`**

```js
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

/**
 * 解析 dsh home 目录。host 插件与 preset realm 里的引擎共用同一份逻辑，
 * 避免两处实现漂移。
 * @param {object | undefined} ctx - cordis 上下文（可选）。
 * @returns {string} dsh home 的绝对路径。
 */
export function resolveDshHome (ctx) {
  if (ctx !== undefined && ctx !== null && typeof ctx.dshHomePath === 'function') {
    return ctx.dshHomePath()
  }
  const fromEnv = process.env.DSH_HOME
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return resolve(fromEnv)
  return join(homedir(), '.dsh')
}
```

- [ ] **Step 4: 扩展 `src/config-store.js` 的 DEFAULTS**

把第 4-8 行替换为：

```js
const DEFAULTS = {
  provider: '',
  model: '',
  keepN: 1000,
  promptTemplate: 'native',
  prompt: ''
}
```

`load()` / `save()` 的 `{ ...DEFAULTS, ...parsed }` 合并逻辑**保持不变**，向后兼容由它保证。

- [ ] **Step 5: 让 `src/index.js` 改用共享 helper**

删除 `src/index.js` 里内联的 `resolveDshHome` 函数（第 10-14 行）以及顶部的
`import { join, resolve } from 'node:path'` 与 `import { homedir } from 'node:os'`，
改为：

```js
import { createConfigStore } from './config-store.js'
import { registerRoutes } from './http.js'
import { resolveDshHome } from './home.js'
```

`apply()` 里 `const home = resolveDshHome(ctx)` 不变。

- [ ] **Step 6: 运行测试确认通过**

Run: `cd /root/dsha-oha-whale-compress && node --test test/config-store.test.mjs`
Expected: PASS（5 个测试）

- [ ] **Step 7: 确认插件仍能加载**

Run: `node --check src/index.js && node --check src/config-store.js && node --check src/home.js`
Expected: 无输出（语法通过）

- [ ] **Step 8: Commit**

```bash
cd /root/dsha-oha-whale-compress
git add src/home.js src/config-store.js src/index.js test/config-store.test.mjs
git commit -m "refactor: 抽出共享的 dsh home 解析，config-store 支持提示词字段"
```

---

### Task 2: 内置提示词模板

**Files:**
- Create: `src/prompt-templates.js`
- Create: `test/prompt-templates.test.mjs`

**Interfaces:**
- Consumes: `Config`（Task 1）
- Produces:
  - `TEMPLATE_IDS: string[]` —— `['native', 'default', 'terse', 'handoff', 'custom']`
  - `TEMPLATES: Record<string, { label: string, text: string }>` —— 不含 `native` / `custom`
  - `effectivePrompt(cfg): string` —— `native`/未知 → `''`；`custom` → `cfg.prompt`；其余 → 模板文本

- [ ] **Step 1: 写失败的测试**

Create `test/prompt-templates.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TEMPLATE_IDS, TEMPLATES, effectivePrompt } from '../src/prompt-templates.js'

test('TEMPLATE_IDS 含 native 与 custom，且顺序稳定', () => {
  assert.deepEqual(TEMPLATE_IDS, ['native', 'default', 'terse', 'handoff', 'custom'])
})

test('每个内置模板都有非空 label 与 text', () => {
  for (const id of ['default', 'terse', 'handoff']) {
    assert.equal(typeof TEMPLATES[id].label, 'string')
    assert.ok(TEMPLATES[id].label.length > 0)
    assert.ok(TEMPLATES[id].text.trim().length > 0)
  }
})

test('native 表示不自定义提示词', () => {
  assert.equal(effectivePrompt({ promptTemplate: 'native', prompt: 'ignored' }), '')
})

test('未识别的模板 id 安全回落为不自定义', () => {
  assert.equal(effectivePrompt({ promptTemplate: 'nope', prompt: '' }), '')
  assert.equal(effectivePrompt({}), '')
})

test('custom 用 prompt 字段原文', () => {
  assert.equal(effectivePrompt({ promptTemplate: 'custom', prompt: '  我的提示词  ' }), '  我的提示词  ')
})

test('内置模板返回模板文本而非 prompt 字段', () => {
  assert.equal(effectivePrompt({ promptTemplate: 'terse', prompt: 'ignored' }), TEMPLATES.terse.text)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /root/dsha-oha-whale-compress && node --test test/prompt-templates.test.mjs`
Expected: FAIL —— `Cannot find module '../src/prompt-templates.js'`

- [ ] **Step 3: 实现 `src/prompt-templates.js`**

```js
/**
 * 内置压缩提示词模板。
 *
 * `native` 与 `custom` 是哨兵值，不出现在 TEMPLATES 里：
 *  - native  = 不自定义提示词（走框架原生，见 spec §5.3）
 *  - custom  = 用 config.prompt 的自由文本
 */

/** 不自定义提示词；此时若模型也为空，压缩行为与原生逐字节一致。 */
export const NATIVE_TEMPLATE = 'native'

export const TEMPLATE_IDS = [NATIVE_TEMPLATE, 'default', 'terse', 'handoff', 'custom']

export const TEMPLATES = {
  default: {
    label: '默认（工程向）',
    text: [
      '你是一个压缩引擎。把上方对话浓缩成一份结构化 checkpoint，让另一个模型能无缝接手。',
      '',
      '严格按下面的 Markdown 结构输出，章节顺序不变，一项都不能少；空章节写「(none)」。',
      '',
      '## 主要诉求与意图',
      '- [用户最初与演变中的目标；措辞关键处原文引用]',
      '',
      '## 关键技术概念',
      '- [涉及的技术、框架、模式与约定]',
      '',
      '## 文件与代码',
      '- [精确路径：为何重要，关键改动或代码片段]',
      '',
      '## 错误与修复',
      '- [报错：如何解决，以及相关的用户反馈]',
      '',
      '## 未完成事项',
      '- [明确要求但尚未完成的工作]',
      '',
      '## 当前进度',
      '- [checkpoint 时刻正在做什么]',
      '',
      '## 下一步',
      '- [紧接最近一次请求的单个下一步动作，或「(none)」]',
      '',
      '## 关键上下文',
      '- [决策及其理由、约束、用户偏好、悬而未决的问题、继续所需的数据]',
      '',
      '规则：',
      '- 用简洁的中文工程语言。文件路径、命令、错误串、标识符、数值、函数签名必须原样保留。',
      '- 忠实记录用户反馈与明确指令，尤其是纠正。',
      '- 不要提及这次总结请求，也不要提到上下文被压缩过。',
      '- 只输出 checkpoint 文本，不要调用任何工具。'
    ].join('\n')
  },
  terse: {
    label: '极简摘要',
    text: [
      '把上方对话压缩成最短的可用摘要。只输出下面三节，每节不超过 5 条要点。',
      '',
      '## 未完成事项',
      '- [还没做完的]',
      '',
      '## 当前进度',
      '- [正在做什么]',
      '',
      '## 下一步',
      '- [紧接着要做的单个动作]',
      '',
      '规则：只保留继续工作必需的信息。文件路径、命令、错误串原样保留。不要提及这次总结请求。'
    ].join('\n')
  },
  handoff: {
    label: '交接向',
    text: [
      '把上方对话整理成一份交接文档，让一个完全没有上下文的同事能直接接手。',
      '',
      '## 目标与验收标准',
      '- [要达成什么，怎么算完成]',
      '',
      '## 已做的决定与理由',
      '- [决定了什么，为什么这么决定，否决过哪些方案]',
      '',
      '## 约束与红线',
      '- [不能做什么，环境限制]',
      '',
      '## 未完成事项',
      '- [按优先级排列]',
      '',
      '## 当前进度与下一步',
      '- [停在哪里，紧接着做什么]',
      '',
      '## 坑与注意事项',
      '- [踩过的坑，容易搞错的地方]',
      '',
      '规则：强调「为什么」而不只是「是什么」。文件路径、命令、错误串原样保留。不要提及这次总结请求。'
    ].join('\n')
  }
}

/**
 * 把配置解析成实际要用的提示词文本。
 * @param {{ promptTemplate?: string, prompt?: string }} cfg - 面板配置。
 * @returns {string} 提示词原文；空串表示「不自定义提示词」。
 */
export function effectivePrompt (cfg) {
  const id = cfg === undefined || cfg === null ? undefined : cfg.promptTemplate
  if (id === 'custom') return typeof cfg.prompt === 'string' ? cfg.prompt : ''
  if (id === undefined || id === NATIVE_TEMPLATE) return ''
  const template = TEMPLATES[id]
  return template === undefined ? '' : template.text
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /root/dsha-oha-whale-compress && node --test test/prompt-templates.test.mjs`
Expected: PASS（6 个测试）

- [ ] **Step 5: Commit**

```bash
cd /root/dsha-oha-whale-compress
git add src/prompt-templates.js test/prompt-templates.test.mjs
git commit -m "feat: 内置压缩提示词模板与 effectivePrompt 解析"
```

---

### Task 3: 压缩引擎核心（分流 + 自定义 LLM 调用）

**Files:**
- Create: `src/engine.js`
- Create: `test/engine.test.mjs`

**Interfaces:**
- Consumes: `resolveDshHome`（Task 1）、`createConfigStore`（Task 1）、`effectivePrompt` / `TEMPLATES`（Task 2）
- Produces:
  - `class WhaleCompactionEngine extends BasicCompactionEngine`（default export 同名）
  - `engine.isManual(agent): boolean` —— 公开给测试的标记查询
  - `buildSummaryResult(assembler, provider, model, maxTokens): SummaryResult`（具名导出，供测试直接断言形状）

- [ ] **Step 1: 写失败的测试**

Create `test/engine.test.mjs`：

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /root/dsha-oha-whale-compress && node --test test/engine.test.mjs`
Expected: FAIL —— `Cannot find module '../src/engine.js'`

- [ ] **Step 3: 实现 `src/engine.js`**

```js
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
    if (!this.isManual(agent)) return await super.summarize(input, agent, signal)

    // 每次压缩都新建 store 重新读盘：host 层面板的 save() 与 preset realm 里的引擎
    // 是两个实例，而引擎实例通常活得比一次面板保存更久 —— 常驻缓存会让「改完提示词
    // 立刻压缩」用上旧配置（spec §4.2 要求 summarize() 时读配置）。压缩是低频操作，
    // 一次小文件读取的代价可接受。
    const cfg = await createConfigStore(this.#home).get()
    const configuredModel = cfg.provider !== '' && cfg.model !== ''
    let prompt = effectivePrompt(cfg)

    // spec §11 A：没给提示词但指定了模型时，用内置默认模板
    if (prompt.trim() === '' && !configuredModel) return await super.summarize(input, agent, signal)
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

    const assembler = await streamToAssembler(this.ctx, options)
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

export default WhaleCompactionEngine
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /root/dsha-oha-whale-compress && node --test test/engine.test.mjs`
Expected: PASS（13 个测试）

> 若「drop-in 回归对照」失败，说明分流走进了自定义路径 —— 检查 `isManual` 与「提示词空 + 模型空」的判定。

- [ ] **Step 5: Commit**

```bash
cd /root/dsha-oha-whale-compress
git add src/engine.js test/engine.test.mjs
git commit -m "feat: 自定义压缩引擎（手动分流 + 自定义提示词/模型）"
```

---

### Task 4: 手动路径重试（修掉框架缺陷 A）

**Files:**
- Modify: `src/engine.js`（`summarize` 的两条支路）
- Modify: `test/engine.test.mjs`（追加测试）

**Interfaces:**
- Consumes: `streamToAssembler`、`buildSummaryResult`（Task 3）
- Produces:
  - `withRetry(fn: () => Promise<T>, opts: { attempts?: number, baseMs?: number, signal?: AbortSignal, label?: string }): Promise<T>`
  - `shouldRetry(error: unknown, signal?: AbortSignal): boolean`

- [ ] **Step 1: 写失败的测试**

追加到 `test/engine.test.mjs` 末尾：

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /root/dsha-oha-whale-compress && node --test test/engine.test.mjs`
Expected: FAIL —— `withRetry` / `shouldRetry` 未导出；「重试救回」用例里 `calls === 1` 而非 2

- [ ] **Step 3: 实现重试工具**

在 `src/engine.js` 里新增两个导出函数：

```js
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
```

- [ ] **Step 4: 把两条支路接上重试**

在 `summarize()` 里改两处。

原生支路 —— 把这一行：

```js
    if (!this.isManual(agent)) return await super.summarize(input, agent, signal)
```

改为：

```js
    // 非手动：完全交还基类，不加任何重试（自动压缩已有框架自带的两层重试）
    if (!this.isManual(agent)) return await super.summarize(input, agent, signal)
```

并把「提示词空 + 模型空」那一行的 `super` 调用改为带重试：

```js
    if (prompt.trim() === '' && !configuredModel) {
      return await withRetry(() => super.summarize(input, agent, signal), { signal })
    }
```

> `super.summarize` 是纯摘要调用（只读对话前缀 + 调一次 LLM），失败无副作用，可安全重试。

自定义支路 —— 把这一行：

```js
    const assembler = await streamToAssembler(this.ctx, options)
```

改为：

```js
    const assembler = await withRetry(() => streamToAssembler(this.ctx, options), { signal })
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd /root/dsha-oha-whale-compress && node --test test/engine.test.mjs`
Expected: PASS（18 个测试）

- [ ] **Step 6: 确认没有把重试套到 compactNow 上**

Run: `grep -n "withRetry" src/engine.js`
Expected: 只出现在 `summarize()` 内部的两处（原生支路、自定义支路）与函数定义处；
**不得**出现在 `compactNow()` 里（`compactNow` 有 `runMaintenance` 与提交副作用，重试它会破坏状态）

- [ ] **Step 7: Commit**

```bash
cd /root/dsha-oha-whale-compress
git add src/engine.js test/engine.test.mjs
git commit -m "fix: 手动压缩套指数退避重试，修掉框架缺陷 A（零重试）"
```

---

### Task 5: preset 注入器

**Files:**
- Create: `src/injector.js`
- Create: `test/injector.test.mjs`

**Interfaces:**
- Produces:
  - `STOCK_ENGINE = '@deepseek-ai/dsh-compaction-basic'`
  - `WHALE_ENGINE = 'dsh-oha-whale-compress/engine'`
  - `findEngineRows(text: string, name: string): Array<{ index: number, indent: string, raw: string }>`
  - `replaceRow(text: string, from: string, to: string): { ok: true, text: string } | { ok: false, reason: 'not-found' | 'ambiguous', count?: number }`
  - `injectPreset(opts: { presetPath: string, userRoot: string, mode: 'inject' | 'restore', now?: Date }): Promise<{ status: 'ok' | 'already' | 'refused' | 'not-found' | 'ambiguous' | 'restored', file: string, backup?: string, reason?: string }>`

- [ ] **Step 1: 写失败的测试**

Create `test/injector.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  STOCK_ENGINE, WHALE_ENGINE, findEngineRows, replaceRow, injectPreset
} from '../src/injector.js'

const FIXTURE = [
  '# 顶部注释必须原样保留',
  '- id: compaction',
  '  name: cordis:group',
  '  group: true',
  '  isolate:',
  '    compaction: true',
  '  config:',
  "    - id: compaction-basic",
  `      name: '${STOCK_ENGINE}'`,
  '',
  '    - id: command-compact',
  "      name: '@deepseek-ai/dsh-command-compact'",
  ''
].join('\n')

test('findEngineRows 找到唯一一行并带出缩进', () => {
  const rows = findEngineRows(FIXTURE, STOCK_ENGINE)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].indent, '      ')
})

test('replaceRow 只改那一行，其余字节完全不变', () => {
  const result = replaceRow(FIXTURE, STOCK_ENGINE, WHALE_ENGINE)
  assert.equal(result.ok, true)
  assert.equal(result.text, FIXTURE.replace(`name: '${STOCK_ENGINE}'`, `name: '${WHALE_ENGINE}'`))
  assert.ok(result.text.startsWith('# 顶部注释必须原样保留'))
  assert.equal(result.text.length, FIXTURE.length - STOCK_ENGINE.length + WHALE_ENGINE.length)
})

test('replaceRow 找不到时报 not-found，绝不编造', () => {
  assert.deepEqual(replaceRow('# 空文件\n', STOCK_ENGINE, WHALE_ENGINE), { ok: false, reason: 'not-found' })
})

test('replaceRow 多处匹配时报 ambiguous 并给出数量', () => {
  const twice = FIXTURE + FIXTURE
  assert.deepEqual(replaceRow(twice, STOCK_ENGINE, WHALE_ENGINE), { ok: false, reason: 'ambiguous', count: 2 })
})

async function presetFixture (body = FIXTURE) {
  const root = await mkdtemp(join(tmpdir(), 'whale-root-'))
  const dir = join(root, 'maomao')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'agent.cordis.yml')
  await writeFile(file, body)
  return { root, dir, file }
}

test('injectPreset 注入成功并留下备份', async () => {
  const { root, file } = await presetFixture()
  const r = await injectPreset({ presetPath: file, userRoot: root, mode: 'inject' })
  assert.equal(r.status, 'ok')
  assert.ok(r.backup.includes('.bak-'), '必须留下备份文件')
  assert.ok((await readFile(file, 'utf8')).includes(`name: '${WHALE_ENGINE}'`))
  assert.equal((await readFile(r.backup, 'utf8')), FIXTURE)
})

test('injectPreset 幂等：已是引擎行则跳过且不再备份', async () => {
  const { root, file } = await presetFixture()
  await injectPreset({ presetPath: file, userRoot: root, mode: 'inject' })
  const before = (await readdir(join(root, 'maomao'))).filter((n) => n.includes('.bak-')).length
  const second = await injectPreset({ presetPath: file, userRoot: root, mode: 'inject' })
  assert.equal(second.status, 'already')
  const after = (await readdir(join(root, 'maomao'))).filter((n) => n.includes('.bak-')).length
  assert.equal(after, before)
})

test('injectPreset 还原回原生引擎', async () => {
  const { root, file } = await presetFixture()
  await injectPreset({ presetPath: file, userRoot: root, mode: 'inject' })
  const back = await injectPreset({ presetPath: file, userRoot: root, mode: 'restore' })
  assert.equal(back.status, 'restored')
  assert.ok((await readFile(file, 'utf8')).includes(`name: '${STOCK_ENGINE}'`))
})

test('injectPreset 拒绝写 user 根之外的文件（shipped preset）', async () => {
  const { file } = await presetFixture()
  const otherRoot = await mkdtemp(join(tmpdir(), 'whale-other-'))
  const r = await injectPreset({ presetPath: file, userRoot: otherRoot, mode: 'inject' })
  assert.equal(r.status, 'refused')
  assert.match(r.reason, /user/)
  assert.equal(await readFile(file, 'utf8'), FIXTURE, '拒绝时绝不能写入')
})

test('injectPreset 结构不认识时拒绝，不做任何写入', async () => {
  const { root, file } = await presetFixture('# 没有 compaction 行\n- id: x\n  name: y\n')
  const r = await injectPreset({ presetPath: file, userRoot: root, mode: 'inject' })
  assert.equal(r.status, 'not-found')
  assert.equal((await readdir(join(root, 'maomao'))).filter((n) => n.includes('.bak-')).length, 0)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /root/dsha-oha-whale-compress && node --test test/injector.test.mjs`
Expected: FAIL —— `Cannot find module '../src/injector.js'`

- [ ] **Step 3: 实现 `src/injector.js`**

```js
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

/** 框架原生的压缩引擎包名（preset 行里现在写的那个）。 */
export const STOCK_ENGINE = '@deepseek-ai/dsh-compaction-basic'
/** 我们的压缩引擎子路径。 */
export const WHALE_ENGINE = 'dsh-oha-whale-compress/engine'

/** 转义正则元字符。 */
function escapeRegExp (value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 找出所有形如 `  name: '<engine>'` 的整行。
 *
 * 只匹配**独占一行**的 name 行，避免误伤注释或行内出现同名字符串。
 * @param {string} text - composition 文件全文。
 * @param {string} name - 要匹配的包名。
 * @returns {Array<{ index: number, indent: string, raw: string }>} 匹配到的行。
 */
export function findEngineRows (text, name) {
  // 必须用「不含换行的空白」[^\S\n]，不能用 \s —— \s 会把行尾的换行一起吞掉，
  // 使 row.raw 跨到下一行，替换后就会静默丢掉一个空行（会破坏「其余字节不变」的保证）。
  const re = new RegExp(`^([^\\S\\n]*)name:[^\\S\\n]*'${escapeRegExp(name)}'[^\\S\\n]*$`, 'gm')
  const found = []
  let match
  while ((match = re.exec(text)) !== null) {
    found.push({ index: match.index, indent: match[1], raw: match[0] })
  }
  return found
}

/**
 * 把一行引擎名替换成另一个。
 *
 * **绝不重新序列化 YAML** —— 那会抹掉全部注释与 `!!js` 表达式。这里只做字节级
 * 的单行替换，文件的其余部分保持不变。
 * @param {string} text - 原文。
 * @param {string} from - 原引擎包名。
 * @param {string} to - 目标引擎包名。
 * @returns {{ ok: true, text: string } | { ok: false, reason: 'not-found' | 'ambiguous', count?: number }} 结果。
 */
export function replaceRow (text, from, to) {
  const rows = findEngineRows(text, from)
  if (rows.length === 0) return { ok: false, reason: 'not-found' }
  if (rows.length > 1) return { ok: false, reason: 'ambiguous', count: rows.length }
  const row = rows[0]
  const replacement = `${row.indent}name: '${to}'`
  return { ok: true, text: text.slice(0, row.index) + replacement + text.slice(row.index + row.raw.length) }
}

/** 生成备份文件名后缀，例如 20260911-120000。 */
function stamp (now) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/**
 * 就地对一个 preset 的 composition 做注入 / 还原。
 *
 * 五条安全规则（spec §8.2）：只写 user 根、绝不重新序列化、唯一性硬检查、
 * 先备份、幂等。
 * @param {{ presetPath: string, userRoot: string, mode: 'inject' | 'restore', now?: Date }} opts - 参数。
 * @returns {Promise<object>} 结果对象，`status` 取值 ok / already / restored / refused / not-found / ambiguous。
 */
export async function injectPreset (opts) {
  const file = resolve(opts.presetPath)
  const root = resolve(opts.userRoot)
  const from = opts.mode === 'restore' ? WHALE_ENGINE : STOCK_ENGINE
  const to = opts.mode === 'restore' ? STOCK_ENGINE : WHALE_ENGINE

  // 规则 1：只写 user 根之内
  if (file !== root && !file.startsWith(root + sep)) {
    return { status: 'refused', file, reason: `只能修改 user 根（${root}）之内的 preset；shipped preset 会被升级覆盖` }
  }

  const text = await readFile(file, 'utf8')

  // 规则 5：幂等
  const already = findEngineRows(text, to)
  if (already.length > 0) {
    return { status: 'already', file }
  }

  const result = replaceRow(text, from, to)
  if (!result.ok) return { status: result.reason, file, ...(result.count === undefined ? {} : { count: result.count }) }

  // 规则 4：先备份
  const backup = `${file}.bak-${stamp(opts.now ?? new Date())}`
  await copyFile(file, backup)
  await writeFile(file, result.text, 'utf8')

  return { status: opts.mode === 'restore' ? 'restored' : 'ok', file, backup }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /root/dsha-oha-whale-compress && node --test test/injector.test.mjs`
Expected: PASS（9 个测试）

- [ ] **Step 5: 对三个真实 preset 做 dry-run（只读，不写）**

```bash
cd /root/dsha-oha-whale-compress && node -e '
import("./src/injector.js").then(async (m) => {
  const { readFile } = await import("node:fs/promises")
  for (const id of ["maomao", "maomao-r18", "liangshen"]) {
    const f = `/root/.dsh/.agent-presets/${id}/agent.cordis.yml`
    const text = await readFile(f, "utf8")
    const r = m.replaceRow(text, m.STOCK_ENGINE, m.WHALE_ENGINE)
    const delta = r.ok ? r.text.length - text.length : -1
    const lines = r.ok ? r.text.split("\n").length - text.split("\n").length : -1
    console.log(id, "->", r.ok ? "ok" : r.reason, "| 长度差", delta, "| 行数差", lines)
  }
})
'
```

Expected: 三行都是 `ok`，**长度差 = −4**（`@deepseek-ai/dsh-compaction-basic` 33 字符 →
`dsh-oha-whale-compress/engine` 29 字符），**行数差 = 0**。
行数差必须为 0 —— 这是「只改了一行、没有增删行」的证据。长度差随包名长度而变，不是断言重点。

- [ ] **Step 6: Commit**

```bash
cd /root/dsha-oha-whale-compress
git add src/injector.js test/injector.test.mjs
git commit -m "feat: preset 注入器（单行替换 + 备份 + 幂等 + user 根策略）"
```

---

### Task 6: 包导出与依赖声明

**Files:**
- Modify: `package.json`
- Create: `test/exports.test.mjs`

**Interfaces:**
- Consumes: `src/engine.js`（Task 3）
- Produces: 可被 preset 行解析的 `dsh-oha-whale-compress/engine`

- [ ] **Step 1: 写失败的测试**

Create `test/exports.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))

test('exports 暴露 ./engine 子路径', async () => {
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
  assert.equal(pkg.exports['./engine'], './src/engine.js')
})

test('保留既有导出，不破坏 client 与入口', async () => {
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
  assert.equal(pkg.exports['.'], './src/index.js')
  assert.equal(pkg.exports['./client'], './client/client.js')
})

test('运行时不引入新依赖', async () => {
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
  assert.deepEqual(pkg.dependencies ?? {}, {})
})

test('宿主提供的包声明为 peerDependencies', async () => {
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
  assert.ok(pkg.peerDependencies['@deepseek-ai/dsh-compaction-basic'])
  assert.ok(pkg.peerDependencies['@deepseek-ai/dsh-llm'])
})

test('新增 test script 使用 node --test', async () => {
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
  assert.equal(pkg.scripts.test, 'node --test')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /root/dsha-oha-whale-compress && node --test test/exports.test.mjs`
Expected: FAIL —— `./engine` 为 undefined、`peerDependencies` 缺少条目、`scripts` 为 undefined

- [ ] **Step 3: 修改 `package.json`**

三处改动：

1. `exports` 增加一行（放在 `./client` 之后）：

```json
    "./engine": "./src/engine.js",
```

2. `peerDependencies` 增加两条（保留已有的 `@deepseek-ai/cordis`）：

```json
    "@deepseek-ai/dsh-compaction-basic": "^0.1.5-rc.1",
    "@deepseek-ai/dsh-llm": "^0.1.5-rc.1",
```

并在 `peerDependenciesMeta` 里把这两条标为 `{ "optional": true }`（与既有的 cordis 条目风格一致），
因为只有选用了自定义压缩的 preset 才会加载 `./engine`。

3. 新增 `scripts`：

```json
  "scripts": {
    "test": "node --test"
  },
```

同时在 `files` 数组中加入 `"test"`（可选）并确保 `"src"` 已在其中（现有值已包含 `src`）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /root/dsha-oha-whale-compress && node --test test/exports.test.mjs`
Expected: PASS（5 个测试）

- [ ] **Step 5: 验证子路径真的能被 import**

Run: `cd /root/dsha-oha-whale-compress && node -e 'import("dsh-oha-whale-compress/engine").then(m => console.log("default:", typeof m.default, "| named:", typeof m.WhaleCompactionEngine))'`
Expected: `default: function | named: function`

- [ ] **Step 6: Commit**

```bash
cd /root/dsha-oha-whale-compress
git add package.json test/exports.test.mjs
git commit -m "chore: 暴露 ./engine 子路径导出并声明宿主 peer 依赖"
```

---

### Task 7: HTTP 路由（配置新字段 + preset 列表 + 注入）

**Files:**
- Modify: `src/http.js`
- Modify: `src/index.js`（把注入所需信息传给 `registerRoutes`）
- Create: `test/http.test.mjs`

**Interfaces:**
- Consumes: `injectPreset` / `STOCK_ENGINE` / `WHALE_ENGINE`（Task 5）、`createConfigStore`（Task 1）、`TEMPLATE_IDS` / `TEMPLATES`（Task 2）
- Produces:
  - `GET /oha-whale-compress/configure` → `{ ok: true, config, templates: [{ id, label }] }`
  - `POST /oha-whale-compress/configure` → 接受 `provider` / `model` / `keepN` / `promptTemplate` / `prompt`
  - `GET /oha-whale-compress/presets` → `{ ok: true, presets: [{ id, injected, path }] }`
  - `POST /oha-whale-compress/inject` → body `{ presetId, mode }` → 注入器结果

- [ ] **Step 1: 写失败的测试**

Create `test/http.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConfigStore } from '../src/config-store.js'
import { STOCK_ENGINE, injectPreset } from '../src/injector.js'
import { registerRoutes } from '../src/http.js'

const ROW = (name) => `      name: '${name}'`
const FIXTURE = ['- id: compaction', '  config:', "    - id: compaction-basic", ROW(STOCK_ENGINE), ''].join('\n')

/** 造一个极简的 webServer 假实现，记录注册的路由。 */
function fakeWebServer () {
  const routes = new Map()
  return {
    routes,
    register (def) {
      routes.set(def.path, def.handler)
      return () => routes.delete(def.path)
    }
  }
}

/** 调用一个已注册路由。 */
async function call (handler, { method = 'GET', url = '/', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    method,
    url,
    headers: body === undefined ? {} : { 'content-length': String(chunks[0].length) },
    async *[Symbol.asyncIterator] () { for (const c of chunks) yield c }
  }
  let code = 0
  let payload = ''
  const res = {
    writeHead (c) { code = c },
    end (t) { payload = t ?? '' }
  }
  await handler(req, res)
  return { code, json: payload === '' ? undefined : JSON.parse(payload) }
}

async function setup () {
  const home = await mkdtemp(join(tmpdir(), 'whale-http-'))
  const presetRoot = join(home, '.agent-presets')
  const dir = join(presetRoot, 'maomao')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'agent.cordis.yml'), FIXTURE)
  const webServer = fakeWebServer()
  const configStore = createConfigStore(home)
  registerRoutes({ webServer, configStore, ctx: {}, presetRoot })
  return { home, presetRoot, dir, webServer }
}

test('GET /configure 返回配置与可用模板清单', async () => {
  const { webServer } = await setup()
  const r = await call(webServer.routes.get('/oha-whale-compress/configure'))
  assert.equal(r.code, 200)
  assert.equal(r.json.config.promptTemplate, 'native')
  assert.deepEqual(r.json.templates.map((t) => t.id), ['native', 'default', 'terse', 'handoff', 'custom'])
})

test('POST /configure 接受新字段', async () => {
  const { webServer, home } = await setup()
  const r = await call(webServer.routes.get('/oha-whale-compress/configure'), {
    method: 'POST',
    body: { provider: 'p', model: 'm', promptTemplate: 'custom', prompt: 'X' }
  })
  assert.equal(r.code, 200)
  assert.equal(r.json.config.promptTemplate, 'custom')
  assert.equal(r.json.config.prompt, 'X')
  assert.equal(await createConfigStore(home).then((s) => s.get()).then((c) => c.prompt), 'X')
})

test('POST /configure 忽略类型不对的新字段', async () => {
  const { webServer } = await setup()
  const r = await call(webServer.routes.get('/oha-whale-compress/configure'), {
    method: 'POST',
    body: { promptTemplate: 42, prompt: { nope: true } }
  })
  assert.equal(r.code, 200)
  assert.equal(r.json.config.promptTemplate, 'native')
  assert.equal(r.json.config.prompt, '')
})

test('GET /presets 列出 user preset 及其注入状态', async () => {
  const { webServer } = await setup()
  const r = await call(webServer.routes.get('/oha-whale-compress/presets'))
  assert.equal(r.code, 200)
  assert.equal(r.json.presets.length, 1)
  assert.equal(r.json.presets[0].id, 'maomao')
  assert.equal(r.json.presets[0].injected, false)
})

test('POST /inject 注入后 /presets 状态翻转', async () => {
  const { webServer } = await setup()
  const injected = await call(webServer.routes.get('/oha-whale-compress/inject'), {
    method: 'POST',
    body: { presetId: 'maomao', mode: 'inject' }
  })
  assert.equal(injected.code, 200)
  assert.equal(injected.json.status, 'ok')
  assert.ok(injected.json.backup)

  const listed = await call(webServer.routes.get('/oha-whale-compress/presets'))
  assert.equal(listed.json.presets[0].injected, true)
})

test('POST /inject 拒绝越界的 presetId（路径穿越）', async () => {
  const { webServer } = await setup()
  const r = await call(webServer.routes.get('/oha-whale-compress/inject'), {
    method: 'POST',
    body: { presetId: '../../etc', mode: 'inject' }
  })
  assert.equal(r.code, 400)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /root/dsha-oha-whale-compress && node --test test/http.test.mjs`
Expected: FAIL —— 路由 `/oha-whale-compress/presets` 与 `/oha-whale-compress/inject` 不存在

- [ ] **Step 3: 扩展 `/configure` 路由**

在 `src/http.js` 顶部补充 import：

```js
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WHALE_ENGINE, injectPreset } from './injector.js'
import { TEMPLATE_IDS, TEMPLATES } from './prompt-templates.js'
```

把 `registerRoutes` 的签名改为：

```js
export function registerRoutes ({ webServer, configStore, ctx, presetRoot }) {
```

GET 分支的返回体改为：

```js
        try {
          const config = await configStore.get()
          sendJson(res, 200, {
            ok: true,
            config,
            templates: TEMPLATE_IDS.map((id) => ({
              id,
              label: id === 'native' ? '不自定义（跟随原生）' : id === 'custom' ? '自定义文本' : TEMPLATES[id].label
            }))
          })
        } catch (e) {
```

POST 分支的字段收集改为（在既有三行之后追加）：

```js
          if (typeof body.promptTemplate === 'string' && TEMPLATE_IDS.includes(body.promptTemplate)) patch.promptTemplate = body.promptTemplate
          if (typeof body.prompt === 'string') patch.prompt = body.prompt
```

- [ ] **Step 4: 新增 `/presets` 与 `/inject` 路由**

追加在 `/configure` 路由之后：

```js
  // presets: 列出 user preset 及注入状态（只读）
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/oha-whale-compress/presets',
    async handler (req, res) {
      if (req.method !== 'GET') { pushMethod(res, 'GET'); return }
      try {
        const presets = await listUserPresets(presetRoot)
        sendJson(res, 200, { ok: true, presets })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e && e.message ? e.message : '读取 preset 列表失败' })
      }
    }
  }, 'dsh-oha-whale-compress: presets route'))

  // inject: 把压缩引擎那一行注入 / 还原到指定 preset
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/oha-whale-compress/inject',
    async handler (req, res) {
      if (req.method !== 'POST') { pushMethod(res, 'POST'); return }
      let body
      try {
        body = await parseJsonBody(req)
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e && e.message ? e.message : '请求体无效' })
        return
      }
      const presetId = typeof body.presetId === 'string' ? body.presetId : ''
      if (!/^[A-Za-z0-9._-]+$/.test(presetId) || presetId === '.' || presetId === '..') {
        sendJson(res, 400, { ok: false, error: 'presetId 不合法' })
        return
      }
      const mode = body.mode === 'restore' ? 'restore' : 'inject'
      try {
        const result = await injectPreset({
          presetPath: join(presetRoot, presetId, 'agent.cordis.yml'),
          userRoot: presetRoot,
          mode
        })
        sendJson(res, result.status === 'refused' ? 403 : 200, { ok: result.status !== 'refused', ...result })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e && e.message ? e.message : '注入失败' })
      }
    }
  }, 'dsh-oha-whale-compress: inject route'))
```

并在文件末尾（`registerRoutes` 之外）新增辅助函数：

```js
/**
 * 列出 user preset 根下的所有 preset 及其注入状态。
 * @param {string} presetRoot - `~/.dsh/.agent-presets` 的绝对路径。
 * @returns {Promise<Array<{ id: string, path: string, injected: boolean }>>} preset 列表。
 */
async function listUserPresets (presetRoot) {
  let entries
  try {
    entries = await readdir(presetRoot, { withFileTypes: true })
  } catch (e) {
    if (e && e.code === 'ENOENT') return []
    throw e
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = join(presetRoot, entry.name, 'agent.cordis.yml')
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    out.push({
      id: entry.name,
      path: file,
      injected: text.includes(`name: '${WHALE_ENGINE}'`)
    })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}
```

- [ ] **Step 5: 在 `src/index.js` 里传入 `presetRoot`**

```js
export function apply (ctx) {
  const home = resolveDshHome(ctx)
  const configStore = createConfigStore(home)
  const presetRoot = join(home, '.agent-presets')

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const disposers = registerRoutes({ webServer: webCtx.webServer, configStore, ctx, presetRoot })
      return () => {
        for (const d of disposers) {
          if (typeof d === 'function') d()
        }
      }
    }, 'dsh-oha-whale-compress: routes')
  })
}
```

顶部补回 `import { join } from 'node:path'`。

- [ ] **Step 6: 运行测试确认通过**

Run: `cd /root/dsha-oha-whale-compress && node --test test/http.test.mjs`
Expected: PASS（6 个测试）

- [ ] **Step 7: 跑全部测试**

Run: `cd /root/dsha-oha-whale-compress && npm test`
Expected: 全部 PASS，0 fail

- [ ] **Step 8: Commit**

```bash
cd /root/dsha-oha-whale-compress
git add src/http.js src/index.js test/http.test.mjs
git commit -m "feat: 新增 preset 列表与一键注入路由，configure 支持提示词字段"
```

---

### Task 8: 客户端 UI

**Files:**
- Modify: `client/client.js`
- Create: `test/client-structure.test.mjs`

**Interfaces:**
- Consumes: `GET /oha-whale-compress/configure`（现在返回 `templates`）、`GET /oha-whale-compress/presets`、`POST /oha-whale-compress/inject`

- [ ] **Step 1: 写失败的测试（结构断言）**

Create `test/client-structure.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const src = await readFile(fileURLToPath(new URL('../client/client.js', import.meta.url)), 'utf8')

test('新增提示词模板与文本域控件', () => {
  assert.ok(src.includes('promptTemplate'), 'client 必须处理 promptTemplate')
  assert.ok(src.includes('wcomp-prompt'), '必须有自定义提示词的文本域样式类')
})

test('模型下拉不再被 if (full) 独占（快捷面板也要能选）', () => {
  assert.ok(src.includes('wcomp-selects'), '下拉容器必须存在')
  const iApi = src.indexOf("key: 'api'")
  assert.ok(iApi > -1, "必须存在 key: 'api' 的字段块")
  const iFull = src.indexOf('if (full) {')
  const iAfterFull = src.indexOf("key: 'btn'")
  assert.ok(iFull > -1 && iAfterFull > iFull, '找不到 if (full) 块边界，测试需随实现调整')
  assert.ok(
    !(iApi > iFull && iApi < iAfterFull),
    'api 字段块不得位于 if (full) 守卫之内 —— 快捷面板也必须能选模型'
  )
})

test('keepN 标注暂未生效', () => {
  assert.ok(src.includes('暂未生效'), 'keepN 必须被标注为暂未生效')
})

test('删除已失效的旧提示文案', () => {
  assert.ok(!src.includes('Compression uses /compact engine defaults'), '旧提示必须删除')
  assert.ok(!src.includes('Compression uses /compact engine defaults.'))
})

test('新增注入入口', () => {
  assert.ok(src.includes('/oha-whale-compress/inject'), 'client 必须能触发注入')
  assert.ok(src.includes('/oha-whale-compress/presets'), 'client 必须能列出 preset')
})

test('语法有效', async () => {
  const { execFileSync } = await import('node:child_process')
  execFileSync(process.execPath, ['--check', fileURLToPath(new URL('../client/client.js', import.meta.url))])
})
```

> 第 2 条断言写得别扭是刻意的：它要挡住「把下拉又塞回 `if (full)` 里」这个回归。
> 若实现后该断言仍失败，**先修断言**使其精确表达意图，再继续 —— 但不得删掉这条保护。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /root/dsha-oha-whale-compress && node --test test/client-structure.test.mjs`
Expected: FAIL —— 缺少 `wcomp-prompt`、`暂未生效`、`/oha-whale-compress/inject`

- [ ] **Step 3: 改 `client/client.js`**

按下列五处改动实施（保持既有代码风格：`react.createElement`、行内样式常量、`makeT` 文案对象）：

1. **文案对象**（`makeT`）：
   - 删除 `configHint` 里 "Compression uses /compact engine defaults." 那半句，改成
     `'提示词与压缩模型仅作用于手动压缩；自动压缩仍用引擎默认策略。'`
   - 新增 `promptLabel: '压缩提示词'`、`promptTemplateLabel: '提示词模板'`、`keepNDisabled: '暂未生效'`、
     `injectSection: '安装到 agent preset'`、`injectButton: '注入'`、`restoreButton: '还原'`、
     `injected: '已注入'`、`notInjected: '未注入'`、`injectConfirm: '将修改 presets/<id>/agent.cordis.yml，并先备份为 .bak-<时间戳>。继续？'`、
     `tooLongHint: '摘要不够短，请换更精简的模板（如「极简摘要」）'`
   - **spec §9 的「摘要过大」提示**：框架在 `summarizeCompaction` 里已有硬检查
     （`summary is not smaller than the shadowed content`），该错误会原样冒到命令结果。
     在 `doCompress()` 的 catch 里检测消息含 `not smaller`，则把 `t.tooLongHint` 一并显示 ——
     避免用户只看到一句英文内部错误而不知所措。

2. **state 与加载**：`PanelBody` 增加
   ```js
   const [promptTemplate, setPromptTemplate] = react.useState('native')
   const [prompt, setPrompt] = react.useState('')
   const [templates, setTemplates] = react.useState([])
   const [presets, setPresets] = react.useState([])
   ```
   `loadConfig()` 里追加 `if (typeof c.promptTemplate === 'string') setPromptTemplate(c.promptTemplate)`、
   `if (typeof c.prompt === 'string') setPrompt(c.prompt)`，以及 `setTemplates(Array.isArray(d.templates) ? d.templates : [])`。

3. **保存**：`saveConfig()` 的 body 改为
   ```js
   JSON.stringify({ keepN, provider, model, promptTemplate, prompt })
   ```

4. **渲染**：
   - 把 provider/model 那一段（现 `if (full)` 内的 `key: 'api'` 块）**移出 `if (full)`**，使其在快捷面板也渲染；
   - 新增一个**始终渲染**的提示词块：
     ```js
     elements.push(react.createElement('div', { className: 'wcomp-field', key: 'prompt' },
       react.createElement('div', { className: 'wcomp-label' }, t.promptTemplateLabel),
       react.createElement(Select, {
         value: promptTemplate,
         options: templates.map((x) => ({ id: x.id, label: x.label })),
         onChange: (v) => {
           setPromptTemplate(v)
           // spec §11 A：选了模型却用 native 时，UI 上自动切到默认模板，让用户看得见将用哪段提示词
           if (v === 'native' && (provider !== '' || model !== '')) setPromptTemplate('default')
         }
       }),
       promptTemplate === 'custom'
         ? react.createElement('textarea', {
             className: 'wcomp-prompt',
             value: prompt,
             rows: 5,
             onChange: (e) => setPrompt(e.target.value)
           })
         : null))
     ```
   - `keepN` 标签追加 `t.keepNDisabled` 角标（例如 `react.createElement('span', { className: 'wcomp-badge' }, t.keepNDisabled)`）。
   - 新增 preset 注入块（仅 `full` 时渲染）：列出 `presets`，每项一行 `id` + 状态 + 注入/还原按钮；
     注入前用 `window.confirm(t.injectConfirm.replace('{id}', p.id))` 二次确认。
   - 新增样式常量 `.wcomp-prompt`（等宽、可纵向拉伸）与 `.wcomp-badge`。

5. **`inject()` 请求**：`POST /oha-whale-compress/inject`，body `{ presetId, mode }`，
   成功后重新拉取 `/presets` 刷新状态。

- [ ] **Step 4: 运行结构测试确认通过**

Run: `cd /root/dsha-oha-whale-compress && node --test test/client-structure.test.mjs`
Expected: PASS（6 个测试）

- [ ] **Step 5: 确认语法**

Run: `node --check client/client.js`
Expected: 无输出

- [ ] **Step 6: 跑全部测试**

Run: `cd /root/dsha-oha-whale-compress && npm test`
Expected: 全部 PASS

- [ ] **Step 7: Commit**

```bash
cd /root/dsha-oha-whale-compress
git add client/client.js test/client-structure.test.mjs
git commit -m "feat: 面板支持提示词模板选择、快捷面板模型选择与 preset 一键注入"
```

---

### Task 9: 端到端真机验证

> ⚠️ **本任务需要重启 `dsh web`**（新增的 `src/*.js` 是宿主代码，profile 的
> `patchReload: startup` 决定其只在启动时加载）。**重启会断掉当前会话连接**
> （会话记录持久化，重开可续）。**必须先取得用户明确同意再执行。**

**Files:** 无（验证任务）

**Interfaces:**
- Consumes: 前面全部任务

- [ ] **Step 1: 重启前记录基线**

```bash
cd /root && cp .dsh/profiles/web/package.json /tmp/web-profile-package.bak-$(date +%Y%m%d-%H%M%S).json
for p in maomao maomao-r18 liangshen; do
  cp .dsh/.agent-presets/$p/agent.cordis.yml /tmp/$p-agent.cordis.bak-$(date +%Y%m%d-%H%M%S).yml
done
```

- [ ] **Step 2: 重启 `dsh web`（需用户同意）**

重启后确认日志里插件加载完成：

Run: `grep -n "oha-whale-compress" /root/dsh-web.log | tail -5`
Expected: 含 `插件加载完成：dsh-oha-whale-compress`（不再是「等待服务」）

- [ ] **Step 3: 验证新路由**

```bash
curl -s http://127.0.0.1:3080/oha-whale-compress/configure | head -c 400; echo
curl -s http://127.0.0.1:3080/oha-whale-compress/presets; echo
```

Expected: `configure` 返回体含 `templates` 数组（5 项）；`presets` 列出 `liangshen` / `maomao` / `maomao-r18`，`injected` 均为 `false`

- [ ] **Step 4: 注入 maomao 并核对只改了一行**

```bash
cd /root/.dsh/.agent-presets/maomao
curl -s -X POST http://127.0.0.1:3080/oha-whale-compress/inject \
  -H 'Content-Type: application/json' \
  -d '{"presetId":"maomao","mode":"inject"}'; echo
BAK=$(ls -t agent.cordis.yml.bak-* | head -1)
echo "备份：$BAK"
diff "$BAK" agent.cordis.yml
```

Expected: 接口返回 `status: "ok"` 且带 `backup` 路径；
`diff` **只有一行**差异，即那行 `name:`，且行数相同

- [ ] **Step 5: 真机功能验证（在 GUI 里操作）**

1. 侧边栏「压缩会话」→ 提示词模板选「极简摘要」→ 保存；
2. 会话大小读数正常（`/status` 有 nodes/tokens）；
3. 点「压缩当前会话」；
4. 查会话日志确认压缩成功：

```bash
ls -t /root/.dsh/sessions/*.jsonl 2>/dev/null | head -3
grep -o '"type":"compaction/[a-z]*"' $(ls -t /root/.dsh/sessions/*.jsonl | head -1) | tail -5
```

Expected: 出现 `compaction/start` 与 `compaction/end`，且 **`end` 不带 `error=`**

5. 确认 checkpoint 文本符合「极简摘要」模板（只有三节），而不是原生的八节结构。

- [ ] **Step 6: 验证自动压缩未受影响**

在**没有**设置自定义模型/提示词的会话里触发一次自动溢出压缩（或确认 `compactIfNeeded` 走的仍是 `super`）：
查日志里自动压缩的 checkpoint 仍为原生八节结构。

- [ ] **Step 7: 验证留空 = 完全原生**

把模板切回「不自定义（跟随原生）」、provider/model 清空 → 手动压缩一次 →
checkpoint 文本应与注入前**结构一致**（八节）。

- [ ] **Step 8: 验证「注入不需要重启宿主」（spec §3.6 / §8.5）**

在**不重启** `dsh web` 的前提下，注入第二个 preset：

```bash
curl -s -X POST http://127.0.0.1:3080/oha-whale-compress/inject \
  -H 'Content-Type: application/json' \
  -d '{"presetId":"maomao-r18","mode":"inject"}'; echo
```

然后在 GUI 里**新建一个使用 maomao-r18 的会话**，选「极简摘要」模板，手动压缩一次。

Expected: 压缩成功且 checkpoint 使用极简模板 —— 证明 `ensureStanding()` 的 stamp 比对
（`dsh-agent-presets/lib/index.js:1769–1776`）让改动后的组合自动重新挂载，**无需重启宿主**。

- [ ] **Step 9: 记录结果并 Commit（如有代码调整）**

```bash
cd /root/dsha-oha-whale-compress
git add -A
git commit -m "test: 端到端真机验证通过（手动自定义生效、自动压缩不受影响）"
```

---

## 未覆盖 / 后续

- **`keepN` 按条数生效**：需要 override 范围选择（`compactRange` 是公开方法，
  `toolPairingBalancedBefore/After` 由 `@deepseek-ai/dsh-compaction` 导出）。需另开一轮探测 + spec。
- **框架升级跟进**：`finishError` 与 fallback 链是复刻的私有逻辑，
  升级后跑 `npm test` 的回归对照即可发现漂移。
- **npm 发布**：`dsh plugin add` 的裸包名路径在 DSHA 上装不出客户端 UI（见既有交接文档），
  本轮只保证源码 / `link:` 安装可用。
