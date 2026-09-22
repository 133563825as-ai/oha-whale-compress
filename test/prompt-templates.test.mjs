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

test('原型链上继承的函数属性不算内置模板，回落为不自定义', () => {
  assert.equal(effectivePrompt({ promptTemplate: 'constructor', prompt: 'ignored' }), '')
  assert.equal(effectivePrompt({ promptTemplate: 'toString', prompt: 'ignored' }), '')
})

test('__proto__ 这个继承访问器属性不算内置模板，回落为不自定义', () => {
  assert.equal(effectivePrompt({ promptTemplate: '__proto__', prompt: 'ignored' }), '')
})

test('effectivePrompt 对任何输入都返回 string', () => {
  const cfgs = [
    undefined,
    null,
    {},
    { promptTemplate: 'native', prompt: 'ignored' },
    { promptTemplate: 'custom', prompt: 123 },
    { promptTemplate: 'nope', prompt: '' },
    { promptTemplate: '', prompt: '' },
    { promptTemplate: 'constructor', prompt: '' },
    { promptTemplate: '__proto__', prompt: '' },
    { promptTemplate: 'default', prompt: '' }
  ]
  for (const cfg of cfgs) {
    assert.equal(typeof effectivePrompt(cfg), 'string', `cfg=${JSON.stringify(cfg)}`)
  }
})
