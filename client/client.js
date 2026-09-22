window.__ModuleLoader__.load({
  id: 'dsh-oha-whale-compress',
  factory: (require) => {
    const react = require('react')

    const NS = 'dsh-oha-whale-compress'
    const CONFIGURE_URL = '/oha-whale-compress/configure'
    const STATUS_URL = '/oha-whale-compress/status'
    const COMPRESS_URL = '/oha-whale-compress/compress'
    const ICON_URL = '/oha-whale-compress/icon'

    const zh = {
      dialogTitle: '压缩会话',
      centerTitle: '压缩会话',
      close: '关闭',
      sidebarTitle: '哦鲸鲸',
      sidebarSub: '压缩会话',
      sidebarAria: '打开压缩会话',
      currentSession: '当前会话',
      noSession: '未打开会话',
      nodeCount: '{n} 条记录',
      tokenCount: '约 {n} tokens',
      keepN: '保留最新 N 条',
      customKeep: '自定义',
      compressApi: '压缩用 API',
      blankModel: '默认（会话当前模型）',
      providerLabel: 'Provider',
      modelLabel: 'Model',
      saveConfig: '保存配置',
      configSaved: '已保存',
      configHint: '保留条数与压缩模型已保存为面板配置。当前压缩走 /compact 引擎默认策略。',
      compressNow: '压缩当前会话',
      compressing: '压缩中...',
      compressOk: '压缩完成',
      compressErr: '压缩失败',
      resultLabel: '压缩结果',
      noResult: '还未压缩',
      noModel: '没有可用的模型',
      loadFail: '读取会话状态失败'
    }

    const en = {
      dialogTitle: 'Compress Session',
      centerTitle: 'Compress Session',
      close: 'Close',
      sidebarTitle: '哦鲸鲸',
      sidebarSub: 'Compress',
      sidebarAria: 'Open compress session',
      currentSession: 'Current Session',
      noSession: 'No session open',
      nodeCount: '{n} records',
      tokenCount: 'about {n} tokens',
      keepN: 'Keep latest N',
      customKeep: 'Custom',
      compressApi: 'Compress API',
      blankModel: 'Default (current model)',
      providerLabel: 'Provider',
      modelLabel: 'Model',
      saveConfig: 'Save config',
      configSaved: 'Saved',
      configHint: 'KeepN and compress model are saved panel config. Compression uses /compact engine defaults.',
      compressNow: 'Compress now',
      compressing: 'Compressing...',
      compressOk: 'Compressed',
      compressErr: 'Compress failed',
      resultLabel: 'Result',
      noResult: 'Not compressed yet',
      noModel: 'No models available',
      loadFail: 'Failed to read session status'
    }

    /* --- store: modal open + mode (full | center) --- */
    const listeners = new Set()
    let state = { open: false, mode: 'full' }
    let historyCreated = false

    function subscribe (listener) { listeners.add(listener); return () => listeners.delete(listener) }
    function getSnapshot () { return state }
    function setState (next) { state = next; for (const fn of listeners) fn() }

    function openModal (mode) {
      historyCreated = true
      history.pushState({ dshWhaleCompress: true }, '')
      setState({ open: true, mode: mode || 'full' })
    }
    function closeModal () {
      if (!state.open) return
      if (historyCreated) { historyCreated = false; history.back() }
      setState({ open: false, mode: 'full' })
    }

    async function fetchJson (path, init = {}) {
      const res = await fetch(path, {
        ...init,
        headers: { ...(init.headers || {}), 'Content-Type': 'application/json; charset=utf-8' }
      })
      let data
      try { data = await res.json() } catch { throw new Error('Invalid response') }
      if (!res.ok || !data.ok) throw new Error((data && data.error) || 'Operation failed')
      return data
    }

    /* --- i18n --- */
    function makeT (propsT) {
      const tr = typeof propsT === 'function'
        ? propsT
        : (key, params) => {
            const value = zh[key] ?? en[key] ?? key
            if (!params) return value
            return String(value).replace(/\{(\w+)\}/g, (_, name) => params[name] ?? '')
          }
      return new Proxy(tr, {
        get: (target, key) => (typeof key === 'string' ? tr(key) : target[key])
      })
    }

    /* --- small select (provider / model) --- */
    function Select (props) {
      const [open, setOpen] = react.useState(false)
      const ref = react.useRef(null)
      const value = props.value
      const options = props.options || []
      const current = options.find((o) => o.id === value)
      react.useEffect(() => {
        if (!open) return
        const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
        document.addEventListener('click', onDoc)
        return () => document.removeEventListener('click', onDoc)
      }, [open])
      return react.createElement('div', { className: 'wcomp-select-wrap', ref },
        react.createElement('button', {
          className: 'wcomp-select',
          onClick: (e) => { e.stopPropagation(); setOpen(!open) }
        },
          react.createElement('span', { className: 'wcomp-select-value' }, current ? current.label : ''),
          react.createElement('span', { className: 'wcomp-select-arrow' }, '\u25be')
        ),
        open ? react.createElement('div', { className: 'wcomp-select-menu' },
          options.map((o) => react.createElement('button', {
            key: o.id,
            className: o.id === value ? 'wcomp-option wcomp-option-on' : 'wcomp-option',
            onClick: (e) => { e.stopPropagation(); props.onChange(o.id); setOpen(false) }
          }, o.label))
        ) : null
      )
    }

    /* --- icons --- */
    const IconClose = react.createElement('svg', { viewBox: '0 0 24 24', width: '12', height: '12', 'aria-hidden': 'true' },
      react.createElement('path', { d: 'M18 6L6 18M6 6l12 12', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', fill: 'none' }))
    const IconCompress = react.createElement('svg', { viewBox: '0 0 24 24', width: '1em', height: '1em', 'aria-hidden': 'true' },
      react.createElement('path', { d: 'M4 14h6v6M20 10h-6V4M4 10h4M20 14h-4', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' }))

    /* --- sidebar button (match session-manager sm-action look) --- */
    function SidebarAction (props) {
      const t = makeT(props.t)
      const wide = props.wide !== false
      const [imgFailed, setImgFailed] = react.useState(false)
      const logo = imgFailed
        ? IconCompress
        : react.createElement('img', { src: ICON_URL, className: 'sm-action-logo', alt: '', onError: () => setImgFailed(true) })
      const content = wide
        ? react.createElement('span', { className: 'sm-action-content' },
            logo,
            react.createElement('span', { className: 'sm-action-text' },
              react.createElement('span', { className: 'sm-action-title' }, t.sidebarTitle),
              react.createElement('span', { className: 'sm-action-sub' }, t.sidebarSub)
            )
          )
        : logo
      return react.createElement('div', { className: 'sm-action-wrap' },
        react.createElement('button', {
          className: 'sm-action',
          'aria-label': t.sidebarAria,
          title: t.sidebarSub,
          onClick: () => openModal('full')
        }, content)
      )
    }

    /* --- dock button (composer.dock, right-aligned) --- */
    // 原设计是「输入框下方右下角」常驻按钮。宿主 dock 是单行居中 flex，按钮若直接做
    // dock 的子项只会被摆到中间，所以包一层整行容器，由容器把它推到右下角。
    function DockButton (props) {
      const t = makeT(props.t)
      const [imgFailed, setImgFailed] = react.useState(false)
      const logo = imgFailed
        ? IconCompress
        : react.createElement('img', { src: ICON_URL, alt: '', onError: () => setImgFailed(true) })
      return react.createElement('div', { className: 'wcomp-dock-row' },
        react.createElement('button', {
          className: 'wcomp-dock',
          title: t.sidebarSub,
          'aria-label': t.sidebarAria,
          onClick: (e) => { e.stopPropagation(); openModal('full') }
        },
          logo,
          react.createElement('span', { className: 'wcomp-dock-text' }, t.sidebarSub)
        )
      )
    }

    /* --- keepN segmented --- */
    const KEEP_PRESETS = [100, 500, 1000, 2000]
    function SegmentedKeepN (props) {
      const value = props.value
      const onChange = props.onChange
      const usedPreset = KEEP_PRESETS.indexOf(value) !== -1
      const [custom, setCustom] = react.useState(usedPreset ? '' : String(value))
      react.useEffect(() => {
        if (usedPreset) setCustom('')
      }, [usedPreset])
      return react.createElement('div', { className: 'wcomp-seg' },
        KEEP_PRESETS.map((n) => react.createElement('button', {
          key: n,
          className: value === n ? 'wcomp-seg-btn wcomp-seg-on' : 'wcomp-seg-btn',
          onClick: (e) => { e.stopPropagation(); onChange(n) }
        }, String(n))),
        react.createElement('div', { className: 'wcomp-seg-custom' },
          react.createElement('input', {
            className: 'wcomp-seg-input',
            type: 'number',
            inputMode: 'numeric',
            min: '1',
            placeholder: zh.customKeep,
            value: custom,
            onChange: (e) => { setCustom(e.target.value); const v = Number(e.target.value); if (v > 0 && Number.isFinite(v)) onChange(v) }
          }),
          react.createElement('span', { className: 'wcomp-seg-unit' }, '条')
        )
      )
    }

    /* --- panel body (full | center) --- */
    function PanelBody (props) {
      const t = makeT(props.t)
      const full = props.full
      const useSessions = props.useSessions
      const modelDirectories = props.modelDirectories
      const current = useSessions ? useSessions((s) => s.current) : undefined

      const [status, setStatus] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [result, setResult] = react.useState(null)
      const [keepN, setKeepN] = react.useState(1000)
      const [provider, setProvider] = react.useState('')
      const [model, setModel] = react.useState('')
      const [groups, setGroups] = react.useState([])
      const [savedFlash, setSavedFlash] = react.useState(false)

      const loadStatus = react.useCallback(async () => {
        if (!current) { setStatus(null); return }
        try {
          const d = await fetchJson(STATUS_URL + '?sessionId=' + encodeURIComponent(current))
          setStatus(d)
        } catch (e) {
          setStatus({ ok: false })
        }
      }, [current])

      const loadConfig = react.useCallback(async () => {
        try {
          const d = await fetchJson(CONFIGURE_URL)
          const c = d.config || {}
          if (typeof c.keepN === 'number' && c.keepN > 0) setKeepN(c.keepN)
          if (typeof c.provider === 'string') setProvider(c.provider)
          if (typeof c.model === 'string') setModel(c.model)
        } catch {
          /* 忽略 */
        }
      }, [])

      react.useEffect(() => {
        loadStatus()
        loadConfig()
      }, [loadStatus, loadConfig])

      // 加载已配置模型目录（按 provider 分组）
      react.useEffect(() => {
        if (!modelDirectories || !current) { setGroups([]); return }
        let alive = true
        modelDirectories.directoryFor(current).load()
          .then((dir) => { if (alive) setGroups(dir && dir.groups ? dir.groups : []) })
          .catch(() => { if (alive) setGroups([]) })
        return () => { alive = false }
      }, [modelDirectories, current])

      react.useEffect(() => {
        const id = current
        if (!id || !full) return
        const timer = setInterval(() => { fetchJson(STATUS_URL + '?sessionId=' + encodeURIComponent(id)).then(setStatus).catch(() => {}) }, 15000)
        return () => clearInterval(timer)
      }, [current, full])

      const doCompress = async () => {
        if (!current || busy) return
        setBusy(true)
        setResult(null)
        try {
          const data = await fetchJson(COMPRESS_URL, { method: 'POST', body: JSON.stringify({ sessionId: current }) })
          setResult({ kind: 'ok', text: data.message || '' })
          loadStatus()
        } catch (e) {
          setResult({ kind: 'err', text: e.message || '压缩失败' })
        } finally {
          setBusy(false)
        }
      }

      const saveConfig = async () => {
        try {
          await fetchJson(CONFIGURE_URL, { method: 'POST', body: JSON.stringify({ keepN, provider, model }) })
          setSavedFlash(true)
          setTimeout(() => setSavedFlash(false), 1600)
        } catch {
          /* 忽略 */
        }
      }

      const providerGroup = groups.find((g) => g.id === provider)
      const providerOptions = [{ id: '', label: t.blankModel }].concat(groups.map((g) => ({ id: g.id, label: g.id })))
      const modelOptions = [{ id: '', label: t.blankModel }].concat((providerGroup ? providerGroup.models : []).map((m) => ({ id: m.id, label: m.name || m.id })))

      const statusLine = status
        ? (status.ok === false
            ? react.createElement('span', { className: 'wcomp-muted' }, t.loadFail)
            : react.createElement('span', { className: 'wcomp-muted' },
                t.nodeCount.replace('{n}', String(status.nodes || 0)),
                ' · ',
                t.tokenCount.replace('{n}', String(status.totalTokens || 0))
              ))
        : react.createElement('span', { className: 'wcomp-muted' }, t.noSession)

      const resultBlock = result
        ? react.createElement('div', { className: result.kind === 'ok' ? 'wcomp-result wcomp-result-ok' : 'wcomp-result wcomp-result-err' },
            react.createElement('span', { className: 'wcomp-result-title' }, result.kind === 'ok' ? t.compressOk : t.compressErr),
            result.text ? react.createElement('pre', { className: 'wcomp-result-pre' }, result.text) : null
          )
        : react.createElement('div', { className: 'wcomp-result wcomp-result-muted' }, t.noResult)

      const elements = []
      elements.push(react.createElement('div', { className: 'wcomp-row', key: 'session' },
        react.createElement('span', { className: 'wcomp-label' }, t.currentSession),
        statusLine))

      if (full) {
        elements.push(react.createElement('div', { className: 'wcomp-field', key: 'keep' },
          react.createElement('div', { className: 'wcomp-label' }, t.keepN),
          react.createElement(SegmentedKeepN, { value: keepN, onChange: setKeepN })))
        elements.push(react.createElement('div', { className: 'wcomp-field', key: 'api' },
          react.createElement('div', { className: 'wcomp-label' }, t.compressApi),
          react.createElement('div', { className: 'wcomp-selects' },
            react.createElement(Select, { value: provider, options: providerOptions, onChange: (v) => { setProvider(v); setModel('') } }),
            react.createElement(Select, { value: model, options: modelOptions, onChange: setModel }))))
        elements.push(react.createElement('div', { className: 'wcomp-field', key: 'cfg' },
          react.createElement('button', { className: 'wcomp-ghost', onClick: saveConfig },
            savedFlash ? t.configSaved : t.saveConfig)))
        elements.push(react.createElement('div', { className: 'wcomp-hint', key: 'hint' }, t.configHint))
      }

      elements.push(react.createElement('button', {
        key: 'btn',
        className: busy ? 'wcomp-primary wcomp-disabled' : 'wcomp-primary',
        disabled: busy || !current,
        onClick: doCompress
      }, busy ? t.compressing : t.compressNow))

      elements.push(react.createElement('div', { className: 'wcomp-status', key: 'st' },
        react.createElement('span', { className: 'wcomp-label' }, t.resultLabel),
        resultBlock))

      return react.createElement('div', { className: 'wcomp-panel-body' }, elements)
    }

    function PanelShell (props) {
      const t = makeT(props.t)
      const full = props.full
      const onClose = props.onClose
      const [imgFailed, setImgFailed] = react.useState(false)
      const logo = imgFailed
        ? IconCompress
        : react.createElement('img', { src: ICON_URL, alt: '', onError: () => setImgFailed(true) })
      return react.createElement('div', { className: 'wcomp-backdrop', onClick: (e) => { if (e.target === e.currentTarget) onClose() } },
        react.createElement('div', { className: 'wcomp-card' },
          react.createElement('div', { className: 'wcomp-head' },
            logo,
            react.createElement('span', { className: 'wcomp-head-title' }, full ? t.dialogTitle : t.centerTitle),
            react.createElement('button', { className: 'wcomp-close', 'aria-label': t.close, onClick: onClose }, IconClose)
          ),
          react.createElement(PanelBody, { full, useSessions: props.useSessions, modelDirectories: props.modelDirectories })
        )
      )
    }

    function Overlay (props) {
      const mode = react.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      if (!mode.open) return null
      return react.createElement(PanelShell, { full: mode.mode !== 'full', useSessions: props.useSessions, modelDirectories: props.modelDirectories, onClose: closeModal })
    }

    /* --- CSS: sm-action (copy from session-manager for identical look) + wcomp-* panel --- */
    const CSS = [
      // sidebar button —— 与「会话管理」完全一致的 sm-action 样式
      '.sm-action-wrap{padding:2px}',
      '.sm-action{display:inline-flex;align-items:center;gap:.5rem;padding:.375rem .65rem;border:1px solid var(--dsw-alias-border-l2,#e7e8ec);background:var(--dsw-alias-button-elevated-fill,#fff);color:var(--dsw-alias-label-primary,#17181c);border-radius:10px;cursor:pointer;font:inherit;width:100%;min-width:0;min-height:36px;transition:background .12s ease,box-shadow .2s ease}',
      '.sm-action:hover{background:var(--dsw-alias-button-floating-hover,#f5f6f8);box-shadow:0 2px 8px rgba(0,0,0,.06)}',
      '.sm-action:active{transform:scale(.985);opacity:.9}',
      '.sm-action svg{flex:none;font-size:1.125rem}',
      '.sm-action-content{display:inline-flex;align-items:center;gap:.5rem;min-width:0;flex:1}',
      '.sm-action-logo{width:20px;height:20px;border-radius:6px;object-fit:contain;flex:none}',
      '.sm-action-text{display:flex;flex-direction:column;align-items:flex-start;min-width:0;line-height:1.15}',
      '.sm-action-title{font-size:13px;font-weight:700;color:var(--dsw-alias-label-primary,#17181c);white-space:nowrap}',
      '.sm-action-sub{font-size:10px;color:var(--dsw-alias-label-secondary,#777b84);white-space:nowrap}',

      // composer dock 常驻按钮（靠右）
      // 0.1.6 的 dock 是居中的 flex 行；margin-left:auto 会和余额条的 margin:auto 互抢空间，
      // 把兄弟元素挤到溢出重叠，所以改为不参与伸缩的普通项。
      '.wcomp-dock{display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:4px 10px 4px 6px;border-radius:10px;background:var(--dsw-alias-button-elevated-fill,#f5f6f8);border:1px solid var(--dsw-alias-border-l2,#e7e8ec);color:#4f7cff;cursor:pointer;white-space:nowrap;flex:0 0 auto;user-select:none;-webkit-tap-highlight-color:transparent}',
      '.wcomp-dock:active{opacity:.8}',
      '.wcomp-dock img{width:16px;height:16px;border-radius:5px;background:#eef2ff;padding:1px}',
      '.wcomp-dock-text{font-weight:700;color:var(--dsw-alias-label-primary,#17181c);font-size:11px}',

      // 居中弹窗（与交接文档一致：居中、宽 min(92vw,420px)、圆角 20px、遮罩 rgba(0,0,0,.35)）
      // shell.overlay 宿主层带 pointer-events:none，面板必须自己收回点击权，否则只有第一个面板可关闭。
      '.wcomp-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px;pointer-events:auto;touch-action:none}',
      '.wcomp-card{background:var(--dsw-alias-surface,#fff);border-radius:20px;width:min(92vw,420px);max-height:min(80vh,560px);overflow:auto;box-shadow:0 20px 48px rgba(0,0,0,.22);border:1px solid var(--dsw-alias-border-l2,#e7e8ec)}',
      '.wcomp-head{display:flex;align-items:center;gap:8px;padding:16px 16px 10px}',
      '.wcomp-head img{width:22px;height:22px;border-radius:6px;background:#eef2ff;padding:2px}',
      '.wcomp-head-title{font-size:15px;font-weight:800;color:var(--dsw-alias-label-primary,#17181c);flex:1}',
      '.wcomp-close{width:28px;height:28px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#9ca0aa);cursor:pointer;border-radius:8px;display:flex;align-items:center;justify-content:center}',
      '.wcomp-close:active{background:var(--dsw-alias-button-floating-hover,#f0f1f3)}',

      '.wcomp-panel-body{padding:4px 16px 20px;display:flex;flex-direction:column;gap:14px}',
      '.wcomp-row{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.wcomp-label{font-size:12px;color:var(--dsw-alias-label-secondary,#9ca0aa);font-weight:700}',
      '.wcomp-muted{font-size:12px;color:var(--dsw-alias-label-tertiary,#6b6f78)}',
      '.wcomp-field{display:flex;flex-direction:column;gap:6px}',
      '.wcomp-seg{display:flex;flex-wrap:wrap;gap:6px;align-items:center}',
      '.wcomp-seg-btn{font-size:12px;padding:5px 11px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#e7e8ec);background:var(--dsw-alias-button-floating-hover,#f5f6f8);color:var(--dsw-alias-label-tertiary,#6b6f78);cursor:pointer}',
      '.wcomp-seg-on{background:#4f7cff;border-color:#4f7cff;color:#fff}',
      '.wcomp-seg-custom{display:inline-flex;align-items:center;gap:4px}',
      '.wcomp-seg-input{width:64px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,#e7e8ec);border-radius:999px;padding:5px 10px;font-size:12px;background:var(--dsw-alias-surface,#fff);color:var(--dsw-alias-label-primary,#17181c)}',
      '.wcomp-seg-unit{font-size:11px;color:var(--dsw-alias-label-secondary,#9ca0aa)}',
      '.wcomp-selects{display:flex;gap:8px}',
      '.wcomp-select-wrap{display:flex;align-items:center;background:var(--dsw-alias-button-floating-hover,#f5f6f8);border:1px solid var(--dsw-alias-border-l2,#e7e8ec);border-radius:10px;padding:0 4px;flex:1;position:relative;min-width:0}',
      '.wcomp-select{display:flex;align-items:center;justify-content:space-between;gap:6px;width:100%;border:0;background:transparent;padding:8px;font-size:12px;color:var(--dsw-alias-label-primary,#17181c);cursor:pointer;white-space:nowrap;overflow:hidden}',
      '.wcomp-select-value{overflow:hidden;text-overflow:ellipsis}',
      '.wcomp-select-arrow{color:var(--dsw-alias-label-secondary,#9ca0aa)}',
      '.wcomp-select-menu{position:absolute;left:0;right:0;top:calc(100% + 4px);background:var(--dsw-alias-surface,#fff);border:1px solid var(--dsw-alias-border-l2,#e7e8ec);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.12);z-index:20;overflow:auto;max-height:220px}',
      '.wcomp-option{display:block;width:100%;border:0;background:transparent;text-align:left;padding:8px 12px;font-size:12px;color:var(--dsw-alias-label-primary,#17181c);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.wcomp-option-on{background:rgba(79,124,255,.1);color:#4f7cff;font-weight:700}',
      '.wcomp-ghost{font-size:12px;padding:6px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,#e7e8ec);background:var(--dsw-alias-button-floating-hover,#f5f6f8);color:#4f7cff;cursor:pointer;align-self:flex-start}',
      '.wcomp-hint{font-size:11px;color:var(--dsw-alias-label-secondary,#9ca0aa);line-height:1.5}',
      '.wcomp-primary{width:100%;padding:11px;border:0;border-radius:12px;background:#4f7cff;color:#fff;font-size:14px;font-weight:800;cursor:pointer}',
      '.wcomp-primary:active{transform:scale(.985)}',
      '.wcomp-disabled{opacity:.6;cursor:default}',
      '.wcomp-status{display:flex;flex-direction:column;gap:6px}',
      '.wcomp-result{background:var(--dsw-alias-button-floating-hover,#f8f9fb);border:1px solid var(--dsw-alias-border-l2,#e7e8ec);border-radius:12px;padding:10px}',
      '.wcomp-result-ok{border-color:rgba(53,181,107,.3);background:rgba(53,181,107,.06)}',
      '.wcomp-result-err{border-color:rgba(224,82,82,.3);background:rgba(224,82,82,.06)}',
      '.wcomp-result-muted{color:var(--dsw-alias-label-secondary,#9ca0aa)}',
      '.wcomp-result-title{font-size:12px;font-weight:700;color:var(--dsw-alias-label-primary,#17181c)}',
      '.wcomp-result-ok .wcomp-result-title{color:#2a8f54}',
      '.wcomp-result-err .wcomp-result-title{color:#c0392b}',
      '.wcomp-result-pre{white-space:pre-wrap;word-break:break-word;font-size:12px;color:var(--dsw-alias-label-primary,#17181c);margin:8px 0 0;line-height:1.5;max-height:240px;overflow:auto}',

      // 宿主把 shell.overlay 的宿主层钉在 z-index:20，手机端侧边栏却是 1300 的抽屉，
      // 面板因此被压在侧边栏下面；抬到抽屉(1300)/遮罩(1250)之上。
      '[data-shell-overlay]{z-index:1400!important}',

      // 宿主的 composer dock 是不换行的居中 flex 行，插件元素在窄屏互相压缩后内容溢出重叠，
      // 允许换行。选择器走 slot 契约属性，不依赖会随构建变化的哈希类名。
      'div:has(> [data-slot="conversation.composer.dock"]){flex-wrap:wrap;row-gap:6px}',
      // dock 的直接子只有两个：slot 内容容器(display:contents) 和它后面的上下文指示器。
      // 官方那行：槽内容保持可收缩（StatsPills 本就是 min-width:0 + 文字省略的语义），
      // 上下文指示器保持固定宽度 —— 两者于是能留在同一行，这正是官方原本靠压缩做到的。
      '[data-slot="conversation.composer.dock"] > *{flex:1 1 0;min-width:0}',
      '[data-slot="conversation.composer.dock"] + *{order:1;flex:none}',
      // 插件各自独占一层：余额条居中，压缩按钮右下角。写在通用规则之后以便覆盖它。
      '.dshadb_barwrap{order:2;flex:0 0 100%}',
      '.wcomp-dock-row{order:3;flex:0 0 100%;display:flex;justify-content:flex-end}'
    ].join('\n')

    function injectStyle () {
      if (typeof document === 'undefined') return () => {}
      const existing = document.querySelector('style[data-plugin="dsh-oha-whale-compress"]')
      if (existing) { existing.textContent = CSS; return () => existing.remove() }
      const tag = document.createElement('style')
      tag.setAttribute('data-plugin', 'dsh-oha-whale-compress')
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    const inject = ['slots', 'locale', 'layout', 'modelDirectories']

    function apply (ctx) {
      const removeStyle = injectStyle()
      ctx.effect(() => {
        ctx.locale.register(NS, { zh, en })
        return () => {
          if (ctx.locale.unregister) ctx.locale.unregister(NS)
          removeStyle()
        }
      }, 'dsh-oha-whale-compress: locale')

      ctx.slots.inject('sidebar.footer.action', () => {
        return ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsh-oha-whale-compress', order: 20, locale: NS }, SidebarAction)
      })

      // 待办 B：输入框下方常驻「压缩」按钮（靠右，跟余额条对齐）
      ctx.slots.inject('conversation.composer.dock', () => {
        return ctx.slots.register({ name: 'conversation.composer.dock', id: 'dsh-oha-whale-compress', order: 6, locale: NS }, DockButton)
      })

      ctx.slots.inject('shell.overlay', () => {
        return ctx.slots.register({ name: 'shell.overlay', id: 'dsh-oha-whale-compress', order: 20, locale: NS }, Overlay)
      })
    }

    return { inject, apply }
  }
})
