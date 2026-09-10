import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const DEFAULTS = {
  provider: '',
  model: '',
  keepN: 1000
}

/**
 * 轻量配置存储：持久化到 ~/.dsh/storages/dsh-oha-whale-compress/config.json。
 * @param {string} home - dsh home 目录。
 * @returns {{ get: () => Promise<object>, save: (patch: object) => Promise<object>, file: string }}
 */
export function createConfigStore (home) {
  const dir = join(home, 'storages', 'dsh-oha-whale-compress')
  const file = join(dir, 'config.json')
  let cache = null

  async function load () {
    if (cache !== null) return cache
    try {
      const raw = await readFile(file, 'utf8')
      const parsed = JSON.parse(raw)
      cache = { ...DEFAULTS, ...(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) }
    } catch {
      cache = { ...DEFAULTS }
    }
    return cache
  }

  async function get () {
    return { ...(await load()) }
  }

  async function save (patch) {
    const current = await load()
    const next = { ...current, ...(patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}) }
    await mkdir(dir, { recursive: true })
    await writeFile(file, JSON.stringify(next, null, 2) + '\n', 'utf8')
    cache = next
    return { ...next }
  }

  return { get, save, file }
}
