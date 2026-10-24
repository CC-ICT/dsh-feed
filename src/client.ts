/**
 * dsh-feed — Client 插件入口。
 *
 * 通过 DSH slot 系统注册侧边栏按钮，点击打开全屏 Feed 覆盖层。
 * 使用 sidebar.footer.action slot（DSH 官方 slot），不需要 MutationObserver。
 */
import { createElement as h, useState, useEffect, useSyncExternalStore } from 'react'

export const inject = ['slots', 'remote.settings']

// ── 常量 ──────────────────────────────────────────────────────────────────
const OVERLAY_ATTR = 'data-dsh-feed-overlay'
const CARD_ATTR = 'data-dsh-feed-card'

// ── 设置界面 ─────────────────────────────────────────────────────────────
// 参考 meow-memory：注册 settings.section 槽，组件通过 configForms 读写
// namespace='dsh-feed' 的表单（describe 自动生成的 schema 数据源）。
// 改设置后需重启 DSH 生效（host apply 解析 config，不做静默热生效）。
const SETTINGS_NS = 'dsh-feed'

interface FieldSpec {
  group: string
  key: string
  sub?: string
  label: string
  type: 'text' | 'secret' | 'select' | 'number'
  options?: string[]
}

const FIELDS: FieldSpec[] = [
  { group: '图片生成', key: 'imageProvider', label: 'Provider（jiutian=九天 / wanx=万相）', type: 'select', options: ['jiutian', 'wanx'] },
  { group: '九天 moma', sub: 'jiutian', key: 'baseUrl', label: 'Base URL', type: 'text' },
  { group: '九天 moma', sub: 'jiutian', key: 'apiKey', label: 'API Key', type: 'secret' },
  { group: '九天 moma', sub: 'jiutian', key: 'imageModel', label: '文生图模型', type: 'text' },
  { group: '万相 dashscope', sub: 'wanx', key: 'baseUrl', label: 'Base URL', type: 'text' },
  { group: '万相 dashscope', sub: 'wanx', key: 'apiKey', label: 'API Key', type: 'secret' },
  { group: '万相 dashscope', sub: 'wanx', key: 'imageModel', label: '图片模型', type: 'text' },
  { group: '万相 dashscope', sub: 'wanx', key: 'videoModel', label: '视频模型', type: 'text' },
  { group: 'LLM', sub: 'llm', key: 'provider', label: 'Provider', type: 'text' },
  { group: 'LLM', sub: 'llm', key: 'model', label: 'Model', type: 'text' },
  { group: '定时扫描', sub: 'feed', key: 'scanIntervalMinutes', label: '扫描间隔（分钟，多久读一次 meow-memory）', type: 'number' },
  { group: '定时扫描', sub: 'feed', key: 'maxGeneratePerScan', label: '每次扫描最多生成条数（控成本）', type: 'number' },
  { group: '定时扫描', sub: 'feed', key: 'regenIntervalHours', label: '同一兴趣再生成间隔（小时）', type: 'number' },
]

/** 安全读取可选 client 服务（configForms/settingsScope 可能尚未就绪）。 */
function softService(ctx: any, name: string): any {
  if (typeof ctx?.get === 'function') return ctx.get(name)
  try { return ctx?.[name] } catch { return undefined }
}

function fieldValue(snap: any, spec: FieldSpec): unknown {
  const v = snap?.value
  return spec.sub === undefined ? v?.[spec.key] : v?.[spec.sub]?.[spec.key]
}

function fieldOverridden(snap: any, spec: FieldSpec): boolean {
  const u = snap?.user
  if (spec.sub === undefined) return u != null && spec.key in u
  return u?.[spec.sub] != null && spec.key in u[spec.sub]
}

// 宿主对被拒写入静默、零日志（meow-memory line 299-332 实证坑）。
// probeCtx 保存客户端 ctx，写入失败时直发 remote.settings.mutate 拿服务端
// 拒因 envelope 原样打到 console——configForms 自身只回 false、把错误吞掉。
let probeCtx: any = null

/** 把诊断 POST 到宿主 /dsh-feed/log-probe，宿主原生 console.log 打到终端。
 *  F12 控制台被宿主吞掉时，靠这条通路把拒因打到启动 DSH 的终端。 */
async function logProbe(payload: Record<string, unknown>): Promise<void> {
  try {
    await fetch('/dsh-feed/log-probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch { /* noop */ }
}

async function probeMutationRejection(path: string[], value: unknown): Promise<void> {
  try {
    const remote = softService(probeCtx, 'remote')?.settings
    if (typeof remote?.describe !== 'function' || typeof remote?.mutate !== 'function') {
      console.info('[dsh-feed] probe: remote.settings 不可用', { hasCtx: probeCtx !== null, remoteType: typeof remote })
      await logProbe({ note: 'remote.settings 不可用，无法 probe', remoteType: typeof remote, hasCtx: probeCtx !== null })
      return
    }
    const describe: any = await remote.describe()
    const view = describe?.ok === true ? describe.value : describe
    const ns = view?.namespaces?.find((row: any) => row?.ns === SETTINGS_NS)
    const describeSummary = { nsListed: ns !== undefined, revision: ns?.revision, writable: view?.writable, all: view?.namespaces?.map((row: any) => row?.ns) }
    console.info('[dsh-feed] probe describe:', JSON.stringify(describeSummary))
    await logProbe({ describe: describeSummary })
    if (ns === undefined) { await logProbe({ note: 'namespace dsh-feed 未在 describe 中列出' }); return }
    const response: any = await remote.mutate(SETTINGS_NS, [{ op: 'set', path, value }], ns.revision)
    console.info('[dsh-feed] probe mutate envelope:', JSON.stringify(response))
    await logProbe({ mutateEnvelope: response })
    const err = response?.error
    if (err) { console.info('[dsh-feed] probe mutate error:', err.code, err.message ?? null, err.cause ?? null); await logProbe({ mutateError: err }) }
    if (response?.ok !== true) {
      // 回退：把整条父对象一起 update
      const upd: any = await remote.update(SETTINGS_NS, { [path[0]]: value }, ns.revision)
      console.info('[dsh-feed] probe update envelope:', JSON.stringify(upd))
      await logProbe({ updateEnvelope: upd })
      const uerr = upd?.error
      if (uerr) { console.info('[dsh-feed] probe update error:', uerr.code, uerr.message ?? null, uerr.cause ?? null); await logProbe({ updateError: uerr }) }
    }
  } catch (e: any) {
    const errInfo = {
      name: e?.name, message: e?.message, code: e?.code,
      str: String(e), stack: e?.stack,
    }
    console.info('[dsh-feed] probe threw:', JSON.stringify(errInfo))
    await logProbe({ note: 'probe threw', error: errInfo })
  }
}

/** 注册 dsh-feed 设置区：拿到 configForms 作用域后挂 settings.section。 */
function applySettingsPage(ctx: any): () => void {
  probeCtx = ctx
  const mountWithScope = (scope: any): (() => void) => {
    injectSettingsCss()
    let disposeEntry: (() => void) | null = null
    const registerSection = () => {
      try { disposeEntry?.() } catch { /* noop */ }
      disposeEntry = ctx.slots.register(
        {
          name: 'settings.section',
          id: SETTINGS_NS,
          order: 40,
          label: '个性化推荐',
          inject: () => ({ scope }),
        },
        JtFeedSettingsSection,
      )
    }
    const disposeInjection = ctx.slots.inject('settings.section', registerSection)
    return () => {
      try { disposeInjection() } catch { /* noop */ }
      try { disposeEntry?.() } catch { /* noop */ }
    }
  }

  // 优先 settingsScope（0.1.7+ 形态），否则轮询 configForms.get
  const settingsScope = softService(ctx, 'settingsScope')
  if (settingsScope !== undefined) {
    return mountWithScope(settingsScope.bind({ namespace: SETTINGS_NS }))
  }
  let mountDisposer: (() => void) | null = null
  let pollTimer: ReturnType<typeof setInterval> | undefined
  const stopPoll = () => { if (pollTimer !== undefined) clearInterval(pollTimer) }
  const attach = () => {
    if (mountDisposer !== null) return
    const configForms = softService(ctx, 'configForms')
    if (configForms === undefined || typeof configForms.get !== 'function') return
    mountDisposer = mountWithScope(configForms.get(SETTINGS_NS))
    stopPoll()
  }
  attach()
  if (mountDisposer === null) {
    let attempts = 0
    pollTimer = setInterval(() => {
      attach()
      attempts += 1
      if (mountDisposer === null && attempts >= 75) {
        stopPoll()
        console.info('[dsh-feed] configForms 服务未就绪，设置页未注册（插件其余功能不受影响）')
      }
    }, 400)
  }
  return () => { stopPoll(); if (mountDisposer !== null) mountDisposer() }
}

// scope 未就绪时的桩（满足 React hooks 规则——绝不抛错，渲染走 unavailable 分支）。
const STUB_SCOPE = {
  subscribe: () => () => {},
  getSnapshot: () => ({ status: 'unavailable', value: undefined, base: undefined, user: undefined, writable: false, mode: 'memory' }),
}

function JtFeedSettingsSection({ scope, close }: { scope: any; close: () => void }) {
  // 防御：scope 可能未就绪（configForms.get 返回 undefined 或形状不符）。
  // 用桩代替，hooks 恒定调用、永不抛错——避免 dsh-feed 把整个设置面板带崩。
  const safeScope = scope && typeof scope.subscribe === 'function' && typeof scope.getSnapshot === 'function'
    ? scope : STUB_SCOPE
  if (scope !== safeScope) {
    console.error('[dsh-feed] settings scope 不可用，回退到只读桩', scope)
  }
  const subscribe = (cb: () => void) => safeScope.subscribe(cb)
  const getSnapshot = () => safeScope.getSnapshot()
  let snap: any
  try {
    snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  } catch (e: any) {
    console.error('[dsh-feed] useSyncExternalStore 抛错', e)
    return h('div', { className: 'dsh-feed-settings-error' }, `个性化推荐 设置读取失败：${e?.message ?? String(e)}`)
  }
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [savedAt, setSavedAt] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!savedAt) return
    const t = setTimeout(() => setSavedAt(() => 0), 2500)
    return () => clearTimeout(t)
  }, [savedAt])

  if (snap?.status === 'loading') {
    return h('div', { className: 'dsh-feed-settings-loading' }, '加载设置中…')
  }
  if (snap?.status === 'unavailable' || !snap?.writable) {
    return h('div', { className: 'dsh-feed-settings-readonly' },
      '当前连接为只读镜像或设置服务未就绪，无法修改设置。请在本机 DSH 上配置，或重启 DSH 后再试。')
  }

  const draftKey = (s: FieldSpec) => (s.sub === undefined ? s.key : `${s.sub}.${s.key}`)
  const flashSaved = (): void => { setSavedAt(Date.now()) }
  const clearDraft = (s: FieldSpec): void => {
    const k = draftKey(s)
    setDrafts((prev) => { if (!(k in prev)) return prev; const n = { ...prev }; delete n[k]; return n })
  }

  // meow-memory 同款：scope.set 被拒时静默 recover、只回 false，不看返回值；
  // 写完回读 user 层判定是否落地，未落地再等 300ms 复查，仍不落地才报错。
  const jsonEqual = (a: unknown, b: unknown): boolean => {
    if (a === b) return true
    if (typeof a !== typeof b) return false
    if (typeof a !== 'object' || a === null || b === null) return false
    try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
  }
  const readUserField = (s: FieldSpec): unknown => {
    const u = scope.getSnapshot().user
    return s.sub === undefined ? u?.[s.key] : u?.[s.sub]?.[s.key]
  }

  const save = async (spec: FieldSpec, raw: string) => {
    setError(null)
    const value: unknown = spec.type === 'number' ? Number(raw) : raw
    const path: string[] = spec.sub === undefined ? [spec.key] : [spec.sub, spec.key]
    console.info('[dsh-feed] save start', { path, value, mode: snap.mode, writable: snap.writable })
    void logProbe({ note: 'save start', path, value, mode: snap.mode, writable: snap.writable })
    if (snap.mode === 'memory') {
      setError('当前为只读镜像连接，无法保存。请在本机 DSH 上配置。')
      return
    }
    let setThrew: any = null
    try {
      if (spec.sub === undefined) {
        await scope.set(spec.key, value)
      } else {
        // 基于 user 层父对象合成 patch 整体写父键（不取合成值，避免把 base 预填搬进 user 层）
        const user = scope.getSnapshot().user
        const parent = { ...((user?.[spec.sub] ?? {}) as Record<string, unknown>) }
        parent[spec.key] = value
        await scope.set(spec.sub, parent)
      }
    } catch (e: any) {
      setThrew = e
      console.info('[dsh-feed] save scope.set threw', { message: e?.message })
    }
    const landed = (): boolean => jsonEqual(readUserField(spec), value)
    if (landed()) { clearDraft(spec); flashSaved(); console.info('[dsh-feed] save landed immediately', { path }); return }
    await new Promise((r) => setTimeout(r, 300))
    if (landed()) { clearDraft(spec); flashSaved(); console.info('[dsh-feed] save landed after retry', { path }); return }
    console.info('[dsh-feed] save NOT landing — probing host rejection envelope', { path, setThrew: setThrew?.message ?? null })
    await logProbe({ note: 'save NOT landing, probing', path, setThrew: setThrew?.message ?? null })
    // configForms 把服务端拒因 envelope 整个吞掉只回 false，宿主拒写又零日志。
    // 直发 remote.settings.mutate 把拒因打回控制台（meow-memory settings-page.ts:650-705）。
    await probeMutationRejection(path, value)
    setError(`保存未生效：${draftKey(spec)}（拒因已打到控制台 [dsh-feed] probe 日志）`)
    clearDraft(spec)
  }

  const reset = async (spec: FieldSpec) => {
    setError(null)
    try {
      if (spec.sub === undefined) {
        await scope.unset(spec.key)
      } else {
        const parent = { ...((scope.getSnapshot().user?.[spec.sub] ?? {}) as Record<string, unknown>) }
        delete parent[spec.key]
        if (Object.keys(parent).length === 0) await scope.unset(spec.sub)
        else await scope.set(spec.sub, parent)
      }
    } catch (e: any) {
      setError(`恢复默认失败：${e?.message ?? String(e)}`)
      return
    }
    const gone = (): boolean => readUserField(spec) === undefined
    if (gone()) { clearDraft(spec); flashSaved(); return }
    await new Promise((r) => setTimeout(r, 300))
    if (gone()) { clearDraft(spec); flashSaved(); return }
    setError('恢复默认未生效（可能被宿主拒收，检查控制台日志）')
    clearDraft(spec)
  }

  // 按 group 分组渲染
  const groups: Record<string, FieldSpec[]> = {}
  for (const f of FIELDS) (groups[f.group] ??= []).push(f)

  try {
  return h('div', { className: 'dsh-feed-settings' },
    h('div', { className: 'dsh-feed-settings-head' },
      h('span', { className: 'dsh-feed-settings-title' }, '个性化推荐 配置'),
      savedAt ? h('span', { className: 'dsh-feed-settings-saved' }, '已保存（重启 DSH 后生效）') : null,
      h('button', { className: 'dsh-feed-settings-close', onClick: close, 'aria-label': '关闭' }, '×'),
    ),
    error ? h('div', { className: 'dsh-feed-settings-error' }, error) : null,
    h('div', { className: 'dsh-feed-settings-body' },
      Object.entries(groups).map(([group, fields]) =>
        h('section', { key: group, className: 'dsh-feed-settings-group' },
          h('h3', { className: 'dsh-feed-settings-group-title' }, group),
          ...fields.map((spec) => {
            const dk = draftKey(spec)
            const current = fieldValue(snap, spec)
            const overridden = fieldOverridden(snap, spec)
            const draftVal = dk in drafts ? drafts[dk] : undefined
            const displayVal = draftVal !== undefined ? draftVal
              : (spec.type === 'secret' ? '' : (current ?? ''))
            const isSecret = spec.type === 'secret'
            const hasSecret = isSecret && Boolean(current)
            return h('div', { key: dk, className: 'dsh-feed-settings-field' },
              h('label', { className: 'dsh-feed-settings-label' },
                spec.label,
                overridden ? h('span', { className: 'dsh-feed-settings-override' }, '（已覆盖默认）') : null,
              ),
              h('div', { className: 'dsh-feed-settings-control' },
                spec.type === 'select'
                  ? h('select', {
                      className: 'dsh-feed-settings-input',
                      value: String(displayVal ?? ''),
                      onChange: (e: any) => setDrafts((d) => ({ ...d, [dk]: e.target.value })),
                    },
                      (spec.options ?? []).map((o) => h('option', { key: o, value: o }, o)),
                    )
                  : h('input', {
                      className: 'dsh-feed-settings-input',
                      type: isSecret ? 'password' : (spec.type === 'number' ? 'number' : 'text'),
                      value: String(displayVal ?? ''),
                      placeholder: isSecret ? (hasSecret ? '已配置（输入新值覆盖）' : '未配置，输入即保存') : '',
                      onChange: (e: any) => setDrafts((d) => ({ ...d, [dk]: e.target.value })),
                    }),
                h('div', { className: 'dsh-feed-settings-actions' },
                  dk in drafts
                    ? h('button', {
                        className: 'dsh-feed-settings-btn dsh-feed-settings-btn-primary',
                        onClick: () => save(spec, drafts[dk]),
                      }, '保存')
                    : null,
                  overridden
                    ? h('button', {
                        className: 'dsh-feed-settings-btn',
                        onClick: () => reset(spec),
                      }, '恢复默认')
                    : null,
                ),
              ),
            )
          }),
        ),
      ),
    ),
  )
  } catch (e: any) {
    console.error('[dsh-feed] settings 渲染抛错', e)
    return h('div', { className: 'dsh-feed-settings-error' },
      `个性化推荐 设置渲染出错：${e?.message ?? String(e)}（请把此错误发给开发者）`)
  }
}

function injectSettingsCss(): void {
  if (typeof document === 'undefined') return
  const CSS_ID = 'dsh-feed-settings'
  let tag = document.querySelector(`style[data-plugin-css="${CSS_ID}"]`)
  if (tag === null) {
    tag = document.createElement('style')
    tag.dataset.pluginCss = CSS_ID
    document.head.appendChild(tag)
  }
  tag.textContent = SETTINGS_CSS
}

const SETTINGS_CSS = `
.dsh-feed-settings { max-width: 640px; padding: 16px 20px 32px; color: var(--dsw-alias-label-primary, #1a1a1a); }
.dsh-feed-settings-head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.dsh-feed-settings-title { font-size: 16px; font-weight: 600; flex: 1; }
.dsh-feed-settings-saved { font-size: 12px; color: var(--dsw-alias-label-success, #16a34a); }
.dsh-feed-settings-close { background: none; border: none; font-size: 20px; cursor: pointer; color: var(--dsw-alias-label-secondary); border-radius: 6px; padding: 2px 8px; }
.dsh-feed-settings-close:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05)); }
.dsh-feed-settings-error { font-size: 12px; color: var(--dsw-alias-label-danger, #dc2626); background: var(--dsw-alias-interactive-bg-hover, rgba(220,38,38,0.06)); padding: 8px 12px; border-radius: 8px; margin-bottom: 12px; }
.dsh-feed-settings-loading, .dsh-feed-settings-readonly { padding: 40px 20px; text-align: center; color: var(--dsw-alias-label-caption); font-size: 13px; }
.dsh-feed-settings-group { margin-bottom: 24px; }
.dsh-feed-settings-group-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-secondary); margin: 0 0 12px; text-transform: uppercase; letter-spacing: 0.04em; }
.dsh-feed-settings-field { margin-bottom: 14px; }
.dsh-feed-settings-label { display: block; font-size: 13px; margin-bottom: 6px; }
.dsh-feed-settings-override { font-size: 11px; color: var(--dsw-alias-label-caption); }
.dsh-feed-settings-control { display: flex; align-items: center; gap: 10px; }
.dsh-feed-settings-input { flex: 1; min-width: 0; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.12)); background: var(--dsw-alias-bg-primary, #fff); color: inherit; font-size: 13px; }
.dsh-feed-settings-input:focus { outline: none; border-color: var(--dsw-alias-label-primary, #1a1a1a); }
.dsh-feed-settings-actions { display: flex; gap: 6px; flex-shrink: 0; }
.dsh-feed-settings-btn { padding: 6px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.12)); background: transparent; color: var(--dsw-alias-label-primary); font-size: 12px; cursor: pointer; }
.dsh-feed-settings-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05)); }
.dsh-feed-settings-btn-primary { background: var(--dsw-alias-label-primary, #1a1a1a); color: var(--dsw-alias-bg-primary, #fff); border-color: transparent; }
`

interface FeedItem {
  id: number
  title: string
  content: string
  format: string
  source_url: string
  created_at: number
  liked: number
  skipped: number
  content_type: 'text' | 'image' | 'text_image' | 'video'
  image_url: string
  video_url: string
}

interface InterestRow {
  id: number
  memory_id: string | null
  title: string
  content: string
  keywords: string
  level: string
  importance: number
  status: string
  skip_reason: string
  source: string
  created_at: number
  last_generated_at: number
  gen_count: number
  like_count: number
  skip_count: number
}

// ── 主入口 ───────────────────────────────────────────────────────────────
export function apply(ctx: any): () => void {
  const disposers: (() => void)[] = []

  // ── 设置界面（settings.section 槽，读写 dsh-feed namespace）──────────────
  try {
    disposers.push(applySettingsPage(ctx))
  } catch (e) {
    console.warn('[dsh-feed] 设置页注册失败：', e)
  }

  // ── SSE 通知监听 ──────────────────────────────────────────────────────
  let sse: EventSource | null = null
  try {
    sse = new EventSource('/dsh-feed/sse')
    sse.addEventListener('feed-ready', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data)
        const count = data.count ?? 1
        const title = data.title ?? '新内容'
        showToast(`✨ ${count} 篇新内容已就绪：${title}`)
      } catch { /* ignore parse errors */ }
    })
  } catch { /* SSE not available */ }

  // 注入 CSS
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-feed'
  style.textContent = CSS
  document.head.appendChild(style)

  // 注册侧边栏按钮
  const slots = ctx?.slots
  if (slots && typeof slots.inject === 'function') {
    disposers.push(
      slots.inject('sidebar.footer.action', () =>
        slots.register(
          { name: 'sidebar.footer.action', id: 'dsh-feed', order: 100, label: '✨ 个性化推荐' },
          FeedSidebarButton,
        ),
      ),
    )
  } else {
    console.warn('[dsh-feed] slots service unavailable')
  }

  return () => {
    disposers.forEach((d) => d())
    style.remove()
    if (sse) { sse.close(); sse = null }
  }
}

// ── Toast 通知 ─────────────────────────────────────────────────────────────
function showToast(message: string): void {
  // 防止重复 toast
  const existing = document.querySelector('[data-dsh-feed-toast]')
  if (existing) existing.remove()

  const toast = document.createElement('div')
  toast.setAttribute('data-dsh-feed-toast', 'true')
  toast.textContent = message
  document.body.appendChild(toast)

  // 3 秒后自动消失
  setTimeout(() => {
    toast.style.opacity = '0'
    setTimeout(() => toast.remove(), 300)
  }, 3000)
}

// ── 侧边栏按钮组件 ──────────────────────────────────────────────────────
function FeedSidebarButton({ wide }: { wide: boolean }) {
  const [count, setCount] = useState(0)

  useEffect(() => {
    fetch('/dsh-feed/status')
      .then((r) => r.json())
      .then((d) => setCount(d.unshown ?? 0))
      .catch(() => {})
  }, [])

  const onClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    openFeedView()
  }

  if (wide) {
    return h(
      'div',
      { style: { padding: '6px 8px', width: '100%' } },
      h(
        'button',
        {
          type: 'button',
          onClick,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            width: '100%',
            padding: '8px 12px',
            borderRadius: '8px',
            border: 'none',
            background: 'transparent',
            color: 'var(--dsw-alias-label-primary)',
            fontSize: '13px',
            cursor: 'pointer',
            transition: 'background 0.15s',
          },
          onMouseEnter: (e: any) => {
            e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)'
          },
          onMouseLeave: (e: any) => {
            e.currentTarget.style.background = 'transparent'
          },
        },
        h('span', { style: { fontSize: '18px', flexShrink: 0 } }, '✨'),
        h('span', { style: { flex: 1 } }, '个性化推荐'),
        count > 0
          ? h(
              'span',
              {
                style: {
                  background: '#f43f5e',
                  color: '#fff',
                  fontSize: '11px',
                  fontWeight: 600,
                  padding: '1px 6px',
                  borderRadius: '9px',
                  minWidth: '16px',
                  textAlign: 'center' as const,
                },
              },
              count > 99 ? '99+' : String(count),
            )
          : null,
      ),
    )
  }

  // collapsed rail 模式：只显示图标
  return h(
    'button',
    {
      type: 'button',
      onClick,
      style: {
        width: '36px',
        height: '36px',
        borderRadius: '8px',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '18px',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'background 0.15s',
        position: 'relative' as const,
      },
      onMouseEnter: (e: any) => {
        e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)'
      },
      onMouseLeave: (e: any) => {
        e.currentTarget.style.background = 'transparent'
      },
      'aria-label': '个性化推荐 Feed',
    },
    '✨',
  )
}

// ── 全屏 Feed 覆盖层 ────────────────────────────────────────────────────
function openFeedView(): void {
  if (document.querySelector(`[${OVERLAY_ATTR}]`)) return

  const overlay = document.createElement('div')
  overlay.setAttribute(OVERLAY_ATTR, 'true')

  // 顶栏（返回 + 标签页）
  const header = document.createElement('div')
  header.className = 'dsh-feed-header'
  header.innerHTML = `
    <button class="dsh-feed-back" aria-label="返回">←</button>
    <div class="dsh-feed-tabs">
      <button class="dsh-feed-tab is-active" data-view="feed">内容</button>
      <button class="dsh-feed-tab" data-view="interests">兴趣</button>
    </div>
    <span class="dsh-feed-header-spacer"></span>
  `
  header.querySelector('.dsh-feed-back')!.addEventListener('click', closeFeedView)

  // 滚动容器
  const container = document.createElement('div')
  container.className = 'dsh-feed-container'

  overlay.appendChild(header)
  overlay.appendChild(container)
  document.body.appendChild(overlay)

  // 键盘
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeFeedView()
      e.preventDefault()
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      scrollFeed(container, e.key === 'ArrowDown' ? 1 : -1)
      e.preventDefault()
    }
  }
  document.addEventListener('keydown', onKeyDown)
  ;(overlay as any).__cleanup = () => document.removeEventListener('keydown', onKeyDown)

  // 标签切换
  const showView = (view: 'feed' | 'interests') => {
    header.querySelectorAll('.dsh-feed-tab').forEach((btn) => {
      btn.classList.toggle('is-active', (btn as HTMLElement).dataset.view === view)
    })
    container.classList.toggle('is-list', view === 'interests')
    container.innerHTML = ''
    if (view === 'feed') loadFeedItems(container)
    else loadInterests(container)
  }
  header.querySelectorAll('.dsh-feed-tab').forEach((btn) => {
    ;(btn as HTMLElement).addEventListener('click', () => {
      const v = (btn as HTMLElement).dataset.view as 'feed' | 'interests'
      showView(v)
    })
  })

  showView('feed')
}

function closeFeedView(): void {
  const overlay = document.querySelector(`[${OVERLAY_ATTR}]`)
  if (!overlay) return
  const cleanup = (overlay as any).__cleanup
  if (cleanup) cleanup()
  overlay.remove()
}

async function loadInterests(container: HTMLElement): Promise<void> {
  const loading = document.createElement('div')
  loading.setAttribute(CARD_ATTR, 'true')
  loading.className = 'dsh-feed-interest-loading'
  loading.innerHTML = '<div style="text-align:center;color:var(--dsw-alias-label-caption);padding-top:40vh">加载中...</div>'
  container.appendChild(loading)
  try {
    const res = await fetch('/dsh-feed/interests')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    loading.remove()
    const interests = (data.interests ?? []) as InterestRow[]
    if (interests.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'dsh-feed-interest-empty'
      empty.innerHTML = '<div style="text-align:center;color:var(--dsw-alias-label-caption);padding-top:40vh">暂无兴趣记录<br><span style="font-size:12px">触发 memory_remember 或等待定时扫描后会自动收录</span></div>'
      container.appendChild(empty)
      return
    }
    const refresh = () => { container.innerHTML = ''; loadInterests(container) }
    for (const it of interests) container.appendChild(createInterestRow(it, refresh))
  } catch {
    loading.remove()
    const err = document.createElement('div')
    err.className = 'dsh-feed-interest-empty'
    err.innerHTML = '<div style="text-align:center;color:var(--dsw-alias-label-caption);padding-top:40vh">加载失败，请稍后重试</div>'
    container.appendChild(err)
  }
}

function createInterestRow(it: InterestRow, onChanged: () => void): HTMLElement {
  const row = document.createElement('div')
  row.className = 'dsh-feed-interest-row'
  const isSkipped = it.status === 'skipped'
  const isPaused = it.status === 'paused'

  // 状态徽章
  const status = document.createElement('span')
  status.className = `dsh-feed-interest-status ${isSkipped ? 'is-skipped' : isPaused ? 'is-paused' : 'is-active'}`
  status.textContent = isSkipped ? '已跳过' : isPaused ? '已暂停' : '进行中'

  // 标题行
  const head = document.createElement('div')
  head.className = 'dsh-feed-interest-head'
  const title = document.createElement('span')
  title.className = 'dsh-feed-interest-title'
  title.textContent = it.title
  head.appendChild(title)
  head.appendChild(status)

  row.appendChild(head)

  // 跳过原因
  if (isSkipped && it.skip_reason) {
    const reason = document.createElement('div')
    reason.className = 'dsh-feed-interest-reason'
    reason.textContent = `判定理由：${it.skip_reason}`
    row.appendChild(reason)
  } else if (isPaused && it.skip_reason) {
    const reason = document.createElement('div')
    reason.className = 'dsh-feed-interest-reason'
    reason.textContent = it.skip_reason
    row.appendChild(reason)
  }

  // 元信息
  const meta = document.createElement('div')
  meta.className = 'dsh-feed-interest-meta'
  const parts: string[] = []
  if (it.source === 'event') parts.push('来源：实时记忆')
  else if (it.source === 'poll') parts.push('来源：定时扫描')
  if (it.level) parts.push(`层级：${it.level}`)
  if (it.importance) parts.push(`重要度：${it.importance}`)
  parts.push(`生成 ${it.gen_count} · 喜欢 ${it.like_count} · 跳过 ${it.skip_count}`)
  if (it.last_generated_at > 0) {
    const ago = relativeAgo(it.last_generated_at * 1000)
    parts.push(`上次生成：${ago}`)
  }
  meta.textContent = parts.join('  ·  ')
  row.appendChild(meta)

  // 操作按钮
  const actions = document.createElement('div')
  actions.className = 'dsh-feed-interest-actions'
  const btn = (label: string, onClick: () => void) => {
    const b = document.createElement('button')
    b.className = 'dsh-feed-interest-btn'
    b.textContent = label
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick() })
    actions.appendChild(b)
  }
  const call = async (url: string, method: string) => {
    try { await fetch(url, { method }); onChanged() } catch { /* ignore */ }
  }
  if (isSkipped || isPaused) {
    btn('恢复', () => call(`/dsh-feed/interest/${it.id}/resume`, 'POST'))
  } else {
    btn('重新生成', () => {
      showToast(`🔄 正在为「${it.title.slice(0, 16)}」生成...`)
      fetch(`/dsh-feed/interest/${it.id}/regenerate`, { method: 'POST' }).catch(() => {})
    })
    btn('暂停', () => call(`/dsh-feed/interest/${it.id}/pause`, 'POST'))
  }
  btn('删除', () => call(`/dsh-feed/interest/${it.id}`, 'DELETE'))
  row.appendChild(actions)

  return row
}

function relativeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 0) return '刚刚'
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}秒前`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}小时前`
  const d = Math.floor(h / 24)
  return `${d}天前`
}

async function loadFeedItems(container: HTMLElement): Promise<void> {
  try {
    const res = await fetch('/dsh-feed/feed')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()

    container.querySelector('.dsh-feed-loading')?.remove()

    if (!data.items || data.items.length === 0) {
      const emptyCard = document.createElement('div')
      emptyCard.setAttribute(CARD_ATTR, 'true')
      emptyCard.className = 'dsh-feed-card'
      emptyCard.innerHTML = '<div style="text-align:center;color:var(--dsw-alias-label-caption);padding-top:40vh">暂无内容<br><span style="font-size:12px">试试 POST /dsh-feed/seed 添加内容</span></div>'
      container.appendChild(emptyCard)
      return
    }

    for (const item of data.items as FeedItem[]) {
      const card = createContentCard(item)
      container.appendChild(card)
    }
  } catch {
    container.querySelector('.dsh-feed-loading')?.remove()
    const errorCard = document.createElement('div')
    errorCard.setAttribute(CARD_ATTR, 'true')
    errorCard.className = 'dsh-feed-card'
    errorCard.innerHTML = '<div style="text-align:center;color:var(--dsw-alias-label-caption);padding-top:40vh">加载失败，请稍后重试</div>'
    container.appendChild(errorCard)
  }
}

function createContentCard(item: FeedItem): HTMLElement {
  const card = document.createElement('div')
  card.setAttribute(CARD_ATTR, 'true')
  card.className = 'dsh-feed-card'
  card.dataset.feedItemId = String(item.id)
  card.dataset.contentType = item.content_type

  // 内容区
  const body = document.createElement('div')
  body.className = 'dsh-feed-card-body'

  const title = document.createElement('div')
  title.className = 'dsh-feed-card-title'
  title.textContent = item.title
  if (item.title) body.appendChild(title)

  // 视频（纯视频类型）
  if (item.video_url) {
    const video = document.createElement('video')
    video.className = 'dsh-feed-card-video'
    video.src = item.video_url
    video.controls = true
    video.playsInline = true
    video.preload = 'metadata'
    body.appendChild(video)
  }

  // 图片（纯图片 / 图文类型）
  if (item.image_url) {
    const img = document.createElement('img')
    img.className = 'dsh-feed-card-image'
    img.src = item.image_url
    img.alt = item.title
    img.loading = 'lazy'
    body.appendChild(img)
  }

  // 正文（纯图片 / 纯视频类型不显示正文）
  if (item.content_type !== 'image' && item.content_type !== 'video' && item.content) {
    const content = document.createElement('div')
    content.className = 'dsh-feed-card-content'
    content.textContent = item.content
    body.appendChild(content)
  }

  // 右侧操作按钮
  const actions = document.createElement('div')
  actions.className = 'dsh-feed-actions'

  // 点赞
  const likeBtn = createActionBtn('❤️', '喜欢', () => {
    fetch(`/dsh-feed/feed/${item.id}/like`, { method: 'POST' }).catch(() => {})
    likeBtn.dataset.liked = 'true'
    likeBtn.querySelector('.icon')!.textContent = '❤️'
    likeBtn.style.opacity = '1'
  })
  actions.appendChild(likeBtn)

  // 跳过
  const skipBtn = createActionBtn('✕', '跳过', () => {
    fetch(`/dsh-feed/feed/${item.id}/skip`, { method: 'POST' }).catch(() => {})
    // 滑到下一张
    scrollFeed(card.parentElement as HTMLElement, 1)
    // 淡出当前卡片
    card.style.opacity = '0.3'
  })
  actions.appendChild(skipBtn)

  card.appendChild(body)
  card.appendChild(actions)
  return card
}

function createActionBtn(icon: string, label: string, onClick: () => void): HTMLElement {
  const btn = document.createElement('div')
  btn.className = 'dsh-feed-action-btn'
  btn.innerHTML = `<span class="icon">${icon}</span><span class="label">${label}</span>`
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    onClick()
  })
  return btn
}

function scrollFeed(container: HTMLElement, direction: 1 | -1): void {
  const cards = container.querySelectorAll(`[${CARD_ATTR}]`)
  const rect = container.getBoundingClientRect()
  const centerY = rect.top + rect.height / 2

  let currentIdx = -1
  cards.forEach((card, i) => {
    const r = (card as HTMLElement).getBoundingClientRect()
    if (r.top <= centerY && r.bottom >= centerY) currentIdx = i
  })

  const targetIdx = currentIdx + direction
  if (targetIdx >= 0 && targetIdx < cards.length) {
    ;(cards[targetIdx] as HTMLElement).scrollIntoView({ behavior: 'smooth' })
  }
}

// ── CSS ──────────────────────────────────────────────────────────────────
const CSS = `
/* 全屏覆盖层 */
[data-dsh-feed-overlay] {
  position: fixed;
  inset: 0;
  z-index: 2147483646;
  background: var(--dsw-alias-bg-primary, #fff);
  display: flex;
  flex-direction: column;
}

/* 顶栏 */
.dsh-feed-header {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.08));
  flex-shrink: 0;
  background: var(--dsw-alias-bg-primary, #fff);
}
.dsh-feed-back {
  background: none;
  border: none;
  color: var(--dsw-alias-label-primary);
  font-size: 20px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
  transition: background 0.15s;
}
.dsh-feed-back:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05));
}

/* 顶栏标签页 */
.dsh-feed-tabs {
  flex: 1;
  display: flex;
  justify-content: center;
  gap: 4px;
}
.dsh-feed-tab {
  background: none;
  border: none;
  color: var(--dsw-alias-label-caption);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  padding: 6px 16px;
  border-radius: 8px;
  transition: background 0.15s, color 0.15s;
}
.dsh-feed-tab:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05));
}
.dsh-feed-tab.is-active {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06));
  font-weight: 600;
}
.dsh-feed-header-spacer { width: 36px; flex-shrink: 0; }

/* 兴趣列表模式（关掉卡片 snap） */
.dsh-feed-container.is-list {
  scroll-snap-type: none;
}
.dsh-feed-interest-empty {
  min-height: 100vh;
}

/* 兴趣条目 */
.dsh-feed-interest-row {
  max-width: 680px;
  margin: 0 auto;
  padding: 16px 20px;
  border-bottom: 1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.06));
}
.dsh-feed-interest-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}
.dsh-feed-interest-title {
  flex: 1;
  font-size: 15px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  line-height: 1.4;
}
.dsh-feed-interest-status {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 9px;
}
.dsh-feed-interest-status.is-active {
  color: #16a34a;
  background: rgba(22,163,74,0.1);
}
.dsh-feed-interest-status.is-skipped {
  color: var(--dsw-alias-label-caption);
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05));
}
.dsh-feed-interest-status.is-paused {
  color: #d97706;
  background: rgba(217,119,6,0.1);
}
.dsh-feed-interest-reason {
  font-size: 12px;
  color: var(--dsw-alias-label-caption);
  margin-bottom: 6px;
  line-height: 1.5;
}
.dsh-feed-interest-meta {
  font-size: 11px;
  color: var(--dsw-alias-label-caption);
  line-height: 1.6;
}
.dsh-feed-interest-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.dsh-feed-interest-btn {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.12));
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.dsh-feed-interest-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05));
  color: var(--dsw-alias-label-primary);
}
.dsh-feed-title {
  flex: 1;
  text-align: center;
  font-size: 15px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  margin-right: 36px; /* 平衡返回按钮宽度 */
}

/* 滚动容器 */
.dsh-feed-container {
  flex: 1;
  overflow-y: auto;
  scroll-snap-type: y mandatory;
  -webkit-overflow-scrolling: touch;
}

/* 卡片 */
.dsh-feed-card {
  min-height: 100vh;
  scroll-snap-align: start;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  position: relative;
  box-sizing: border-box;
}

/* 卡片内容 */
.dsh-feed-card-body {
  flex: 1;
  max-width: 600px;
  padding: 32px;
}
.dsh-feed-card-title {
  font-size: 22px;
  font-weight: 700;
  color: var(--dsw-alias-label-primary);
  margin-bottom: 16px;
  line-height: 1.4;
}
.dsh-feed-card-content {
  font-size: 15px;
  line-height: 1.8;
  color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap;
}

/* 卡片图片 */
.dsh-feed-card-image {
  width: 100%;
  max-height: 50vh;
  object-fit: contain;
  border-radius: 12px;
  margin: 16px 0;
  background: var(--dsw-alias-bg-secondary, #f5f5f5);
}

/* 卡片视频 */
.dsh-feed-card-video {
  width: 100%;
  max-height: 60vh;
  border-radius: 12px;
  margin: 16px 0;
  background: #000;
}

/* 右侧操作按钮 */
.dsh-feed-actions {
  position: absolute;
  right: 20px;
  bottom: 100px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  align-items: center;
}
.dsh-feed-action-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 0.15s, transform 0.15s;
}
.dsh-feed-action-btn:hover {
  opacity: 1;
  transform: scale(1.1);
}
.dsh-feed-action-btn .icon {
  font-size: 28px;
  line-height: 1;
}
.dsh-feed-action-btn .label {
  font-size: 11px;
  color: var(--dsw-alias-label-caption);
}
.dsh-feed-action-btn[data-liked="true"] {
  opacity: 1;
}

/* Toast 通知 */
[data-dsh-feed-toast] {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--dsw-alias-bg-elevated, #1a1a2e);
  color: var(--dsw-alias-label-primary, #fff);
  padding: 12px 24px;
  border-radius: 12px;
  font-size: 14px;
  z-index: 2147483647;
  box-shadow: 0 4px 20px rgba(0,0,0,0.3);
  transition: opacity 0.3s;
  cursor: pointer;
  max-width: 400px;
  text-align: center;
}
[data-dsh-feed-toast]:hover {
  opacity: 0.8;
}
`
