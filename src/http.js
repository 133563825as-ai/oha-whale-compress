import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const ICON_PATH = fileURLToPath(new URL('../assets/icon.png', import.meta.url))
const BASE = 'http://127.0.0.1'

function sendJson (res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

async function parseJsonBody (req, maxBytes = 256 * 1024) {
  const contentLength = req.headers?.['content-length']
  if (contentLength !== undefined) {
    const length = Number(contentLength)
    if (!Number.isSafeInteger(length) || length < 0) throw new Error('请求体长度无效')
    if (length > maxBytes) throw new Error('请求体过大')
  }
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('请求体必须是 JSON 对象')
  }
  return parsed
}

function safeGet (ctx, name) {
  try {
    return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

function pushMethod (res, method) {
  res.writeHead(405, { Allow: method, 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('Method Not Allowed')
}

export function registerRoutes ({ webServer, configStore, ctx }) {
  const disposers = []

  // configure: 读 / 写面板配置
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/oha-whale-compress/configure',
    async handler (req, res) {
      if (req.method === 'GET') {
        try {
          const config = await configStore.get()
          sendJson(res, 200, { ok: true, config })
        } catch (e) {
          sendJson(res, 500, { ok: false, error: e && e.message ? e.message : '读取配置失败' })
        }
        return
      }
      if (req.method === 'POST') {
        try {
          const body = await parseJsonBody(req)
          const patch = {}
          if (typeof body.provider === 'string') patch.provider = body.provider
          if (typeof body.model === 'string') patch.model = body.model
          if (typeof body.keepN === 'number' && Number.isFinite(body.keepN)) patch.keepN = body.keepN
          const config = await configStore.save(patch)
          sendJson(res, 200, { ok: true, config })
        } catch (e) {
          sendJson(res, 400, { ok: false, error: e && e.message ? e.message : '保存配置失败' })
        }
        return
      }
      pushMethod(res, 'GET, POST')
    }
  }, 'dsh-oha-whale-compress: configure route'))

  // status: 当前会话大小（节点数 / 估算 token 数），非破坏性
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/oha-whale-compress/status',
    async handler (req, res) {
      if (req.method !== 'GET') { pushMethod(res, 'GET'); return }
      const sessionId = new URL(req.url ?? '/', BASE).searchParams.get('sessionId')
      if (!sessionId) { sendJson(res, 400, { ok: false, error: '缺少 sessionId 参数' }); return }

      const agents = safeGet(ctx, 'agents')
      const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
      if (!agent) { sendJson(res, 404, { ok: false, error: '会话不存在' }); return }

      let nodeCount
      let totalTokens
      const tokenMeter = safeGet(ctx, 'tokenMeter')
      if (tokenMeter && typeof tokenMeter.measure === 'function') {
        try {
          const m = tokenMeter.measure(agent.session)
          const n = m && m.nodes
          nodeCount = n ? (Array.isArray(n) ? n.length : n.size) : undefined
          totalTokens = m && typeof m.totalTokens === 'number' ? m.totalTokens : undefined
        } catch {
          /* 忽略 measure 失败 */
        }
      }
      if (nodeCount === undefined) {
        const surf = agent.session && agent.session.surface && agent.session.surface.nodes
        nodeCount = surf ? (Array.isArray(surf) ? surf.length : surf.size) : 0
      }
      sendJson(res, 200, { ok: true, sessionId, nodes: nodeCount ?? 0, totalTokens: totalTokens ?? 0 })
    }
  }, 'dsh-oha-whale-compress: status route'))

  // compress: 触发 /compact（核心链路，走框架 commands，不直写会话）
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/oha-whale-compress/compress',
    async handler (req, res) {
      if (req.method !== 'POST') { pushMethod(res, 'POST'); return }
      let sessionId = ''
      try {
        const body = await parseJsonBody(req)
        sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e && e.message ? e.message : '请求体无效' })
        return
      }
      if (!sessionId) { sendJson(res, 400, { ok: false, error: '缺少 sessionId' }); return }

      const agents = safeGet(ctx, 'agents')
      if (!agents) { sendJson(res, 503, { ok: false, error: 'agents 服务不可用' }); return }
      const agent = typeof agents.get === 'function' ? agents.get(sessionId) : undefined
      if (!agent) { sendJson(res, 404, { ok: false, error: '会话不存在' }); return }

      const commands = safeGet(ctx, 'commands')
      if (!commands) { sendJson(res, 503, { ok: false, error: 'commands 服务不可用' }); return }

      try {
        // /compact 是无参命令；commands.execute 内部会读 signal.aborted，必须传真实 AbortSignal，
        // 否则抛 "Cannot read properties of undefined (reading 'aborted')"。客户端断开时取消。
        const controller = new AbortController()
        req.on('close', () => { controller.abort() })
        const exec = await commands.execute(agent, '/compact', [], controller.signal)
        const kind = exec && exec.result ? exec.result.kind : undefined
        const text = exec && exec.result ? exec.result.text : ''
        if (kind === 'success') {
          sendJson(res, 200, { ok: true, message: text || '压缩完成' })
        } else {
          sendJson(res, 400, { ok: false, error: text || '压缩失败' })
        }
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e && e.message ? e.message : '压缩异常' })
      }
    }
  }, 'dsh-oha-whale-compress: compress route'))

  // icon
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/oha-whale-compress/icon',
    async handler (req, res) {
      try {
        const buf = await readFile(ICON_PATH)
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' })
        res.end(buf)
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('icon not found')
      }
    }
  }, 'dsh-oha-whale-compress: icon route'))

  return disposers
}
