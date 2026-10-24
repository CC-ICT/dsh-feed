/**
 * dsh-feed — Config schema + 运行时 live config 读取。
 *
 * volatile 根 schema 的 patch config 不通过 apply 的 config 参数传
 * （config2 实际为空），生成函数运行时从 ctx.settings.describe() 读
 * resolved config（.value 含 user 层真值）——仿 meow-memory liveConfigReader。
 */
import type { Context } from 'cordis'
import z from '@deepseek-ai/schemastery'

const SETTINGS_NS = 'dsh-feed'

export interface Config {
  imageProvider: 'jiutian' | 'wanx'
  jiutian: { baseUrl: string; apiKey: string; imageModel: string }
  wanx: { baseUrl: string; apiKey: string; imageModel: string; videoModel: string }
  llm: { provider: string; model: string }
  feed: { scanIntervalMinutes: number; maxGeneratePerScan: number; regenIntervalHours: number }
}

export const Config: z<Config> = z.object({
  imageProvider: z.union(['jiutian', 'wanx'])
    .default('jiutian').description('图片生成 provider（jiutian 走九天，wanx 走万相）'),
  jiutian: z.object({
    baseUrl: z.string().default('http://moma.hq.cmcc/largemodel/moma').description('九天 moma base URL'),
    apiKey: z.string().default('').description('九天 API key（未填则图片生成跳过）'),
    imageModel: z.string().default('cntxt2image').description('九天文生图模型'),
  }).default({}),
  wanx: z.object({
    baseUrl: z.string().default('https://dashscope.aliyuncs.com').description('万相 base URL'),
    apiKey: z.string().default('').description('万相 API key（未填则图片/视频生成跳过）'),
    imageModel: z.string().default('wanx2.1-t2i-turbo').description('万相图片模型'),
    videoModel: z.string().default('wanx2.1-t2v-turbo').description('万相视频模型'),
  }).default({}),
  llm: z.object({
    provider: z.string().default('bailian-coding').description('LLM provider'),
    model: z.string().default('glm-5.2').description('LLM model'),
  }).default({}),
  feed: z.object({
    scanIntervalMinutes: z.number().default(10).description('定时扫描 meow-memory 挑兴趣生成的间隔（分钟）'),
    maxGeneratePerScan: z.number().default(3).description('每次扫描最多生成几条内容（控成本）'),
    regenIntervalHours: z.number().default(12).description('同一兴趣距上次生成多久后可再生成（小时）'),
  }).default({}),
})
// 仓内 schemastery 的 .volatile() 不可靠；照 meow-memory：根上 Object.assign
// 设 meta.volatile，子字段一律不标（否则触发 "enclosing volatile field" 错）。
Object.assign(Config.meta, { volatile: true })

const FALLBACK = {
  imageProvider: 'jiutian' as const,
  jiutian: { baseUrl: 'http://moma.hq.cmcc/largemodel/moma', apiKey: '', imageModel: 'cntxt2image' },
  wanx: { baseUrl: 'https://dashscope.aliyuncs.com', apiKey: '', imageModel: 'wanx2.1-t2i-turbo', videoModel: 'wanx2.1-t2v-turbo' },
  llm: { provider: 'bailian-coding', model: 'glm-5.2' },
  feed: { scanIntervalMinutes: 10, maxGeneratePerScan: 3, regenIntervalHours: 12 },
}

/** 运行时读 resolved config：ctx.settings.describe() → dsh-feed namespace → .value，
 *  合并 FALLBACK（嵌套默认未必进 value）+ apply 收到的 patch config2（兜底）。 */
export function readLiveConfig(ctx: Context, config: Config) {
  return (): {
    imageProvider: string
    jiutian: any
    wanx: any
    llm: any
    feed: { scanIntervalMinutes: number; maxGeneratePerScan: number; regenIntervalHours: number }
  } => {
    let live: any
    try {
      const svc = (ctx as any).settings
      if (svc && typeof svc.describe === 'function') {
        const rows = svc.describe()
        const row = Array.isArray(rows) ? rows.find((r: any) => r?.ns === SETTINGS_NS) : undefined
        live = row?.value
      }
    } catch { live = undefined }
    const merge = (fb: any, ov: any) => ({ ...fb, ...(ov ?? {}) })
    return {
      imageProvider: live?.imageProvider ?? config.imageProvider ?? FALLBACK.imageProvider,
      jiutian: merge(FALLBACK.jiutian, { ...(config.jiutian ?? {}), ...(live?.jiutian ?? {}) }),
      wanx: merge(FALLBACK.wanx, { ...(config.wanx ?? {}), ...(live?.wanx ?? {}) }),
      llm: merge(FALLBACK.llm, { ...(config.llm ?? {}), ...(live?.llm ?? {}) }),
      feed: merge(FALLBACK.feed, { ...(config.feed ?? {}), ...(live?.feed ?? {}) }),
    }
  }
}

export { SETTINGS_NS }
