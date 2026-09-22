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
