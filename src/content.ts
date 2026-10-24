/**
 * dsh-feed — 内容生成（纯文本/纯图片/图文/纯视频）。
 *
 * LLM 自主决定搜不搜、搜什么（干净 query），再写进阶文章 / 出图 / 出视频。
 */
import * as logger from './log'
import { webSearch } from './search'

type CallLlm = (system: string, user: string, temperature?: number) => Promise<string>
type GenImage = (prompt: string) => Promise<string>
type GenVideo = (prompt: string) => Promise<string>

export interface GenResult {
  title: string
  content: string
  content_type: 'text' | 'image' | 'text_image' | 'video'
  image_url: string
  video_url?: string
}

const TEXT_SYSTEM_PROMPT = `你是个性化内容推荐官。你会收到用户的一条记忆/兴趣陈述（可能口语化，如"最近喜欢看成龙电影""最近在学Rust异步"）。

任务：生成一条用户**大概率还不知道、但会喜欢**的进阶内容。不是入门科普、不是历史简介、不是维基百科式介绍——跳过用户已知的基础，选冷门/意想不到/反直觉的角度。
- "在学Rust" → 不讲Rust是什么；讲几个不常见写法、容易踩的坑、一个反直觉的类型系统细节
- "喜欢看成龙电影" → 不讲成龙是谁；讲一部冷门成龙片、一个动作调度手法、一段幕后设计

规则：
1. 正文 200-400 字，不出现"用户/你/您/我们/咱们"等指代读者的词；不推荐不指导（不写"可以/应该/建议/不妨"），只陈述事实
2. 若附有搜索结果，只采用其中真实的事实，忽略无关词条（如某个词的同名歌曲、同名作品），不要照搬搜索措辞
3. 标题点出具体角度，不要泛泛的"关于X"，标题里也不要出现"用户"等词

输出格式（严格遵守，不要 markdown 代码块）：
标题：<不超过16字的干净标题；不要括号补充说明；不要"用户/你/您/我们"；必须完整、不截断>

正文：<200-400字正文>`

const IMAGE_PROMPT_SYSTEM = `You are a personalized visual recommender. Given the user's interest statement, write ONE detailed image generation prompt in English depicting a striking, specific scene FROM THE WORLD/SUBJECT the user is interested in — NOT the user themselves, and NOT the literal act of consuming it.

关键：解读用户感兴趣的那个领域/题材，画那个领域里的画面，不要字面复现记忆句里的动作。
- "喜欢看科幻小说" → 不要画"一个人在看书"；画科幻世界本身（异星地貌、星舰内部、赛博朋克街道、太空战役）
- "喜欢看成龙电影" → 不要画"成龙海报"或"看电影的人"；画一个功夫动作瞬间（雨夜屋顶上的鹤形拳、霓虹灯下的对峙）
- "对成都苍蝇馆子感兴趣" → 不要画"成都地图"；画一个具体的菜或街边摊瞬间

Describe visual scene, style, composition, colors, mood. 50-200 words. No text, names, or watermarks in the described image.

Output format (strict, no markdown):
标题：<a short Chinese title, ≤12 chars, no parenthetical asides, no "用户/你/您", complete not truncated>

<the English image prompt, 50-200 words, no prefix, no quotes, just the prompt text>`

const VIDEO_PROMPT_SYSTEM = `You are a personalized video recommender. Given the user's interest statement, write ONE continuous-shot cinematic video prompt in English depicting an evocative scene FROM THE WORLD/SUBJECT the user is interested in — NOT the user themselves, and NOT the literal act of consuming it.

关键：解读用户感兴趣的那个领域/题材，呈现那个领域里的高光画面，不要字面复现记忆句里的动作。喜欢科幻小说的人想看的是飞船、星球、高科技大场面，不是一个人捧着书。
- "喜欢看科幻小说" → "a lone spaceship drifting past a gas giant's ice rings, cockpit glow reflecting on the hull, distant nebula in violet and gold, slow dolly push, 35mm film grain"
- "喜欢看成龙电影" → "a martial artist practicing crane stance on a rain-slick rooftop at dawn, neon city below, slow-motion water droplets"

30-100 words. No text on screen, no captions, no cuts.

Output format (strict, no markdown):
标题：<a short Chinese title, ≤12 chars, no parenthetical asides, no "用户/你/您", complete not truncated>

<the English video prompt, 30-100 words, no prefix, no quotes, just the prompt text>`

/** 清洗并校验标题：太长/带人称代词/括号未闭合（多半是记忆原句被截断）→ 返回空（省略标题）。 */
function cleanTitle(raw: string): string {
  let t = (raw ?? '').trim().replace(/^["""'「」《]+|["""'」《]+$/g, '').trim()
  if (!t) return ''
  if (t.length > 20) return ''
  if (/用户|你|您|我们|咱们/.test(t)) return ''
  const open = (t.match(/（/g) || []).length
  const close = (t.match(/）/g) || []).length
  if (open !== close) return ''
  return t
}

/** 从 LLM 输出里拆出「标题：」首行 + 剩余正文/prompt。
 *  无标题行时 title='' body=原文（安全降级，不破坏后续 prompt 生成）。 */
function splitTitleAndBody(raw: string): { title: string; body: string } {
  const m = raw.match(/^标题[：:]\s*(.+)$/m)
  if (!m) return { title: '', body: raw.trim() }
  const title = cleanTitle(m[1])
  const idx = raw.indexOf(m[0])
  const body = raw.slice(idx + m[0].length).replace(/^[\s]*/, '').trim()
  return { title, body }
}

/** 让 LLM 提炼干净的搜索 query，或判定 NONE（不搜）。 */
async function planCleanQuery(
  callLlm: CallLlm, title: string, rawContent: string, keywords: string[],
): Promise<string> {
  try {
    const out = await callLlm(
      '你是一个搜索查询提炼器。给定一条记忆/兴趣陈述，输出一个干净的 Bing 搜索关键词（2-10字，去掉"最近/喜欢/觉得/我"等口语词、第一人称、括号、补充说明），用于查证该话题的真实事实。若该话题靠常识即可覆盖、或太主观无法搜索，则输出 NONE。只输出关键词或 NONE，不要其他文字。',
      `记忆句：${title}\n关键词：${keywords.join('、')}\n完整记录：${rawContent.slice(0, 200)}`,
      0.2,
    )
    const q = out.trim().replace(/^["""'「」]+|["""'「」]+$/g, '').trim()
    if (q && q.toUpperCase() !== 'NONE') return q
    return ''
  } catch (e: any) {
    logger.warn('[文本] query 提炼失败：%s，用 keywords 兜底', e.message)
    return keywords.length > 0 ? keywords.slice(0, 3).join(' ') : ''
  }
}

function articleUserPrompt(title: string, rawContent: string, keywords: string[], searchResults: string): string {
  const base = `关注点：${title}\n${keywords.length ? `关键词：${keywords.join('、')}` : ''}\n原始记录：${rawContent}\n\n请写一篇关于这个关注点的进阶短文。`
  return searchResults ? `${searchResults}\n\n${base}` : base
}

function parseArticle(fullText: string): { title: string; content: string } {
  const m = fullText.match(/^标题[：:]\s*(.+)$/m)
  let title = ''
  let rest = fullText
  if (m) {
    title = cleanTitle(m[1])
    const idx = fullText.indexOf(m[0])
    rest = fullText.slice(idx + m[0].length)
  }
  const contentMatch = rest.match(/正文[：:]\s*([\s\S]*)/)
  const content = (contentMatch?.[1] ?? rest).trim()
  return { title, content }
}

export function createContent(callLlm: CallLlm, generateImage: GenImage, generateVideo: GenVideo) {
  /** 纯文本：LLM 决定搜不搜 → 按需搜索 → 写进阶文章 */
  async function generateTextArticle(
    title: string, rawContent: string, keywords: string[],
  ): Promise<GenResult> {
    const searchQuery = await planCleanQuery(callLlm, title, rawContent, keywords)
    let searchResults = ''
    if (searchQuery) {
      logger.info('[文本] 搜索 query：%s', searchQuery)
      searchResults = await webSearch(searchQuery)
    } else {
      logger.info('[文本] 判定无需搜索，直接写')
    }
    const userPrompt = articleUserPrompt(title, rawContent, keywords, searchResults)
    logger.info('[文本] prompt=%s', userPrompt.replace(/\n/g, ' ').slice(0, 200))
    try {
      const fullText = await callLlm(TEXT_SYSTEM_PROMPT, userPrompt)
      const { title: t, content: c } = parseArticle(fullText)
      return { title: t, content: c || fullText.trim() || rawContent, content_type: 'text', image_url: '' }
    } catch (e: any) {
      logger.warn('[文本] LLM failed: %s, using raw', e.message)
      return { title: '', content: rawContent, content_type: 'text', image_url: '' }
    }
  }

  /** 纯图片：用 LLM 生成图片 prompt（含短标题），调用图模型生成图片 */
  async function generateImageOnly(
    title: string, rawContent: string, keywords: string[],
  ): Promise<GenResult | null> {
    let imagePrompt: string
    try {
      const promptUser = `Topic: ${title}\nKeywords: ${keywords.join(', ')}\nContext: ${rawContent.slice(0, 200)}`
      logger.info('[图片] 生成图片 prompt...')
      imagePrompt = await callLlm(IMAGE_PROMPT_SYSTEM, promptUser, 0.8)
      logger.info('[图片] prompt=%s', imagePrompt.slice(0, 80))
    } catch (e: any) {
      logger.warn('[图片] prompt 生成失败，用标题兜底：%s', e.message)
      imagePrompt = `${title}, detailed illustration, vibrant colors`
    }
    const { title: imgTitle, body: promptBody } = splitTitleAndBody(imagePrompt)
    const imageUrl = await generateImage(promptBody || imagePrompt)
    return { title: imgTitle, content: '', content_type: 'image', image_url: imageUrl }
  }

  /** 图文：并行生成文章 + 图片 */
  async function generateTextWithImage(
    title: string, rawContent: string, keywords: string[],
  ): Promise<GenResult | null> {
    logger.info('[图文] 并行生成文章 + 图片...')
    const [articleResult, imageResult] = await Promise.allSettled([
      (async () => {
        const searchQuery = await planCleanQuery(callLlm, title, rawContent, keywords)
        let searchResults = ''
        if (searchQuery) {
          logger.info('[图文] 文章分支：搜索 query %s', searchQuery)
          searchResults = await webSearch(searchQuery)
        } else {
          logger.info('[图文] 文章分支：无需搜索，直接写')
        }
        const userPrompt = articleUserPrompt(title, rawContent, keywords, searchResults)
        logger.info('[图文] 文章分支 prompt=%s', userPrompt.replace(/\n/g, ' ').slice(0, 200))
        const fullText = await callLlm(TEXT_SYSTEM_PROMPT, userPrompt)
        const { title: t, content: c } = parseArticle(fullText)
        logger.info('[图文] 文章分支完成')
        return { title: t, content: c || fullText.trim() || rawContent }
      })(),
      (async () => {
        let imagePrompt: string
        try {
          const promptUser = `Topic: ${title}\nKeywords: ${keywords.join(', ')}\nContext: ${rawContent.slice(0, 200)}`
          logger.info('[图文] 图片分支：生成 prompt...')
          imagePrompt = await callLlm(IMAGE_PROMPT_SYSTEM, promptUser, 0.8)
          logger.info('[图文] 图片分支：prompt=%s', imagePrompt.slice(0, 80))
        } catch (e: any) {
          logger.warn('[图文] 图片分支：prompt 生成失败，用标题兜底：%s', e.message)
          imagePrompt = `${title}, detailed illustration, vibrant colors`
        }
        const { body: promptBody } = splitTitleAndBody(imagePrompt)
        return generateImage(promptBody || imagePrompt)
      })(),
    ])

    if (articleResult.status === 'rejected') {
      logger.warn('[图文] 文章分支失败，整体跳过：%s', articleResult.reason?.message)
      return null
    }
    const article = articleResult.value
    if (imageResult.status === 'rejected') {
      logger.warn('[图文] 图片分支失败，降级为纯文本：%s', imageResult.reason?.message)
      return { title: article.title, content: article.content, content_type: 'text', image_url: '' }
    }
    return { title: article.title, content: article.content, content_type: 'text_image', image_url: imageResult.value }
  }

  /** 纯视频：用 LLM 生成视频 prompt，调用万相生成视频 */
  async function generateVideoOnly(
    title: string, rawContent: string, keywords: string[],
  ): Promise<GenResult | null> {
    let videoPrompt: string
    try {
      const promptUser = `Topic: ${title}\nKeywords: ${keywords.join(', ')}\nContext: ${rawContent.slice(0, 200)}`
      logger.info('[视频] 生成视频 prompt...')
      videoPrompt = await callLlm(VIDEO_PROMPT_SYSTEM, promptUser, 0.8)
      logger.info('[视频] prompt=%s', videoPrompt.slice(0, 80))
    } catch (e: any) {
      logger.warn('[视频] prompt 生成失败，用标题兜底：%s', e.message)
      videoPrompt = `${title}, cinematic shot, soft lighting, detailed`
    }
    const { title: vidTitle, body: promptBody } = splitTitleAndBody(videoPrompt)
    const videoUrl = await generateVideo(promptBody || videoPrompt)
    return { title: vidTitle, content: '', content_type: 'video', image_url: '', video_url: videoUrl }
  }

  return { generateTextArticle, generateImageOnly, generateTextWithImage, generateVideoOnly }
}

export type ContentGen = ReturnType<typeof createContent>
