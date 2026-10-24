/**
 * dsh-feed — 生成编排：双触发 + 兴趣去重 + 分类 gate。
 *
 * 路径 A（memory_remember 事件）：监听 tool/call → upsert interest → 分类 → 生成。
 * 路径 B（定时轮询 meow DB）：readMeowMemories → upsert interest（带 level/importance）
 *   → 对未分类的新兴趣分类 → 挑可再生成的候选生成。
 *
 * 两条路径都往 interest 表写，按 content_hash 去重；分类结果存进 status，
 * 下次轮询不会重复判定。
 */
import type { DbHandle } from './db'
import { contentHash } from './db'
import type { ContentGen, GenResult } from './content'
import type { Classify } from './classify'
import { readMeowMemories } from './meow'
import * as logger from './log'

const ITEMS_PER_TYPE = 1
const ITEMS_PER_VIDEO = 1

/** 清洗对话视角词汇：去掉"用户""你""您"等，避免 LLM 在输出中沿用或引申。 */
export function stripDialogueWords(s: string): string {
  return s
    .replace(/用户/g, '')
    .replace(/您/g, '')
    .replace(/你/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export interface GenDeps {
  db: DbHandle
  content: ContentGen
  classify: Classify
  readCfg: () => { feed: { scanIntervalMinutes: number; maxGeneratePerScan: number; regenIntervalHours: number } }
  workspaceDir: string
  notifyClients: (event: string, data: any) => void
}

export interface UpsertInput {
  title: string
  content: string
  keywords: string[]
  memoryId?: string | null
  level?: string
  importance?: number
  source: 'event' | 'poll'
}

/** upsert 兴趣（按 content_hash 去重）。返回 interest 行。 */
export function upsertInterest(db: DbHandle, input: UpsertInput) {
  const hash = contentHash(input.title, input.content)
  db.stmts.upsertInterest.run({
    content_hash: hash,
    memory_id: input.memoryId ?? null,
    title: input.title,
    content: input.content,
    keywords: JSON.stringify(input.keywords ?? []),
    level: input.level ?? '',
    importance: input.importance ?? 0,
    source: input.source,
  })
  return db.stmts.getInterestByHash.get(hash) as any
}

/** 对一条兴趣跑 4 种类型生成，写 feed_item（带 interest_id），更新生成计数。 */
async function generateForInterest(deps: GenDeps, interest: any): Promise<number> {
  const { db, content, notifyClients } = deps
  const title = interest.title
  const rawContent = interest.content
  let keywords: string[] = []
  try { keywords = JSON.parse(interest.keywords ?? '[]') } catch { /* keep [] */ }

  const types: Array<{ key: 'text' | 'image' | 'text_image' | 'video'; label: string; fn: keyof ContentGen }> = [
    { key: 'text', label: '纯文本', fn: 'generateTextArticle' },
    { key: 'image', label: '纯图片', fn: 'generateImageOnly' },
    { key: 'text_image', label: '图文', fn: 'generateTextWithImage' },
    { key: 'video', label: '视频', fn: 'generateVideoOnly' },
  ]
  let insertedCount = 0

  for (const t of types) {
    const count = t.key === 'video' ? ITEMS_PER_VIDEO : ITEMS_PER_TYPE
    for (let i = 0; i < count; i++) {
      logger.info('▶ 生成 %s #%d：「%s」', t.label, i + 1, title)
      let result: GenResult | null = null
      try {
        result = await (content[t.fn] as any)(title, rawContent, keywords)
      } catch (e: any) {
        logger.warn('%s 生成失败：%s', t.label, e.message)
        continue
      }
      if (!result) {
        logger.warn('%s 跳过（生成返回空）', t.label)
        continue
      }
      const sourceUrl = `meow:${rawContent.slice(0, 100)}:${t.key}#${Date.now()}`
      db.stmts.insertFeed.run(
        result.title, result.content, 'short', sourceUrl,
        result.content_type, result.image_url, result.video_url ?? '',
        interest.id,
      )
      insertedCount++
      logger.info('✓ %s 完成：%s', t.label, result.title)
    }
  }

  db.stmts.markGenerated.run(Math.floor(Date.now() / 1000), interest.id)
  return insertedCount
}

/** 路径 A：memory_remember 事件 → upsert → 分类（若新）→ 生成。 */
export async function handleMemoryRememberEvent(deps: GenDeps, data: { name?: string; arguments?: string }): Promise<void> {
  const { db, classify, notifyClients } = deps
  try {
    const args = JSON.parse(data.arguments ?? '{}')
    const rawContent = args.content ?? ''
    const content = stripDialogueWords(rawContent)
    const title = stripDialogueWords(args.title || rawContent.slice(0, 40))
    const keywords: string[] = (() => { try { return JSON.parse(args.keywords ?? '[]') } catch { return [] } })()
    if (!content) return

    logger.info('━━━ 收到 memory_remember：「%s」 ━━━', title)

    const interest = upsertInterest(db, { title, content, keywords, memoryId: args.id ?? null, source: 'event' })

    // 已判定为不感兴趣 → 跳过
    if (interest.status === 'skipped') {
      logger.info('「%s」已标记为不感兴趣，跳过生成（%s）', title, interest.skip_reason)
      return
    }
    // 新兴趣（未分类）：跑分类 gate
    if (interest.status === 'active' && interest.gen_count === 0 && !interest.skip_reason && !hasBeenClassified(interest)) {
      const verdict = await classify(title, content, keywords)
      if (!verdict.interested) {
        db.stmts.setInterestStatus.run('skipped', verdict.reason, interest.id)
        logger.info('「%s」判定为不感兴趣，跳过：%s', title, verdict.reason)
        return
      }
      // interested=true：标记已分类（写 reason 留痕，status 保持 active）
      db.stmts.setInterestStatus.run('active', verdict.reason, interest.id)
    }

    const inserted = await generateForInterest(deps, interest)
    if (inserted > 0) {
      notifyClients('feed-ready', { title, count: inserted })
      logger.info('━━━ 生成结束「%s」，共 %d 条 ━━━', title, inserted)
    } else {
      logger.info('━━━ 生成结束「%s」，未产出任何内容 ━━━', title)
    }
  } catch (e: any) {
    logger.warn('processMemoryRemember failed: %s', e?.message ?? e)
  }
}

/** 路径 B：定时扫描 meow DB → upsert 全部 → 分类新兴趣 → 挑可再生成候选生成。 */
export async function runScheduledScan(deps: GenDeps): Promise<void> {
  const { db, classify, readCfg, workspaceDir, notifyClients } = deps
  try {
    const memories = readMeowMemories(workspaceDir)
    if (memories.length === 0) { logger.info('扫描：meow-memory 无记忆'); return }

    logger.info('━━━ 定时扫描：从 meow 读到 %d 条记忆 ━━━', memories.length)

    // 1. upsert 全部（带 level/importance/memory_id）
    for (const m of memories) {
      const content = stripDialogueWords(m.content)
      const title = stripDialogueWords(m.title || m.content.slice(0, 40))
      if (!content) continue
      upsertInterest(db, {
        title, content, keywords: m.keywords,
        memoryId: m.id, level: m.level, importance: m.importance, source: 'poll',
      })
    }

    // 2. 对未分类的新兴趣批量分类（最多 maxGeneratePerScan * 2 条，控成本）
    const all = db.stmts.listAllInterests.all() as any[]
    const unclassified = all.filter(r => r.status === 'active' && !hasBeenClassified(r))
    const classifyBudget = Math.min(unclassified.length, (readCfg().feed.maxGeneratePerScan || 3) * 2)
    for (let i = 0; i < classifyBudget; i++) {
      const r = unclassified[i]
      let keywords: string[] = []
      try { keywords = JSON.parse(r.keywords ?? '[]') } catch { /* keep [] */ }
      const verdict = await classify(r.title, r.content, keywords)
      if (!verdict.interested) {
        db.stmts.setInterestStatus.run('skipped', verdict.reason, r.id)
        logger.info('「%s」判定不感兴趣，跳过：%s', r.title, verdict.reason)
      } else {
        db.stmts.setInterestStatus.run('active', verdict.reason, r.id)
      }
    }

    // 3. 挑可再生成候选：active 且（从未生成 或 超过 regenIntervalHours）
    const cfg = readCfg().feed
    const regenSec = (cfg.regenIntervalHours ?? 48) * 3600
    const now = Math.floor(Date.now() / 1000)
    const candidates = (db.stmts.listGenCandidates.all(cfg.maxGeneratePerScan * 4) as any[])
      .filter(r => r.last_generated_at === 0 || (now - r.last_generated_at) >= regenSec)
      .slice(0, cfg.maxGeneratePerScan)

    if (candidates.length === 0) {
      logger.info('扫描：无可生成候选（均已生成且未过再生窗口）')
      return
    }

    logger.info('扫描：挑出 %d 条候选生成', candidates.length)
    let totalInserted = 0
    for (const c of candidates) {
      const inserted = await generateForInterest(deps, c)
      totalInserted += inserted
    }
    if (totalInserted > 0) {
      notifyClients('feed-ready', { title: '定时扫描', count: totalInserted })
    }
    logger.info('━━━ 扫描生成结束，共 %d 条 ━━━', totalInserted)
  } catch (e: any) {
    logger.warn('scheduled scan failed: %s', e?.message ?? e)
  }
}

/** 兴趣是否已被分类过（用 skip_reason 非空作为已分类标记：分类总会写 reason 留痕）。 */
function hasBeenClassified(interest: any): boolean {
  return Boolean(interest?.skip_reason)
}

/** 手动对指定兴趣立即重新生成（前端"重新生成"按钮用）。 */
export async function regenerateInterest(deps: GenDeps, interestId: number): Promise<number> {
  const interest = deps.db.stmts.getInterest.get(interestId) as any
  if (!interest) throw new Error(`interest ${interestId} not found`)
  logger.info('━━━ 手动重新生成「%s」 ━━━', interest.title)
  const n = await generateForInterest(deps, interest)
  deps.notifyClients('feed-ready', { title: interest.title, count: n })
  logger.info('━━━ 手动重新生成结束「%s」，共 %d 条 ━━━', interest.title, n)
  return n
}
