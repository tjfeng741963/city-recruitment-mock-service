import http from '../api/http'

/**
 * 聊天里的图片/附件消息：内容形如 `###图片（xxx.jpg）`。
 * 两种来源：
 * - /uploads/xxx（手动上传）→ 相对路径可直接展示；
 * - 素材库资产名（Agent 发的）→ `/api/v1/agent/media/:name`，需要 Authorization 头，
 *   `<img src>` 带不上，必须 fetch blob 后用 objectURL 展示。
 */
const blobCache = new Map<string, string>()
const pending = new Set<string>()

export function isDirectMediaUrl(value: string): boolean {
  return value.startsWith('/') || /^https?:\/\//.test(value)
}

export async function resolveAuthMedia(name: string): Promise<string | null> {
  if (!name) return null
  if (isDirectMediaUrl(name)) return name
  const cached = blobCache.get(name)
  if (cached) return cached
  if (pending.has(name)) return null
  pending.add(name)
  try {
    const { data } = await http.get<Blob>(`/api/v1/agent/media/${encodeURIComponent(name)}`, {
      responseType: 'blob',
    })
    const url = URL.createObjectURL(data)
    blobCache.set(name, url)
    return url
  } catch {
    return null
  } finally {
    pending.delete(name)
  }
}

/** 批量解析（消息列表加载后调用），全部 settled 后回调 */
export async function resolveAuthMediaBatch(names: string[]): Promise<void> {
  const batch = 4
  for (let index = 0; index < names.length; index += batch) {
    await Promise.all(names.slice(index, index + batch).map((name) => resolveAuthMedia(name)))
  }
}
