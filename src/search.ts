/** dsh-feed — Web 搜索（Bing 抓取标题+摘要）。 */
import https from 'node:https'
import * as logger from './log'

export function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        fetchUrl(res.headers.location!).then(resolve, reject); return
      }
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => resolve(data))
      res.on('error', reject)
    }).on('error', reject)
  })
}

export async function webSearch(query: string): Promise<string> {
  try {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`
    const html = await fetchUrl(url)
    const titles: string[] = []
    const titleMatches = html.matchAll(/<h2><a[^>]*>(.*?)<\/a><\/h2>/gs)
    for (const m of titleMatches) {
      const clean = m[1].replace(/<[^>]+>/g, '').trim()
      if (clean && clean.length > 5) titles.push(clean)
    }
    const snippets: string[] = []
    const snippetMatches = html.matchAll(/class="b_caption"[^>]*>[\s\S]*?<p[^>]*>(.*?)<\/p>/gs)
    for (const m of snippetMatches) {
      const clean = m[1].replace(/<[^>]+>/g, '').trim()
      if (clean && clean.length > 20) snippets.push(clean)
    }
    if (titles.length === 0 && snippets.length === 0) return ''
    let result = '搜索结果：\n'
    const count = Math.min(titles.length, snippets.length, 5)
    for (let i = 0; i < count; i++) result += `${i + 1}. ${titles[i]}：${snippets[i]}\n`
    for (let i = count; i < Math.min(titles.length, 8); i++) result += `${i + 1}. ${titles[i]}\n`
    return result
  } catch (e: any) {
    logger.warn('web search failed: %s', e.message)
    return ''
  }
}
