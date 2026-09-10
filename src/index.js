import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createConfigStore } from './config-store.js'
import { registerRoutes } from './http.js'

export const name = 'dsh-oha-whale-compress'
// 血泪教训：插件只硬 inject webServer，其余服务一律 ctx.get() 懒取。
export const inject = ['webServer']

function resolveDshHome (ctx) {
  if (typeof ctx.dshHomePath === 'function') return ctx.dshHomePath()
  const fromEnv = process.env.DSH_HOME
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

export function apply (ctx) {
  const home = resolveDshHome(ctx)
  const configStore = createConfigStore(home)

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const disposers = registerRoutes({ webServer: webCtx.webServer, configStore, ctx })
      return () => {
        for (const d of disposers) {
          if (typeof d === 'function') d()
        }
      }
    }, 'dsh-oha-whale-compress: routes')
  })
}
