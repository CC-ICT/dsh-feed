/**
 * dsh-feed — 兴趣分类器。
 *
 * 判定一条记忆是否适合用来生成个性化内容：
 *   适合（interested=true）：爱好、偏好、关注领域/题材/作品、正在学的东西、观点倾向。
 *   不适合（interested=false）：人口学事实（姓名/年龄/性别/出生地/职业头衔）、
 *     家人/人际关系、纯身份信息、临时状态、太泛或太私密的琐事。
 *
 * 一次廉价 LLM 调用；解析失败 fail-open（默认感兴趣，不误杀）。
 */
import * as logger from './log'

type CallLlm = (system: string, user: string, temperature?: number) => Promise<string>

const CLASSIFY_SYSTEM = `你判断一条用户记忆是否适合用来生成"个性化推荐内容"（进阶文章/图片/视频）。

适合的：爱好、偏好、关注的领域/题材/作品、正在学的东西、观点倾向、品味取向（如"最近喜欢毛不易""在学Rust异步""爱看成龙电影""对成都苍蝇馆子感兴趣""偏好走心派听歌"）。
不适合的：人口学事实（姓名、年龄、性别、出生地、职业头衔）、家人/人际关系、纯身份信息、临时状态、太泛或太私密、无法延展成内容的琐事。

只输出一个 JSON 对象，不要 markdown 代码块、不要解释：
{"interested": true, "reason": "一句话理由"}
或
{"interested": false, "reason": "一句话理由"}`

export interface ClassifyResult {
  interested: boolean
  reason: string
}

export function createClassifier(callLlm: CallLlm) {
  return async function classifyInterest(
    title: string, content: string, keywords: string[],
  ): Promise<ClassifyResult> {
    const user = `记忆标题：${title}\n关键词：${keywords.join('、')}\n完整记录：${content.slice(0, 300)}`
    try {
      const raw = await callLlm(CLASSIFY_SYSTEM, user, 0.1)
      // 容错：剥掉可能的 markdown 代码块
      const cleaned = raw.replace(/```json|```/g, '').trim()
      const match = cleaned.match(/\{[\s\S]*\}/)
      if (match) {
        try {
          const obj = JSON.parse(match[0])
          return { interested: !!obj.interested, reason: String(obj.reason ?? '') }
        } catch { /* fall through */ }
      }
      logger.warn('[分类] 解析失败，fail-open（默认感兴趣）：%s', raw.slice(0, 100))
      return { interested: true, reason: '分类解析失败，默认感兴趣' }
    } catch (e: any) {
      logger.warn('[分类] LLM 调用失败，fail-open：%s', e.message)
      return { interested: true, reason: `分类调用失败：${e.message}` }
    }
  }
}

export type Classify = ReturnType<typeof createClassifier>
