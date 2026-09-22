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
