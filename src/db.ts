/**
 * dsh-feed — SQLite 数据层。
 *
 * feed_item：生成出来的内容卡片。
 * interest：兴趣决策态（一条记忆 → 是否值得做内容、生成/点赞计数、状态）。
 * 两者 1:N（interest.id ← feed_item.interest_id）。
 *
 * A（memory_remember 事件）和 B（定时轮询 meow DB）两条触发路径都往
 * interest 表写，按 content_hash 去重——事件路径拿不到 meow 的 memory_id，
 * 故用「标题+正文」归一化哈希做唯一键，memory_id 仅作注解（poll 路径回填）。
 */
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import * as logger from './log'

/** 归一化标题+正文 → 哈希，跨事件/轮询两条路径认同一条兴趣。 */
export function contentHash(title: string, content: string): string {
  const norm = (s: string) => (s ?? '').replace(/\s+/g, '').toLowerCase()
  return createHash('sha1').update(`${norm(title)}|${norm(content)}`).digest('hex').slice(0, 24)
}

export interface InterestRow {
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
  content_hash: string
}

export interface FeedItemRow {
  id: number
  title: string
  content: string
  format: string
  source_url: string
  created_at: number
  liked: number
  skipped: number
  content_type: string
  image_url: string
  video_url: string
  interest_id: number
}

export function createDb(dbDir: string) {
  mkdirSync(dbDir, { recursive: true })
  const dbPath = join(dbDir, 'feed.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS feed_item (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      title        TEXT NOT NULL,
      content      TEXT NOT NULL,
      format       TEXT NOT NULL DEFAULT 'short',
      source_url   TEXT DEFAULT '',
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      liked        INTEGER NOT NULL DEFAULT 0,
      skipped      INTEGER NOT NULL DEFAULT 0,
      content_type TEXT NOT NULL DEFAULT 'text',
      image_url    TEXT NOT NULL DEFAULT '',
      video_url    TEXT NOT NULL DEFAULT '',
      interest_id  INTEGER NOT NULL DEFAULT 0
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS interest (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id         TEXT,
      content_hash      TEXT NOT NULL UNIQUE,
      title             TEXT NOT NULL,
      content           TEXT NOT NULL,
      keywords          TEXT DEFAULT '[]',
      level             TEXT DEFAULT '',
      importance        INTEGER DEFAULT 0,
      status            TEXT NOT NULL DEFAULT 'active',
      skip_reason       TEXT DEFAULT '',
      source            TEXT DEFAULT 'event',
      created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
      last_generated_at INTEGER DEFAULT 0,
      gen_count         INTEGER DEFAULT 0,
      like_count        INTEGER DEFAULT 0,
      skip_count        INTEGER DEFAULT 0
    )
  `)

  // ── Schema 迁移：旧表补列 ─────────────────────────────────────────────
  const cols = db.prepare(`PRAGMA table_info(feed_item)`).all() as any[]
  if (!cols.some(c => c.name === 'content_type')) {
    db.exec(`ALTER TABLE feed_item ADD COLUMN content_type TEXT NOT NULL DEFAULT 'text'`)
    db.exec(`ALTER TABLE feed_item ADD COLUMN image_url TEXT NOT NULL DEFAULT ''`)
    logger.info('migrated schema: added content_type and image_url columns')
  }
  if (!cols.some(c => c.name === 'video_url')) {
    db.exec(`ALTER TABLE feed_item ADD COLUMN video_url TEXT NOT NULL DEFAULT ''`)
    logger.info('migrated schema: added video_url column')
  }
  if (!cols.some(c => c.name === 'interest_id')) {
    db.exec(`ALTER TABLE feed_item ADD COLUMN interest_id INTEGER NOT NULL DEFAULT 0`)
    logger.info('migrated schema: added interest_id column')
  }

  const stmts = {
    // feed
    getFeed: db.prepare(
      `SELECT id, title, content, format, source_url, created_at, liked, skipped, content_type, image_url, video_url, interest_id
       FROM feed_item WHERE skipped = 0 ORDER BY created_at DESC`,
    ),
    countUnshown: db.prepare(`SELECT count(*) AS cnt FROM feed_item WHERE skipped = 0 AND liked = 0`),
    like: db.prepare(`UPDATE feed_item SET liked = 1 WHERE id = ?`),
    skip: db.prepare(`UPDATE feed_item SET skipped = 1 WHERE id = ?`),
    insertFeed: db.prepare(
      `INSERT INTO feed_item (title, content, format, source_url, content_type, image_url, video_url, interest_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    countAllFeed: db.prepare(`SELECT count(*) AS cnt FROM feed_item`),

    // interest
    upsertInterest: db.prepare(`
      INSERT INTO interest (content_hash, memory_id, title, content, keywords, level, importance, source, status)
      VALUES (@content_hash, @memory_id, @title, @content, @keywords, @level, @importance, @source, 'active')
      ON CONFLICT(content_hash) DO UPDATE SET
        title = excluded.title,
        content = excluded.content,
        keywords = excluded.keywords,
        level = excluded.level,
        importance = excluded.importance,
        memory_id = COALESCE(interest.memory_id, excluded.memory_id)
    `),
    getInterestByHash: db.prepare(`SELECT * FROM interest WHERE content_hash = ?`),
    getInterest: db.prepare(`SELECT * FROM interest WHERE id = ?`),
    listInterests: db.prepare(
      `SELECT * FROM interest WHERE status != 'skipped' ORDER BY importance DESC, created_at DESC LIMIT 200`,
    ),
    listAllInterests: db.prepare(`SELECT * FROM interest ORDER BY created_at DESC`),
    setInterestStatus: db.prepare(`UPDATE interest SET status = ?, skip_reason = ? WHERE id = ?`),
    deleteInterest: db.prepare(`DELETE FROM interest WHERE id = ?`),
    markGenerated: db.prepare(
      `UPDATE interest SET last_generated_at = ?, gen_count = gen_count + 1 WHERE id = ?`,
    ),
    // 生成候选：active 且超过再生成窗口（或从未生成）
    listGenCandidates: db.prepare(`
      SELECT * FROM interest
      WHERE status = 'active'
      ORDER BY importance DESC, last_generated_at ASC
      LIMIT ?
    `),
  }

  return { db, stmts }
}

export type DbHandle = ReturnType<typeof createDb>
