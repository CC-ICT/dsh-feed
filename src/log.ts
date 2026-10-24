/**
 * dsh-feed — 简易日志工具。
 *
 * ctx.logger 不输出到 stdout，调试时看不到。这里用 console.log 输出带时间戳的日志。
 */

function ts(): string {
  return new Date().toISOString().slice(11, 19) // HH:MM:SS
}

/** 简易 printf：处理 %s %d，其余参数直接拼接 */
function fmt(str: string, args: any[]): string {
  let i = 0
  return str.replace(/%[sdfj]/g, () => {
    const v = args[i++]
    return v === undefined || v === null ? '' : String(v)
  })
}

export function info(message: string, ...args: any[]): void {
  console.log(`[${ts()}] [dsh-feed] ${fmt(message, args)}`)
}

export function warn(message: string, ...args: any[]): void {
  console.warn(`[${ts()}] [dsh-feed] WARN ${fmt(message, args)}`)
}

export function error(message: string, ...args: any[]): void {
  console.error(`[${ts()}] [dsh-feed] ERROR ${fmt(message, args)}`)
}
