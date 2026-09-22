# 压缩会话插件 · 自定义压缩设计（spec）

- 日期：2026-09-11
- 目标包：`dsh-oha-whale-compress`（当前 0.1.0）
- 环境：`dsh 0.1.5-rc.1` / `dsh-compaction-basic 0.1.5-rc.1` / Node v24.19.0
- 状态：**待评审**（有两处需要你拍板，见 §11）

---

## 1. 背景

插件 `dsh-oha-whale-compress` 的面板早就可以配置「压缩用 provider / model」和「保留最新 N 条」，
但这些值**存了之后从来没有被使用过**：

- `src/http.js` 的 `/oha-whale-compress/compress` 只把 `sessionId` 传给 `/compact`；
- 界面自己都写着：`Compression uses /compact engine defaults.`

早先的交接文档结论是「自定义不可能，是架构限制」。**这个结论已在本轮被实测推翻**
（证据见 §3 与附录 A）。

---

## 2. 目标 / 非目标

### 目标（本轮）

1. **自定义压缩提示词** —— 模板下拉（内置几个）+ 可编辑。
2. **自定义压缩 provider / model** —— 复用面板已有的两个下拉，让选中的值真正生效。
3. **只作用于手动压缩** —— 用户亲手点的那一次。自动溢出压缩保持原生行为。
4. **可开源分发** —— 提供「一键注入」，不能要求使用者手抄 YAML。
5. **免费修掉一个框架缺陷** —— 手动压缩零重试（附录 B）。

### 非目标（本轮明确不做）

- **「保留最新 N 条」按条数生效**。引擎按 token 选范围（`retainRatio` / `retainTokens`），
  按条数需要另一次范围选择探测。本轮**不实现**；UI 上的处置方式见 §11 B。
- 不改框架包（`node_modules` 里的 `@deepseek-ai/dsh-compaction-basic` 等）。
- 不改 shipped preset（会被升级覆盖）。

---

## 3. 关键结论（全部实测/读源得到）

### 3.1 引擎有一个官方声明的子类扩展点

`dsh-compaction-basic/lib/types/index.d.ts` 原文：

> `summarize()` is **the sole subclass customization hook**; the replay and durable mutation
> strategy stays fixed… **Override this sole hook for a template or remote summarizer.**

且是**真动态派发**（`lib/index.js:972–977`）：

```js
regionDependencies() {
  return {
    meter: this.ctx.tokenMeter,
    summarize: (input, owner, abort) => this.summarize(input, owner, abort)
  }
}
```

### 3.2 框架负责 framing / 定价 / 提交，hook 只产出文本

`lib/index.js:564–568`：

```js
const summaryResult = await dependencies.summarize(prepared.input, agent, signal)
const checkpointMessage = createUserMessage({
  content: frameSummary(summaryResult.summary),
  source: compactCheckpointSource(compactionId, sourceCommandId)
})
```

→ **自定义引擎不接触 durable 写入**，"绝不直写会话日志"的红线依然成立。

### 3.3 提示词是硬编码常量，模型是配置项

- `COMPACTION_INSTRUCTION`（`lib/index.js:220–255`）是 module 级常量；
  `BASIC_COMPACT_CONFIG_KEYS` 中**没有**任何 prompt 键。
- 配置键全集：`summarizationProvider` / `summarizationModel` / `maxTokens` /
  `thresholdRatio` / `retainRatio` / `retainTokens` / `modelPolicies` / `auto` /
  `compactionRetries` / `maxOverflowRetries`。

### 3.4 运行时导出面很窄

`lib/index.js:980` → `export { BasicCompactionEngine, BasicCompactionEngine as default }`

`summarizeWithLlm`、`frameSummary`、`finishError`、`resolveConfig`、`resolveTargetPolicy`
**都没有运行时导出**，子类只能自己实现（`finishError` 已按源码复刻，见 `probe-compact/engine.mjs`）。

### 3.5 隔离 realm 与"换提供者"是唯一路径

preset 里引擎挂在带 `isolate` 的 group 内：

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate: { compaction: true, toolResultPruner: true }
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
```

且 cordis **禁止跨 fiber 覆盖服务**（`@deepseek-ai/cordis/lib/index.js` `RegistryService.set`）：

> `throw new Error(\`cannot set property "${name}" in multiple fibers\`)`

→ 从 host 层"截住"现有引擎（例如装饰 `ctx.llm`）**不可能**。
唯一路径：在 preset 的 compaction realm 内**替换该服务提供者**。

### 3.6 改 preset 文件不需要重启宿主

`dsh-agent-presets/lib/index.js:1769–1776` 的 `ensureStanding()` 每次比对
composition 文件的 `mtimeMs + size`，变化即拆除并重新挂载：

```js
const current = await compositionStamp(preset.path)
if (current === void 0 || sameStamp(mounted.stamp, current)) return mounted
if (this.standing.get(preset.id) === pending) this.standing.delete(preset.id)
return this.ensureStanding(preset)
```

→ 注入后**下次用到该 preset 时自动生效**，不必重启 `dsh web`。

### 3.7 模型留空的 fallback 链（`lib/index.js:269–280`）

```
configured(summarizationProvider/Model)  →  latest(agent.session.requestHeader()?.config)
  →  agentTarget(agent.options.provider/model)  →  throw "no provider/model available for summarization"
```

即：**留空 = 用该会话最近一次实际请求所用的模型**。

---

## 4. 架构

### 4.1 组件

| 组件 | 位置 | 形态 |
|---|---|---|
| 面板 UI | `client/client.js`（已有，500 行） | 复用已有 `Select`；新增提示词模板下拉 |
| 配置存储 | `src/config-store.js`（已有） | 新增 `prompt` / `promptTemplate` 字段 |
| HTTP 路由 | `src/http.js`（已有） | `/configure` 接收 `prompt`；新增注入器路由 |
| **压缩引擎** | `src/engine.js`（**新增**） | `BasicCompactionEngine` 子类，**运行在 preset realm** |
| **注入器** | `src/injector.js`（**新增**） | 改 preset YAML 那一行 |
| 家目录解析 | `src/home.js`（**新增**，从 `index.js` 抽出） | host 与引擎共用 |

### 4.2 两个 realm

```
host plane（profile）
  ├─ 面板 UI / HTTP 路由 / config-store      ← 写配置
  └─ 读 ~/.dsh/storages/dsh-oha-whale-compress/config.json
                    │  （跨 realm 通道 = 这个文件）
preset realm（isolate: compact）
  └─ src/engine.js  ← 在 summarize() 时读同一个文件
```

引擎与宿主是**同进程同机器**，文件即通道。选这个方案的原因：不需要任何跨 realm 服务访问。

### 4.3 数据流

```
面板改提示词/模型 ──POST /configure──▶ config.json
你点「压缩当前会话」
  └─▶ POST /compress → commands.execute(agent, '/compact', [], signal)
      └─▶ ctx.compaction.compactNow()            [preset realm，是我们]
          └─▶ 标记 agent 为"手动" → super.compactNow(...)
              └─▶ compactSurfaceRegion → deps.summarize() → 我们的 summarize()
                  └─▶ 读 config.json → 自定义提示词 + provider/model → ctx.llm.stream()
              ◀─ 框架：frameSummary → 定价 → 提交
```

---

## 5. 引擎契约

### 5.1 类形状

```js
export class WhaleCompactionEngine extends BasicCompactionEngine {
  async compactNow (agent, signal, sourceCommandId) { /* 打标记 */ }
  async summarize (input, agent, signal) { /* 分流 */ }
}
export default WhaleCompactionEngine
```

`static inject`（`['llm','tokenMeter','sessions']`）与 `static Config` 均由基类**继承**。

### 5.2 手动 / 自动的区分

`summarize(input, agent, signal)` 的入参里**没有触发来源**，因此在 `compactNow` 打标记：

```js
const manual = new WeakSet()

async compactNow (agent, signal, sourceCommandId) {
  manual.add(agent)
  try { return await super.compactNow(agent, signal, sourceCommandId) }
  finally { manual.delete(agent) }
}
```

**为什么安全**：`compactNow` 内部是 `agent.runMaintenance(...)`，排他且要求 agent 空闲
（`lib/index.js:944–968`），标记期间不会有同一 agent 的自动压缩穿插。

**不为真的风险**：其它 agent 的自动压缩可能与本 agent 的手动压缩并行。
因此**禁止**采用"临时改 `this.config` 再调 `super.summarize()`"的写法 —— 那会污染并行中的其它会话。

### 5.3 分流规则

| 提示词 | 模型 | 走哪条路 |
|---|---|---|
| 空 | 空 | `super.summarize()` —— **与原生逐字节一致** |
| 空 | 非空 | 自定义路径 + **内置默认模板**（见 §11 待拍板点 A） |
| 非空 | 空 | 自定义路径 + 复刻 fallback 链（§3.7） |
| 非空 | 非空 | 自定义路径 + 指定 provider/model |

**任何情况下，非手动触发的压缩（自动压力 / 溢出恢复）一律 `super.summarize()`，不受本设计影响。**

**自定义路径必须返回**（`SummaryResult` 契约，`lib/types/summarizer.d.ts`）：

```js
{ summary: ContentBlock[], rawOutput: ContentBlock[], llmStreamCall: true, provider, model, maxTokens, usage? }
```

其中 `summary` 必须是**纯文本块**（`type === 'text'`），否则框架的 `frameSummary` / 计价会出问题。

### 5.4 复刻的私有逻辑

| 私有函数 | 处理 |
|---|---|
| `finishError(finish)` | 按 `lib/index.js:337` 源码复刻（4 个 case） |
| fallback 链 | 按 §3.7 复刻（3 级 + 抛错） |
| 文本块过滤 | `assembler.blocks().filter(b => b.type === 'text')` |

**漂移风险**：框架升级若改这些，需人工跟进。缓解：§10 的回归对照测试会在漂移时失败。

### 5.5 顺带修掉缺陷 A（零重试）

**手动路径的两条支路都要套重试**（默认 2 次，指数退避，仅重试传输类错误）：

- 自定义路径：重试我们对 `ctx.llm.stream()` 的那次调用；
- 原生路径：重试 `super.summarize(...)`（它是幂等的纯摘要调用，失败不产生副作用，
  故可安全重试）。

注意 **只包手动路径**：自动压缩已有框架自带的两层重试（`compactionRetries` /
`maxOverflowRetries`），不该被我们叠加。这与附录 B 缺陷 A 的处置建议一致。

---

## 6. 配置模型

`~/.dsh/storages/dsh-oha-whale-compress/config.json`：

```json
{
  "provider": "",
  "model": "",
  "keepN": 1000,
  "promptTemplate": "default",
  "prompt": ""
}
```

- 新增 `prompt`、`promptTemplate`；`keepN` 保留但**本轮不生效**。
- 读写全部走已有 `createConfigStore(home)`，`DEFAULTS` 补两个新键。
- **向后兼容**：老 config.json 缺新键 → 由 `{...DEFAULTS, ...parsed}` 自动补齐。
- 缺失 / 损坏 → 回落 DEFAULTS，**绝不因配置问题让压缩失败**。

### 内置提示词模板（草案）

| id | 名称 | 取向 |
|---|---|---|
| `default` | 默认（工程向） | 等价于原生结构：主诉求 / 技术概念 / 文件 / 错误 / 待办 / 当前工作 / 下一步 |
| `terse` | 极简摘要 | 只要 待办 + 当前工作 + 下一步，尽量短 |
| `handoff` | 交接向 | 强调未完成事项、约束、决策理由，便于换人接手 |
| `custom` | 自定义 | 用 `prompt` 字段的自由文本 |

模板文本落 `src/prompt-templates.js`，host 与 client 共用同一份 id 列表。

---

## 7. UI

### 7.1 复用而非新建

provider / model **已经是两个 `Select` 下拉**（`client/client.js:117` 的 `Select` 组件，
选项来自 `modelDirectories.directoryFor(session).load()`，`client.js:276–282`、`317–318`、`349–350`）。
本轮**只做接线**，不新造控件。

`modelDirectories` 服务由 `@deepseek-ai/dsh-client-ui-model-selection` 提供，
而它是 `dsh-web-app` 的依赖 → 已加载。

### 7.2 新增字段

| 字段 | 控件 |
|---|---|
| 提示词模板 | 下拉（内置模板 id 列表） |
| 自定义提示词 | `<textarea>`，选 `custom` 或想微调时用；选中模板时预填模板文本 |

### 7.3 快捷面板

当前 `if (full)`（`client.js:342`）把 provider/model/keepN/保存 全掐掉了。
本轮把 **provider/model + 提示词模板**也放进减半面板，省得每次开全量面板。

### 7.4 文案修正

- 删掉 `configHint` 里那句 "Compression uses /compact engine defaults."（不再成立）。
- `keepN` 处标注「暂未生效」。
- 注入器操作前明确展示：**将修改哪个文件、已备份到哪**。

---

## 8. 注入器

### 8.1 目标改动（单行）

```yaml
      name: '@deepseek-ai/dsh-compaction-basic'
# →
      name: 'dsh-oha-whale-compress/engine'
```

实测：三个用户 preset（`maomao` / `maomao-r18` / `liangshen`）中该行**各恰好出现 1 次**，
缩进均为 6 空格。

### 8.2 五条安全规则

1. **只写 user 根** —— 仅允许 `~/.dsh/.agent-presets/`（框架 `writableRoot()` 的语义，
   `dsh-agent-presets/lib/index.js:482`）。`SHIPPED_PRESET_ROOT`（node_modules）**拒绝**。
2. **绝不重新序列化 YAML** —— 不用 js-yaml 解析后写回（会抹掉全部注释与 `!!js` 表达式，
   `maomao/agent.cordis.yml` 有 15KB 注释）。只做**单行文本替换**。
3. **唯一性硬检查** —— 正则 `^(\s*)name:\s*'@deepseek-ai/dsh-compaction-basic'\s*$` 的匹配数
   必须恰好为 1：0 处 → 报「结构不认识，请手动改」；>1 处 → 拒绝（有歧义）。**不猜**。
4. **先备份** —— `agent.cordis.yml.bak-<YYYYMMDD-HHMMSS>`，与既有
   `.bak-20260910-122715` 约定一致。
5. **幂等** —— 已是引擎行 → 报「已注入」并跳过。

### 8.3 还原

从最新备份恢复；或注入器以「还原」模式把 name 换回 `@deepseek-ai/dsh-compaction-basic`。

### 8.4 package.json 需要新增子路径导出

当前 `exports` 只有 `.` / `./client` / `./package.json`，**需补** `./engine`。
（探测 B2 已证实：`link:` 装在 profile 里的包名，preset 行能解析。）

### 8.5 生效时机

见 §3.6：注入后**不需要重启** `dsh web`，下次用到该 preset 时按 stamp 变化自动重挂。

---

## 9. 错误处理

| 场景 | 处理 |
|---|---|
| config.json 缺失 / 损坏 | 回落 DEFAULTS（= 全原生），压缩照常成功 |
| 自定义提示词产出摘要过大 | 框架有 `framedSummaryTokenCount >= shadowedRouteTokenCount` 硬检查 → 我们给**明确文案**（"摘要不够短，请换更精简的模板"），不要退化成神秘的 "could not produce a useful summary"（附录 B 缺陷 B） |
| 模型不存在 / 路由失败 | 透传底层错误信息，不吞 |
| 引擎抛错 | 只影响这一次压缩；`finally` 保证手动标记被清掉 |
| 注入遇到 0 处 / >1 处匹配 | 拒绝执行并说明原因，**不做任何写入** |
| 目标 preset 在 shipped 根 | 拒绝并解释（升级会被覆盖） |

---

## 10. 测试

| 层 | 内容 |
|---|---|
| 单元（复用 spike 的桩 `probe-compact/probe.mjs`） | override 生效；留空走 super；手动/自动分流正确；`finishError` 各分支；fallback 链三级 |
| **回归对照（核心）** | 未配置时，我们的引擎与原生基类在同一输入下产出**相同**的 LLM 请求 → 保证 drop-in |
| 注入器 | 幂等；唯一性（0/1/多）；备份生成；shipped 根拒绝；还原 |
| 结构验证 | 对三个真实 preset 跑 **dry-run**，确认只改一行、其余字节完全不变 |
| 端到端 | 真机：改配置 → 点压缩 → 查会话日志 `compaction/end` 与 checkpoint 文本是否符合自定义 |

---

## 11. 已确认的两个决定（2026-09-11）

### A. 「提示词留空 + 模型非空」→ 采用内置默认模板

**已决定：采用建议方案，备选方案不用。**

`COMPACTION_INSTRUCTION` 是私有常量（无运行时导出），拿不到；而"临时改 `this.config`
借用 `super`"会与并行中的自动压缩抢共享状态（§5.2），故不可用。因此：

- 提示词空 **且** 模型空 → 完全原生（`super.summarize()`），用户确认的语义在此成立；
- 选了模型 → 用**内置默认模板**，且 UI 上"选模型"自动带出该模板，**用户看得见**将用哪段提示词。

对应实现见 §5.3 分流规则。

### B. `keepN` 的处置 → UI 标注「暂未生效」

**已决定：保留控件，但在面板上明确标注「暂未生效」，不从面板隐藏。**

理由：隐藏会让老用户以为功能丢了；标注则诚实，且与 §7.4 的文案修正一致。

---

## 12. 风险登记

| 风险 | 级别 | 缓解 |
|---|---|---|
| 框架升级改动 `summarize()` 契约 | 中 | §10 回归对照测试会在漂移时失败；`docs/` 记录所依赖的行号 |
| 私有逻辑复刻漂移（`finishError` / fallback 链） | 中 | 同上 |
| 注入改用户文件 | 中 | 五条安全规则 + 备份 + 还原 + UI 明确告知 |
| 并行压缩污染（若误用改 `this.config` 的写法） | 高 | §5.2 明确禁止该写法 |
| 自定义提示词产出过长导致压缩被拒 | 低 | §9 明确文案 + 模板取向偏简短 |

---

## 附录 A · spike 探测结果（2026-09-11）

探测件：`/root/probe-compact/`（一次性，跑完即弃）。结果 **17/17 通过**。

关键几条：

| 检查 | 结果 |
|---|---|
| `regionDependencies()` 暴露 dispatch 闭包 | PASS |
| 自定义提示词进入 LLM 请求 | PASS |
| 自定义 provider / model 生效 | PASS |
| 返回形状 `llmStreamCall: true` | PASS |
| **对照：基类请求里没有自定义提示词** | PASS |
| **对照：基类用的是硬编码 `COMPACTION_INSTRUCTION`** | PASS |
| `link:` 装的包名可被 preset 行解析 | PASS |
| 负对照：不存在的包名被标 broken | PASS |
| `harnessBase` 校准：真实 preset 全部健康 | PASS |

其中"对照"两条是决定性证据：同一输入、同一调用点，差异**只**来自 `summarize()` 覆写。

## 附录 B · 顺带修掉的框架缺陷

来源：`DSH-BUG-REPORT-手动压缩失败-20260910.md`，版本 `dsh-compaction-basic@0.1.5-rc.1`。

- **缺陷 A：手动压缩零重试**。普通回合有 `dsh-llm-retry`；自动溢出压缩有 `compactionRetries`
  与 `maxOverflowRetries`；**手动 `/compact` 是一次性裸奔**（`lib/index.js:861`
  `return summarizeWithLlm(...)`），因为它直接调 `ctx.llm.stream()` 不经过 agent，
  永远不触发重试监听的那个事件。→ §5.5 在自定义路径套重试。
- **缺陷 B：错误归因错误**。`lib/index.js:506–510` 把任何非 commit / 非 SurfaceChanged 的失败
  一律打成 code `summary`，于是一次 TCP 断流被渲染成
  `Compaction could not produce a useful summary.`，真因藏在从不展示的 `{ cause }` 里。
  → §9 要求我们自己的错误路径给明确文案。

## 附录 C · 证据索引（框架行号）

| 结论 | 位置 |
|---|---|
| `summarize()` 是唯一子类 hook | `dsh-compaction-basic/lib/types/index.d.ts` |
| 动态派发 | `dsh-compaction-basic/lib/index.js:972–977` |
| 框架负责 framing/提交 | `dsh-compaction-basic/lib/index.js:564–568` |
| 提示词常量 | `dsh-compaction-basic/lib/index.js:220–255` |
| 配置键全集 | `dsh-compaction-basic/lib/index.js:19–40` |
| fallback 链 | `dsh-compaction-basic/lib/index.js:269–280` |
| `finishError` | `dsh-compaction-basic/lib/index.js:337` |
| 手动零重试 | `dsh-compaction-basic/lib/index.js:861` |
| 错误归因 | `dsh-compaction-basic/lib/index.js:506–510` |
| 运行时导出面 | `dsh-compaction-basic/lib/index.js:980` |
| 禁止跨 fiber 覆盖服务 | `@deepseek-ai/cordis/lib/index.js` `RegistryService.set` |
| stamp 变化即重挂 | `dsh-agent-presets/lib/index.js:1769–1776` |
| `writableRoot()` | `dsh-agent-presets/lib/index.js:482` |
| preset 行包名解析 | `dsh-agent-presets/lib/index.js:248–291` |
