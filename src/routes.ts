/**
 * dsh-feed — webServer 路由注册。
 *
 * /feed, /status, /interests, /feed/:id/like|skip（带兴趣反馈聚合）,
 * /seed, /log-probe, /scan（手动触发扫描）, /client.js, /images/*, /videos/*,
 * HTML 注入 client.js。
 */
import type { Context } from 'cordis'
import { readFileSync, existsSync, createReadStream, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import type { DbHandle } from './db'
import { runScheduledScan, regenerateInterest, type GenDeps } from './generation'
import * as logger from './log'

export interface RouteDeps {
  db: DbHandle
  imagesDir: string
  videosDir: string
  clientBundlePath: string
  genDeps: GenDeps
}

export function registerRoutes(ctx: Context, deps: RouteDeps): void {
  const { db, imagesDir, videosDir, clientBundlePath, genDeps } = deps
  const likeAggStmt = db.db.prepare(
    `UPDATE interest SET like_count = like_count + 1
     WHERE id = (SELECT interest_id FROM feed_item WHERE id = ? AND interest_id != 0)`,
  )
  const skipAggStmt = db.db.prepare(
    `UPDATE interest SET skip_count = skip_count + 1
     WHERE id = (SELECT interest_id FROM feed_item WHERE id = ? AND interest_id != 0)`,
  )

  // GET /dsh-feed/feed
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact', path: '/dsh-feed/feed',
      handler: (_req, res) => {
        const items = db.stmts.getFeed.all() as any[]
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ items, hasMore: false }))
      },
    }), 'dsh-feed: /feed route')

  // GET /dsh-feed/interests（全部兴趣，含已跳过 + 判定理由，供前端透明展示）
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact', path: '/dsh-feed/interests',
      handler: (_req, res) => {
        const interests = db.stmts.listAllInterests.all() as any[]
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ interests, count: interests.length }))
      },
    }), 'dsh-feed: /interests route')

  // 兴趣操作：DELETE 删除 / POST pause|resume|regenerate
  // 无需担心和 /interests 冲突：DSH 路由「exact 胜过 prefix」，
  // /interests 精确路由会优先命中，本 prefix 只接 /interest/<id>/... 。
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix', path: '/dsh-feed/interest',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
        const match = url.pathname.match(/\/interest\/(\d+)\/(pause|resume|regenerate)$/)
        const deleteMatch = url.pathname.match(/\/interest\/(\d+)$/)
        try {
          if (req.method === 'DELETE' && deleteMatch) {
            db.stmts.deleteInterest.run(Number(deleteMatch[1]))
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true })); return
          }
          if (match && req.method === 'POST') {
            const id = Number(match[1])
            const action = match[2]
            if (action === 'pause') {
              db.stmts.setInterestStatus.run('paused', '用户手动暂停', id)
            } else if (action === 'resume') {
              db.stmts.setInterestStatus.run('active', '', id)
            } else if (action === 'regenerate') {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: true, message: 'regenerating in background' }))
              regenerateInterest(genDeps, id).catch((e) =>
                logger.warn('regenerate %d failed: %s', id, e?.message))
              return
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true })); return
          }
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'not found' }))
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e?.message ?? 'server error' }))
        }
      },
    }), 'dsh-feed: /interest/:id action route')

  // GET /dsh-feed/status
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact', path: '/dsh-feed/status',
      handler: (_req, res) => {
        const row = db.stmts.countUnshown.get() as any
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ unshown: row?.cnt ?? 0 }))
      },
    }), 'dsh-feed: /status route')

  // POST /dsh-feed/feed/:id/like|skip（聚合反馈到 interest）
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix', path: '/dsh-feed/feed',
      handler: (req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
        const match = url.pathname.match(/\/feed\/(\d+)\/(like|skip)$/)
        if (!match) { res.writeHead(404); res.end('not found'); return }
        const id = Number(match[1])
        if (match[2] === 'like') { db.stmts.like.run(id); likeAggStmt.run(id) }
        else { db.stmts.skip.run(id); skipAggStmt.run(id) }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      },
    }), 'dsh-feed: /feed/:id/like|skip route')

  // POST /dsh-feed/seed
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact', path: '/dsh-feed/seed',
      handler: async (req, res) => {
        let body = ''
        for await (const chunk of req) body += chunk
        try {
          const data = JSON.parse(body || '{}')
          if (data.title && data.content) {
            db.stmts.insertFeed.run(data.title, data.content, data.format ?? 'short', data.source_url ?? '', data.content_type ?? 'text', data.image_url ?? '', data.video_url ?? '', 0)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true }))
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'title and content required' }))
          }
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid JSON' }))
        }
      },
    }), 'dsh-feed: /seed route')

  // POST /dsh-feed/scan（手动触发定时扫描）
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact', path: '/dsh-feed/scan',
      handler: async (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, message: 'scan started in background' }))
        runScheduledScan(genDeps).catch((e) => logger.warn('manual scan failed: %s', e?.message))
      },
    }), 'dsh-feed: /scan route')

  // POST /dsh-feed/log-probe（客户端诊断打到终端原生 stdout）
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact', path: '/dsh-feed/log-probe',
      handler: async (req, res) => {
        let body = ''
        for await (const chunk of req) body += chunk
        try {
          const data = JSON.parse(body || '{}')
          console.log('\n[dsh-feed:log-probe] ─────────────────────────')
          console.log('[dsh-feed:log-probe] payload:', JSON.stringify(data, null, 0))
          console.log('[dsh-feed:log-probe] ──────────────────────────\n')
        } catch (e: any) {
          console.log('[dsh-feed:log-probe] parse failed:', body?.slice?.(0, 500) ?? body, e?.message)
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      },
    }), 'dsh-feed: /log-probe route')

  // GET /dsh-feed/images/*
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix', path: '/dsh-feed/images',
      handler: (req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
        const match = url.pathname.match(/\/images\/(.+)$/)
        const filename = match ? match[1] : ''
        if (!filename || filename.includes('..')) { res.writeHead(403); res.end('forbidden'); return }
        const imagePath = join(imagesDir, filename)
        if (!existsSync(imagePath)) { res.writeHead(404); res.end('not found'); return }
        const ext = extname(filename).toLowerCase()
        const contentType = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream'
        const stat = statSync(imagePath)
        res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stat.size, 'Cache-Control': 'public, max-age=86400' })
        createReadStream(imagePath).pipe(res)
      },
    }), 'dsh-feed: /images/ route')

  // GET /dsh-feed/videos/*（支持 Range）
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix', path: '/dsh-feed/videos',
      handler: (req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
        const match = url.pathname.match(/\/videos\/(.+)$/)
        const filename = match ? match[1] : ''
        if (!filename || filename.includes('..')) { res.writeHead(403); res.end('forbidden'); return }
        const videoPath = join(videosDir, filename)
        if (!existsSync(videoPath)) { res.writeHead(404); res.end('not found'); return }
        const ext = extname(filename).toLowerCase()
        const contentType = ext === '.mp4' ? 'video/mp4' : 'application/octet-stream'
        const stat = statSync(videoPath)
        const range = req.headers.range
        if (range) {
          const bytes = /bytes=(\d*)-(\d*)/.exec(range)
          if (bytes) {
            const start = bytes[1] ? parseInt(bytes[1], 10) : 0
            const end = bytes[2] ? parseInt(bytes[2], 10) : stat.size - 1
            if (start >= stat.size || end >= stat.size) {
              res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
              res.end(); return
            }
            res.writeHead(206, {
              'Content-Type': contentType, 'Content-Range': `bytes ${start}-${end}/${stat.size}`,
              'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400',
            })
            createReadStream(videoPath, { start, end }).pipe(res); return
          }
        }
        res.writeHead(200, {
          'Content-Type': contentType, 'Content-Length': stat.size,
          'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400',
        })
        createReadStream(videoPath).pipe(res)
      },
    }), 'dsh-feed: /videos/ route')

  // GET /dsh-feed/client.js
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact', path: '/dsh-feed/client.js',
      handler: (_req, res) => {
        try {
          const content = readFileSync(clientBundlePath, 'utf-8')
          res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' })
          res.end(content)
        } catch (e: any) {
          res.writeHead(500)
          res.end(`// client bundle not found: ${e.message}`)
        }
      },
    }), 'dsh-feed: client.js route')

  // HTML 注入 client.js
  ctx.effect(() => {
    const off = ctx.on('webserver/index-inject' as any, (table: any[]) => {
      table.push({ kind: 'script-src' as any, placement: 'body' as any, src: '/dsh-feed/client.js' })
    })
    return off
  }, 'dsh-feed: HTML injection')
}
