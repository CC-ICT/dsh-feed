/**
 * dsh-feed — Host 插件入口（瘦版）。
 *
 * 只做装配：Config schema（来自 config.ts）+ DB + 各模块工厂 + 路由注册 +
 * memory_remember 监控（路径 A）+ 定时扫描（路径 B）+ SSE 通知。
 *
 * 实际逻辑分别在：
 *   db.ts        数据层（feed_item + interest 表）
 *   config.ts    Config schema + 运行时 live config 读取
 *   meow.ts      只读 meow-memory DB（路径 B 用）
 *   llm.ts       LLM 流式调用
 *   search.ts    网页搜索
 *   media.ts     图片视频生成
 *   content.ts   4 种内容类型生成（文本/图/图文/视频）
 *   classify.ts  兴趣分类器（判定是否值得做内容）
 *   generation.ts 双触发编排 + 去重 + 分类 gate
 *   routes.ts    webServer 路由
 */
import { Context } from 'cordis'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import * as logger from './log'
import { Config, readLiveConfig, type Config as ConfigType } from './config'
import { createDb } from './db'
import { createLlm } from './llm'
import { createMedia } from './media'
import { createContent } from './content'
import { createClassifier } from './classify'
import { handleMemoryRememberEvent, runScheduledScan, type GenDeps } from './generation'
import { registerRoutes } from './routes'

export { Config }
export type Config = ConfigType

export const inject = ['tools', 'webServer', 'settings']
export const name = 'dsh-feed'

export function apply(ctx: Context, config: ConfigType): void {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const clientBundlePath = join(__dirname, 'client.js')

  // ── 数据库 ─────────────────────────────────────────────────────────────
  const dbDir = join(process.env.HOME ?? '/tmp', '.dsh-feed')
  mkdirSync(dbDir, { recursive: true })
  const { db, stmts } = createDb(dbDir)

  // ── 目录：图片/视频落地 ───────────────────────────────────────────────
  const imagesDir = join(dbDir, 'images')
  const videosDir = join(dbDir, 'videos')

  // ── 运行时 live config（volatile 根 schema 的 patch config 不进 apply 参数）──
  const readCfg = readLiveConfig(ctx, config)
  logger.info('apply config2 (patch layer): %s', JSON.stringify(config))

  // ── 模块装配 ───────────────────────────────────────────────────────────
  const callLlm = createLlm(ctx, readCfg)
  const { generateImage, generateVideo } = createMedia(readCfg, imagesDir, videosDir)
  const content = createContent(callLlm, generateImage, generateVideo)
  const classify = createClassifier(callLlm)

  // ── SSE 通知 ───────────────────────────────────────────────────────────
  const sseClients: Set<any> = new Set()
  function notifyClients(event: string, data: any): void {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of sseClients) {
      try { res.write(msg) } catch { /* client disconnected */ }
    }
  }
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact', path: '/dsh-feed/sse',
      handler: (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache', Connection: 'keep-alive',
        })
        sseClients.add(res)
        req.on('close', () => { sseClients.delete(res) })
      },
    }), 'dsh-feed: /sse route')

  // ── workspace（meow-memory 所在） ─────────────────────────────────────
  // DSH 加载插件时设 DSH_WORKSPACE；兜底按标准 DSH 布局 ~/Documents/deepseek-harness/，
  // 不要写死个人路径（交付给他人会指向不存在的目录）。
  const workspaceDir = process.env.DSH_WORKSPACE
    ?? join(homedir(), 'Documents', 'deepseek-harness', 'default-workspace')

  // ── 生成依赖 ──────────────────────────────────────────────────────────
  const genDeps: GenDeps = {
    db: { db, stmts },
    content, classify, readCfg, workspaceDir, notifyClients,
  }

  // ── 路由 ──────────────────────────────────────────────────────────────
  registerRoutes(ctx, { db: { db, stmts }, imagesDir, videosDir, clientBundlePath, genDeps })

  // ── 诊断路由：测 LLM 是否可用 ──────────────────────────────────────────
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact', path: '/dsh-feed/test-llm',
      handler: async (_req, res) => {
        const diag: any = { timestamp: Date.now() }
        try {
          const llm = ctx.get('llm') as any
          diag.llm_available = !!llm
          diag.llm_has_stream = !!(llm?.stream)
          const llmCfgLive = readCfg().llm
          diag.llm_provider = llmCfgLive.provider
          diag.llm_model = llmCfgLive.model
          if (llm && typeof llm.stream === 'function') {
            try {
              const chunks: any[] = []
              for await (const chunk of llm.stream({
                provider: llmCfgLive.provider, model: llmCfgLive.model,
                system: '回复一个字：好',
                messages: [{ role: 'user', content: [{ type: 'text', text: '测试' }] }],
                temperature: 0,
              })) { chunks.push(chunk) }
              diag.llm_test = 'success'
              diag.llm_chunk_count = chunks.length
            } catch (e: any) { diag.llm_test = `failed: ${e.message}` }
          }
        } catch (e: any) { diag.llm_error = e.message }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(diag, null, 2))
      },
    }), 'dsh-feed: /test-llm route')

  // ── 自动 seed（首次启动空库时填演示项，便于前端联调） ─────────────────
  const total = (stmts.countAllFeed.get() as any)?.cnt ?? 0
  if (total === 0) {
    const seeds = [
      { title: '✨ 十二首藏在地铁名里的冷知识', content: '上海地铁"大世界"站的英文译名是 Dashijie——直接用拼音而非意译，这是上海轨交命名惯例里少见的保留。', type: 'text' as const },
      { title: '🎨 一张关于黄昏的画', content: '', type: 'image' as const },
      { title: '✨ Rust 里少有人提的 unsafe 边界', content: 'unsafe 不关闭 borrow checker，只是让你承诺满足某些 invariant；Rust 1.x 后 deref_raw 因 aliasing xchg 而被重新审视。', type: 'text' as const },
    ]
    for (const s of seeds) {
      stmts.insertFeed.run(s.title, s.content, 'short', `seed:${s.type}`, s.type, '', '', 0)
    }
    logger.info('auto-seeded %d demo items', seeds.length)
  }

  // ── 路径 A：监控 memory_remember 工具调用 ──────────────────────────────
  ctx.effect(() => {
    const off = ctx.on('session/event' as any, (session: any, event: any) => {
      if (event?.type !== 'tool/call') return
      const data = event.data as { name?: string; arguments?: string }
      if (data?.name !== 'memory_remember') return
      // 异步处理，避免阻塞 session 事件链
      setTimeout(() => {
        handleMemoryRememberEvent(genDeps, data).catch((e: any) => {
          logger.error('handleMemoryRememberEvent failed: %s', e?.message ?? e)
        })
      }, 0)
    })
    return off
  }, 'dsh-feed: memory_remember monitor')

  // ── 路径 B：定时扫描 meow-memory DB ────────────────────────────────────
  // 周期 = readCfg().feed.scanIntervalMinutes（设置界面可配，改后下一轮生效）。
  // 用「自重排」而非固定 setInterval：每次扫描结束后重读间隔再排下一轮，
  // 这样用户中途改了 scanIntervalMinutes 无需重启即可生效。
  // 启动后先延迟 60s 跑一轮（等 settings 就绪 + LLM 服务可用），再进入周期。
  ctx.effect(() => {
    const initialDelayMs = 60_000
    let timer: NodeJS.Timeout | null = null
    const runAndReschedule = () => {
      runScheduledScan(genDeps)
        .catch((e: any) => logger.warn('scheduled scan failed: %s', e?.message ?? e))
        .finally(() => {
          const intervalMin = Math.max(1, readCfg().feed.scanIntervalMinutes)
          timer = setTimeout(runAndReschedule, intervalMin * 60_000)
        })
    }
    timer = setTimeout(runAndReschedule, initialDelayMs)
    return () => { if (timer) clearTimeout(timer) }
  }, 'dsh-feed: scheduled scan')

  logger.info('started (db=%s, workspace=%s)', dbDir, workspaceDir)
}
