import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

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
