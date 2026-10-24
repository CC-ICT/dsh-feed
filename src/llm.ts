/** dsh-feed — LLM 流式调用。 */
import type { Context } from 'cordis'
import * as logger from './log'

/** 调用 LLM 流式生成，返回完整文本。 */
export function createLlm(ctx: Context, readCfg: () => { llm: { provider: string; model: string } }) {
  return async function callLlm(system: string, user: string, temperature = 0.7): Promise<string> {
    const llm = ctx.get('llm') as any
    if (!llm || typeof llm.stream !== 'function') {
      throw new Error('llm service not available')
    }
    const llmCfgLive = readCfg().llm
    const assembler: string[] = []
    for await (const chunk of llm.stream({
      provider: llmCfgLive.provider,
      model: llmCfgLive.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text' as const, text: user }] }],
      temperature,
    })) {
      if (chunk?.type === 'text-delta') assembler.push(chunk.text)
    }
    return assembler.join('')
  }
}
