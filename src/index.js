import { createConfigStore } from './config-store.js'
import { registerRoutes } from './http.js'
import { resolveDshHome } from './home.js'

export const name = 'dsh-oha-whale-compress'
// 血泪教训：插件只硬 inject webServer，其余服务一律 ctx.get() 懒取。
export const inject = ['webServer']

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
