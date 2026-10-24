/**
 * dsh-feed — meow-memory 读取（readonly 直读 memory.db）。
 *
 * meow-memory 0.4.2 起记忆库改为全局唯一：activeHomeDir()/.dsh-personal-memory/
 * memory.db（workspace 参数已废弃，历史各工作区 .dsh-meow/memory.db 启动时合并）。
 * 但用户机器上可能并存新旧布局、多个项目工作区。故不写死单一路径，而是：
 *   收集候选根目录 → 有界递归找 memory.db → realpath 去重 → 逐个读 → 按 id 去重合并。
 *
 * 候选根：meow 全局家目录 / DSH storages / 配置工作区 / 工作区父目录（覆盖所有项目空间）。
 */
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import Database from 'better-sqlite3'
import * as logger from './log'

const MEOW_TABLES = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules'] as const

/** 递归会跳过的目录（避免误入 node_modules / .git 等）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.cache', '.trash'])

export interface MemoryRow {
  level: string
  id: string
  title: string | null
  content: string
  importance: number
  keywords: string[]
  project: string | null
}

/** 候选根目录：覆盖 meow 全局家目录 + DSH storages + 配置工作区 + 工作区父目录（所有项目空间）。 */
function candidateRoots(workspaceDir?: string): string[] {
  const home = homedir()
  const roots = new Set<string>()
  const add = (p?: string) => {
    if (!p) return
    try { if (existsSync(p)) roots.add(resolve(p)) } catch { /* skip */ }
  }
  // meow-memory 全局家目录（env 优先，缺省 ~/.dsh-personal-memory）
  add(process.env.DSH_PERSONAL_MEMORY_HOME ?? join(home, '.dsh-personal-memory'))
  // DSH storages 预设落点
  add(join(home, '.dsh', 'storages', 'dsh-personal-memory'))
  // 配置工作区本身（可能 .dsh-meow 或 .dsh-personal-memory 直接挂在下面）
  add(workspaceDir)
  add(process.env.DSH_WORKSPACE)
  // 工作区父目录：覆盖所有项目空间子目录（每个项目工作区的 .dsh-meow 都扫到）
  const wsParent = workspaceDir ? dirname(resolve(workspaceDir)) : join(home, 'Documents', 'deepseek-harness')
  add(wsParent)
  return [...roots]
}

/** 在给定根目录下有界递归查找 memory.db。找到一个即停止下钻（其兄弟目录继续）。 */
function findMemoryDbs(roots: string[]): string[] {
  const found = new Set<string>()
  const visit = (dir: string, depth: number) => {
    if (depth > 4) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    // 本目录有 memory.db → 记录（realpath 去重跨根重复）并不再下钻
    if (entries.some(e => e.isFile() && e.name === 'memory.db')) {
      try { found.add(realpathSync(join(dir, 'memory.db'))) } catch { /* skip */ }
      return
    }
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) {
        visit(join(dir, e.name), depth + 1)
      }
    }
  }
  for (const r of roots) visit(r, 0)
  return [...found]
}

/** 读单个 memory.db 的全部记忆表。 */
function readDb(dbPath: string): MemoryRow[] {
  let meowDb: Database.Database | null = null
  const results: MemoryRow[] = []
  try {
    meowDb = new Database(dbPath, { readonly: true })
    meowDb.pragma('journal_mode = WAL')
    for (const table of MEOW_TABLES) {
      const tableCheck = meowDb.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
      ).get(table) as any
      if (!tableCheck) continue
      const hasProjectCol = meowDb.prepare(`PRAGMA table_info(${table})`).all()
        .some((col: any) => col.name === 'project')
      const sql = hasProjectCol
        ? `SELECT id, title, content, importance, keywords, project
           FROM ${table} WHERE status = 'active'
           ORDER BY importance DESC, updated_at DESC LIMIT 50`
        : `SELECT id, title, content, importance, keywords, NULL as project
           FROM ${table} WHERE status = 'active'
           ORDER BY importance DESC, updated_at DESC LIMIT 50`
      const rows = meowDb.prepare(sql).all() as any[]
      for (const row of rows) {
        let keywords: string[] = []
        try { keywords = JSON.parse(row.keywords ?? '[]') } catch { /* keep [] */ }
        results.push({
          level: table,
          id: row.id,
          title: row.title,
          content: row.content,
          importance: row.importance ?? 1,
          keywords,
          project: row.project ?? null,
        })
      }
    }
    return results
  } catch (e: any) {
    logger.warn('failed to read memory.db %s: %s', dbPath, e.message)
    return []
  } finally {
    meowDb?.close()
  }
}

/**
 * 遍历所有候选根目录找 memory.db，逐个读，按 id 去重合并。
 * workspaceDir 作为额外候选根传入（配置的工作区）。
 */
export function readMeowMemories(workspaceDir?: string): MemoryRow[] {
  const roots = candidateRoots(workspaceDir)
  const dbs = findMemoryDbs(roots)
  if (dbs.length === 0) {
    logger.info('扫描：未在任何候选根找到 memory.db（roots=%j）', roots)
    return []
  }
  logger.info('扫描：找到 %d 个 memory.db：%j', dbs.length, dbs)
  const results: MemoryRow[] = []
  const seen = new Set<string>()
  for (const dbPath of dbs) {
    for (const row of readDb(dbPath)) {
      if (!seen.has(row.id)) { seen.add(row.id); results.push(row) }
    }
  }
  return results
}
