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
