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
  // 必须查自有属性：TEMPLATES 是对象字面量，直接取值会命中原型链上的
  // constructor / toString / __proto__ 等键，把 undefined 当提示词返回。
  const template = Object.hasOwn(TEMPLATES, id) ? TEMPLATES[id] : undefined
  return template === undefined ? '' : template.text
}
