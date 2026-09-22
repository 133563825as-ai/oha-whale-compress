# 输入框下方 dock 分层 + 面板层级修复（交接文档）

- 日期：2026-09-22
- 宿主：`@deepseek-ai/dsh` **0.1.6-alpha.2**
- 触发原因：宿主升级后，输入框下方一栏的三个来源（官方统计、余额插件、本插件压缩按钮）互相重叠错位；插件面板被手机端侧边栏盖住。
- 状态：已实施并语法校验；真机视觉回归已由作者直接确认通过（2026-09-22，见 §5）。

---

## 1. 环境与文件位置

| 对象 | 路径 | 安装方式 |
|---|---|---|
| 宿主 | `/usr/local/lib/node_modules/@deepseek-ai/dsh` | npm 全局 |
| 本插件 | `/root/dsha-oha-whale-compress` | `link:` 进 profile |
| 会话管理 | `/root/dsha-session-manager` | `link:` 进 profile |
| 余额插件 | `/root/.dsh/profiles/web/node_modules/dsh-api-dashboard` | npm `^1.4.4` |
| 手机壳 | `/root/dsha-web-mobile` | `link:` 进 profile |

profile 配置：`/root/.dsh/profiles/web/package.json`。

---

## 2. 宿主这一层的真实结构（本次结论的核心）

### 2.1 dock 的 DOM

```jsx
<div className={InputBar_module.dock}>            // uV2eYG_dock
  {renderSlot("conversation.composer.dock", {})}   // slot 内容
  <ContextMeter />                                 // 上下文指示器
</div>
```

`renderSlot` 渲染出的 `SlotOutlet` 是：

```jsx
<div data-slot="conversation.composer.dock" style={{display:"contents"}} />
```

`display:contents` 意味着这层 div **不生成盒子**，它里面的注册者（官方 `stats`、余额条、压缩按钮）在布局上直接是 `.dock` 的 flex 项。这是本次选择器策略的依据：**用 `data-slot` 而不是哈希类名**。

### 2.2 dock 的 CSS

```css
.uV2eYG_dock{justify-content:center;align-items:center;gap:12px;max-width:100%;padding-top:4px;display:flex}
```

单行、居中、**不换行**。

### 2.3 dock 里的注册者

| 注册者 | order | 备注 |
|---|---|---|
| 官方 `stats`（StatsPills） | 0 | `dsh-client-ui-chat` 注册 |
| 余额条 `dshadb_barwrap` | — | `dsh-api-dashboard` 注册 |
| 压缩按钮 | 6 | 本插件注册 |

### 2.4 官方如何把上下文指示器留在同一行

`StatsPills` 自带收缩语义：

```css
.bOPqQW_root{box-sizing:border-box;min-width:0;max-width:100%;...display:flex}
.bOPqQW_label{text-overflow:ellipsis;min-width:0;overflow:hidden}
.JObwrW_root{flex:none;display:inline-flex}   /* ContextMeter，固定宽小件 */
```

空间不足时，官方靠**压缩 StatsPills 并省略其文字**保住这一行。**这是理解全部问题的钥匙**。

---

## 3. 根因

### 根因 A：多个 auto margin 在单行里互抢

- 压缩按钮旧版写 `.wcomp-dock{margin-left:auto}`（意图"靠右"）
- 余额条写 `.dshadb_barwrap{margin:0 auto}`（意图"居中"）
- 还有官方的 `justify-content:center`

flex 中 auto margin 会吸收剩余空间、并让 `justify-content` 失效。窄屏剩余空间为负时所有 auto 归零，元素被迫紧密排列，但内容都是 `white-space:nowrap`，被压到内容宽以下就**溢出**，视觉上互相压盖。现象：压缩按钮盖住余额条文字。

### 根因 B：面板的层叠上下文被锁死在 20

`shell.overlay` 的宿主是 AppFrame 里带标记的层：

```css
.pI_x6G_overlayLayer{z-index:20;pointer-events:none;position:absolute;inset:0}
```

```jsx
<div className={AppFrame_module.overlayLayer} data-shell-overlay={true}>{overlays}</div>
```

`z-index:20` 且 `position:absolute` → **建立层叠上下文**，内部插件面板的 `z-index:1000` / `99999` 只在内部排序，对外始终是 20。

而手机壳 `dsh-web-mobile` 把侧边栏列改成了左侧抽屉：

```css
[data-mobile-nav="frame"] > :first-child { z-index: 1300 !important; transform: translateX(-110%); }
```

1300 > 20 → 面板永远在侧边栏抽屉下面。

**旁证**：`dsh-web-mobile` 自己就为同类问题打过补丁，注释里留了实测记录（`dsh-usage-stats` 面板 z100 被抽屉 z1300 压住，390px 下只剩右侧 98px 可点），解法是把它抬到 1400。会话管理插件先前也写了 `[data-shell-overlay]{z-index:100!important}`，但 100 同样够不到 1300。

### 根因 C：pointer-events 继承

`overlayLayer` 是 `pointer-events:none`（为了不遮挡交互）。插件面板必须自己声明 `pointer-events:auto` 才能收事件。压缩会话的 `.wcomp-backdrop` 当时没有这条。

### 根因 D：本次修复过程中我自己引入的错误

第一版方案给 dock 加 `flex-wrap:wrap` 以消除重叠，但**只解决了重叠、没管顺序**：一旦 wrap 生效，flex 不再压缩元素，`StatsPills` 撑满整行不缩，上下文指示器被判定放不下而换行，落到了压缩按钮旁边。第二版补 `order` 仍未解决，因为 `order` 只改顺序、不改变"放不下就换行"的判定。

最终解法是把官方那条压缩链恢复，只让插件元素占整行（见 §4）。

---

## 4. 改动清单

### 4.1 `/root/dsha-oha-whale-compress/client/client.js`

组件改动一处：`DockButton` 外包一层 `<div className="wcomp-dock-row">`。

原因：按钮若直接做 dock 的子项，会跟随宿主的 `justify-content:center` 停在中间；包一层整行容器后，由容器用 `justify-content:flex-end` 推到右下角——即原设计（README §功能："输入框下方常驻「压缩」按钮（右侧、与余额条对齐）"）。

样式改动：

| 目标 | 改动 | 原因 |
|---|---|---|
| `.wcomp-dock` | 删 `margin-left:auto`，加 `flex:0 0 auto` | 根因 A |
| `.wcomp-backdrop` | 加 `pointer-events:auto;touch-action:none` | 根因 C |
| CSS 数组末尾 | 新增下列 6 条 | 见下 |

```css
/* 面板层级：越过手机壳侧边栏抽屉(1300)与遮罩(1250) */
[data-shell-overlay]{z-index:1400!important}

/* dock 允许换行，插件元素才能各占一层 */
div:has(> [data-slot="conversation.composer.dock"]){flex-wrap:wrap;row-gap:6px}

/* 官方那行：恢复可收缩语义，上下文指示器固定宽，两者同行 */
[data-slot="conversation.composer.dock"] > *{flex:1 1 0;min-width:0}
[data-slot="conversation.composer.dock"] + *{order:1;flex:none}

/* 插件各占一层：余额条居中，压缩按钮右下角 */
.dshadb_barwrap{order:2;flex:0 0 100%}
.wcomp-dock-row{order:3;flex:0 0 100%;display:flex;justify-content:flex-end}
```

定序推演（order）：StatsPills 0 → 上下文指示器 1 → 余额条 2 → 压缩行 3。

第一行能成立的原因：槽内容 `flex:1 1 0` 把 flex-basis 归零，与固定宽的上下文指示器之和小于容器，于是同处一行，剩余空间再回填给 StatsPills。后两条 `flex-basis:100%` 强制各自换行。

### 4.2 `/root/dsha-session-manager/client/client.js`

一处：`[data-shell-overlay]{z-index:100!important}` → `1400!important`。

该插件本来就写了这条规则，只是数值够不到手机壳的 1300。

### 4.3 未改动

`dsh-api-dashboard` **一行未改**。它装在 `node_modules` 里、按 `^1.4.4` 语义化范围安装，改它会在重装时丢失。它的重叠与分层统一由 §4.1 的 dock 规则从外部约束 —— `.dshadb_barwrap{order:2;flex:0 0 100%}` 就是**跨插件覆盖**，属权宜手段，见 §6 风险。

---

## 5. 验证与回滚

**已做**：`node --check` 两个文件均通过。

**已完成**：真机视觉回归。作者在真机上直接查看，dock 三层分层与面板层级均表现正常，判定无需截图存档（2026-09-22 确认）。

**生效方式**：客户端插件改动只需刷新页面。改 host 侧（`src/*`）才需要重启 DSH。

**回滚**：

```sh
cp /root/dsha-oha-whale-compress/client/client.js.bak-1790078454363 \
   /root/dsha-oha-whale-compress/client/client.js
cp /root/dsha-session-manager/client/client.js.bak-1790078454363 \
   /root/dsha-session-manager/client/client.js
```

（`dsh-api-dashboard` 的备份 `client.js.bak-1790078454363` 存在但未使用，可直接删。）

---

## 6. 风险与维护提示

| 风险 | 说明 | 触发时的动作 |
|---|---|---|
| **z-index 数字耦合** | 我们的 1400 是对着 `dsh-web-mobile` 的抽屉 1300 / 遮罩 1250 定的 | 手机壳若改这两个数，同步调整 1400 |
| **跨插件类名覆盖** | `.dshadb_barwrap` 是余额插件的字面类名（非哈希，相对稳定，但仍可能改） | 余额插件升版后若分层失效，检查该类名 |
| **slot 契约依赖** | 全部选择器走 `data-slot="conversation.composer.dock"` 与 `data-shell-overlay`，二者是宿主对外契约属性 | 宿主大版本升级后优先复核这两处 |
| **StatsPills 收缩** | 恢复官方压缩链后，轮数那组会比之前窄约 60px，按官方语义走 pill 内省略号 | 若要求轮数完整显示，需改取舍：让上下文指示器单独落一行 |
| **无截图基线** | 修复效果已由作者真机确认正常，但没有留下截图证据 | 此区域日后若再出回归，先补一张基线截图再动手 |
| **余额插件未从源码适配** | 外部约束而非内部修复 | 若要长期稳定，应把 `dsh-api-dashboard` 也改为 `link:` 本地目录并直接在源码里适配 |

---

## 7. 证据索引

| 结论 | 位置 |
|---|---|
| dock 结构与 `display:contents` 包裹 | `dsh-client-ui-renderer/lib/client.js`（`SlotOutlet`、`ANCHOR_STYLE`） |
| dock CSS | `dsh-client-ui-conversation/lib/client.js`（`InputBar.module.css`） |
| `[slot, ContextMeter]` 的渲染顺序 | `dsh-client-ui-conversation/lib/client.js`（`InputBar`） |
| 官方 `stats` 注册（order 0） | `dsh-client-ui-chat/lib/client.js` |
| StatsPills 收缩语义 | `dsh-client-ui-chat/lib/client.js`（`StatsPills.module.css`） |
| ContextMeter 为固定宽小件 | `dsh-client-ui-conversation/lib/client.js`（`ContextMeter.module.css`） |
| overlay 宿主层 z-index:20 | `dsh-client-ui-layout/lib/client.js`（`AppFrame.module.css`、`AppFrame`） |
| 手机端抽屉 z-index:1300 | `dsh-web-mobile/lib/client.js` |
| usage-stats 同类案例与 1400 解法 | `dsh-web-mobile/lib/client.js`（注释块，实测 2026-09-20） |
