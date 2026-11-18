import { TOKEN_KEY } from './http'

/**
 * Agent SSE 实时流（对齐 theme/realtime.js 的注入行为）。
 *
 * 后端 GET /api/v1/agent/stream?token=<jwt>&device_code=<code>
 * 事件：ready / message.created / command.updated / device.updated
 *
 * 设计原则与注入层一致：
 * - SSE 只做「提前触发刷新」，轮询兜底保留；
 * - 断线指数退避（1s 起，上限 30s），重连成功后触发一次全量刷新；
 * - 任何异常都吞掉，实时层坏掉最多回到轮询节奏。
 */

export interface StreamHandlers {
  onReady?: () => void
  onMessageCreated?: (payload: Record<string, unknown> | null) => void
  onCommandUpdated?: (payload: Record<string, unknown> | null) => void
  onDeviceUpdated?: (payload: Record<string, unknown> | null) => void
}

const BACKOFF_BASE_MS = 1000
const BACKOFF_MAX_MS = 30000

function parsePayload(event: MessageEvent): Record<string, unknown> | null {
  try {
    return JSON.parse(String(event.data)) as Record<string, unknown>
  } catch {
    return null
  }
}

export function createAgentStream(handlers: StreamHandlers): { start: () => void; stop: () => void } {
  let source: EventSource | null = null
  let attempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = true

  function streamUrl(): string {
    const token = (localStorage.getItem(TOKEN_KEY) || '').trim()
    return `/api/v1/agent/stream?token=${encodeURIComponent(token)}`
  }

  function scheduleReconnect(): void {
    if (stopped) return
    attempt += 1
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS)
    reconnectTimer = setTimeout(() => connect(), delay)
  }

  function connect(): void {
    if (stopped || typeof window.EventSource !== 'function') return
    try {
      source = new EventSource(streamUrl())
    } catch {
      scheduleReconnect()
      return
    }

    source.addEventListener('ready', () => {
      attempt = 0
      handlers.onReady?.()
    })
    source.addEventListener('message.created', (event) => {
      handlers.onMessageCreated?.(parsePayload(event as MessageEvent))
    })
    source.addEventListener('command.updated', (event) => {
      handlers.onCommandUpdated?.(parsePayload(event as MessageEvent))
    })
    source.addEventListener('device.updated', (event) => {
      handlers.onDeviceUpdated?.(parsePayload(event as MessageEvent))
    })

    source.onerror = () => {
      // 不主动 close 的话浏览器会立即重连，退避失效：先关再按退避重开。
      try {
        source?.close()
      } catch {
        /* ignore */
      }
      source = null
      scheduleReconnect()
    }
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      attempt = 0
      connect()
    },
    stop() {
      stopped = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      try {
        source?.close()
      } catch {
        /* ignore */
      }
      source = null
    },
  }
}
