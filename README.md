# dsh-oha-whale-compress

DeepSeek Harness 专用「压缩会话」插件（哦鲸鲸 family，与 dsh-session-manager 同品牌设计）。

## 功能

- **侧边栏底部入口**（挨着「会话管理」）：点开「压缩会话」面板。
- **完整面板**：保留最新 N 条（100 / 500 / 1000 / 2000 分段，可自定义）· 压缩用 provider / model（留空用会话当前模型）· 自定义压缩提示词 · 一键「压缩当前会话」。
- **输入框下方常驻「压缩」按钮**（右侧、与余额条对齐）：点开减半版面板，只保留基础压缩 + 查看结果（去掉选 API 与自定义提示词）。
- **查看结果**：展示当前会话大小（节点数 / token 数）与本次压缩的状态 / checkpoint 文本。

## 触发链路

```
侧边栏 / 常驻按钮 → POST /oha-whale-compress/compress {sessionId}
  → host 取 agent = ctx.get('agents').get(sessionId)
  → ctx.get('commands').execute(agent, '/compact', [], signal)
  → (command-compact 在压缩 group 里执行 compactNow，真正压缩)
  → 返回 { ok, message }
```

> 压缩必须走框架 `ctx.get('commands').execute(agent, '/compact', ...)`，绝不直写会话日志。

## HTTP 路由

| 路由 | 方法 | 作用 |
|---|---|---|
| `/oha-whale-compress/configure` | GET / POST | 读 / 写面板配置（provider/model/keepN） |
| `/oha-whale-compress/status` | GET | 当前会话大小（`?sessionId=`，nodes/totalTokens），非破坏性 |
| `/oha-whale-compress/compress` | POST | `{sessionId}` → 触发 `/compact` |
| `/oha-whale-compress/icon` | GET | 返回 `assets/icon.png`（image/png，max-age=3600） |

## 安装

```sh
dsh plugin --profile web add dsh-oha-whale-compress
```

或源码方式：`dsh plugin --profile web add file:/root/dsha-oha-whale-compress`。
改 host（src/*）需重启 DSH；改 client（client/client.js）需刷新页面。

## 血泪教训（勿踩）

- 插件**只硬 inject `webServer`**，其余服务一律 `ctx.get()` 运行时懒取，取不到优雅返回（如 503），**绝不阻塞激活**——否则整棵插件树崩，Web 打不开。
- `compaction` 服务是隔离的（压缩 group `isolate`），profile 插件取不到，只能走 `/compact` 命令触发。

## License

MIT
