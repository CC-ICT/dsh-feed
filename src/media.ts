/**
 * dsh-feed — 图片/视频生成（内网 / 万相 dashscope）。
 *
 * 配置运行时从 readCfg() 读（volatile 根 config 不进 apply 参数，见 config.ts）。
 */
import { randomUUID } from 'node:crypto'
import { writeFileSync, statSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import https from 'node:https'
import * as logger from './log'

type ReadCfg = () => {
  imageProvider: string
  internal: { baseUrl: string; apiKey: string; imageModel: string }
  wanx: { baseUrl: string; apiKey: string; imageModel: string; videoModel: string }
}

export function createMedia(readCfg: ReadCfg, imagesDir: string, videosDir: string) {
  mkdirSync(imagesDir, { recursive: true })
  mkdirSync(videosDir, { recursive: true })

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  /** 下载文件到本地 */
  function downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          downloadFile(res.headers.location!, destPath).then(resolve, reject); return
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`download HTTP ${res.statusCode}`)); return
        }
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => { writeFileSync(destPath, Buffer.concat(chunks)); resolve() })
        res.on('error', reject)
      }).on('error', reject)
    })
  }

  /** DashScope POST（带 X-DashScope-Async header） */
  function dashscopePost(url: string, body: any, apiKey: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body)
      const u = new URL(url)
      const req = https.request({
        hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'X-DashScope-Async': 'enable',
          'Content-Length': Buffer.byteLength(data),
        },
      }, (res) => {
        let buf = ''
        res.on('data', (chunk) => { buf += chunk })
        res.on('end', () => {
          try {
            const json = JSON.parse(buf)
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`DashScope HTTP ${res.statusCode}: ${JSON.stringify(json).slice(0, 300)}`))
            } else resolve(json)
          } catch { reject(new Error(`DashScope parse error: ${buf.slice(0, 200)}`)) }
        })
      })
      req.on('error', reject)
      req.write(data); req.end()
    })
  }

  /** DashScope GET */
  function dashscopeGet(url: string, apiKey: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const u = new URL(url)
      https.get({
        hostname: u.hostname, port: 443, path: u.pathname + u.search,
        headers: { 'Authorization': `Bearer ${apiKey}` },
      }, (res) => {
        let buf = ''
        res.on('data', (chunk) => { buf += chunk })
        res.on('end', () => {
          try { resolve(JSON.parse(buf)) }
          catch { reject(new Error(`DashScope parse error: ${buf.slice(0, 200)}`)) }
        })
      }).on('error', reject)
    })
  }

  /** 生成图片：按 imageProvider 分派，返回 /dsh-feed/images/xxx 本地服务路径 */
  async function generateImage(prompt: string): Promise<string> {
    if (readCfg().imageProvider === 'wanx') return generateImageWanx(prompt)
    return generateImageInternal(prompt)
  }

  /** 内网 cntxt2image：同步生成 → fs/getFile 下载到本地 */
  async function generateImageInternal(prompt: string): Promise<string> {
    const cfg = readCfg()
    const INTERNAL_BASE = cfg.internal.baseUrl
    const INTERNAL_API_KEY = cfg.internal.apiKey
    if (!INTERNAL_API_KEY) throw new Error('内网 apiKey 未配置（设置界面填入后重启）')
    logger.info('内网图片：提交生成，prompt=%s', prompt.slice(0, 60))
    const res = await fetch(`${INTERNAL_BASE}/api/v1/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${INTERNAL_API_KEY}` },
      body: JSON.stringify({
        model: cfg.internal.imageModel, prompt, n: 1, ratio: '1:1',
        waterMarkLevel: 0, enhancePrompt: true, auditSwitch: true,
      }),
      signal: AbortSignal.timeout(120000),
    })
    const data: any = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`internal image HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`)
    const fileKey = data?.data?.[0]?.url
    if (!fileKey) throw new Error(`internal image no url: ${JSON.stringify(data).slice(0, 200)}`)
    const dlRes = await fetch(`${INTERNAL_BASE}/api/v1/fs/getFile?key=${encodeURIComponent(fileKey)}`, {
      headers: { 'Authorization': `Bearer ${INTERNAL_API_KEY}` },
      signal: AbortSignal.timeout(60000),
    })
    if (!dlRes.ok) throw new Error(`internal image download HTTP ${dlRes.status}`)
    const buf = Buffer.from(await dlRes.arrayBuffer())
    const filename = `${randomUUID()}.jpg`
    writeFileSync(join(imagesDir, filename), buf)
    logger.info('内网图片：已保存 %s (%d KB)', filename, buf.length / 1024)
    return `/dsh-feed/images/${filename}`
  }

  /** 调用万相生成图片，下载到本地，返回服务路径 */
  async function generateImageWanx(prompt: string): Promise<string> {
    const cfg = readCfg()
    const WANX_BASE = cfg.wanx.baseUrl
    const WANX_API_KEY = cfg.wanx.apiKey
    if (!WANX_API_KEY) throw new Error('万相 apiKey 未配置（设置界面填入后重启）')
    logger.info('万相：提交生成任务，prompt=%s', prompt.slice(0, 60))
    const createRes = await dashscopePost(
      `${WANX_BASE}/api/v1/services/aigc/text2image/image-synthesis`,
      { model: cfg.wanx.imageModel, input: { prompt }, parameters: { size: '1024*1024', n: 1, prompt_extend: true } },
      WANX_API_KEY,
    )
    const taskId = createRes.output?.task_id
    if (!taskId) throw new Error(`no task_id in response: ${JSON.stringify(createRes).slice(0, 200)}`)
    logger.info('万相：任务已创建 %s，轮询中...', taskId)
    const deadline = Date.now() + 300000
    while (Date.now() < deadline) {
      await sleep(3000)
      const pollData = await dashscopeGet(`${WANX_BASE}/api/v1/tasks/${taskId}`, WANX_API_KEY)
      const status = pollData.output?.task_status
      if (status === 'SUCCEEDED') {
        const imageUrl = pollData.output?.results?.[0]?.url
        if (!imageUrl) throw new Error('task succeeded but no image URL')
        logger.info('万相：生成成功，下载图片...')
        const filename = `${randomUUID()}.png`
        const localPath = join(imagesDir, filename)
        await downloadFile(imageUrl, localPath)
        logger.info('万相：图片已保存 %s (%d KB)', filename, statSync(localPath).size / 1024)
        return `/dsh-feed/images/${filename}`
      }
      if (status === 'FAILED') {
        throw new Error(`wanx task failed: ${pollData.output?.message || pollData.message || 'unknown error'}`)
      }
    }
    throw new Error('wanx task timed out (5min)')
  }

  /** 调用万相生成视频，下载到本地，返回服务路径 */
  async function generateVideo(prompt: string): Promise<string> {
    const cfg = readCfg()
    const WANX_BASE = cfg.wanx.baseUrl
    const WANX_API_KEY = cfg.wanx.apiKey
    if (!WANX_API_KEY) throw new Error('万相 apiKey 未配置（设置界面填入后重启）')
    logger.info('万相视频：提交生成任务，prompt=%s', prompt.slice(0, 60))
    const createRes = await dashscopePost(
      `${WANX_BASE}/api/v1/services/aigc/video-generation/video-synthesis`,
      { model: cfg.wanx.videoModel, input: { prompt }, parameters: { resolution: '480P', prompt_extend: false } },
      WANX_API_KEY,
    )
    const taskId = createRes.output?.task_id
    if (!taskId) throw new Error(`no task_id in response: ${JSON.stringify(createRes).slice(0, 200)}`)
    logger.info('万相视频：任务已创建 %s，轮询中（视频约 45-60s）...', taskId)
    const deadline = Date.now() + 600000
    while (Date.now() < deadline) {
      await sleep(15000)
      const pollData = await dashscopeGet(`${WANX_BASE}/api/v1/tasks/${taskId}`, WANX_API_KEY)
      const status = pollData.output?.task_status
      if (status === 'SUCCEEDED') {
        const videoUrl = pollData.output?.video_url
        if (!videoUrl) throw new Error('video task succeeded but no video URL')
        logger.info('万相视频：生成成功，下载视频...')
        const filename = `${randomUUID()}.mp4`
        const localPath = join(videosDir, filename)
        await downloadFile(videoUrl, localPath)
        logger.info('万相视频：已保存 %s (%d KB)', filename, statSync(localPath).size / 1024)
        return `/dsh-feed/videos/${filename}`
      }
      if (status === 'FAILED') {
        throw new Error(`wanx video task failed: ${pollData.output?.message || pollData.message || 'unknown error'}`)
      }
    }
    throw new Error('wanx video task timed out (10min)')
  }

  return { generateImage, generateVideo }
}
