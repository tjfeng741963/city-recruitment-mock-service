import { useEffect, useRef } from "react";

export interface DeviceStreamEvent {
  device_code: string;
  online: boolean;
  wecom_state: string;
  reason?: string;
}

const RECONNECT_DELAY_MS = 3_000;

/**
 * Shell 级全局设备流订阅：`GET /api/v1/agent/stream?token=<jwt>&device_code=all`。
 * EventSource 无法携带 Authorization header，token 必须走 query string，
 * 与后端 src/modules/agent/stream.routes.ts 的鉴权参数形态对齐。
 * 服务端正常断开时浏览器原生 retry 兜底；连接被彻底关闭（HTTP 4xx/网络失败）
 * 时在 onerror 里重置重连计时器，防止重连风暴。
 */
export function useDeviceStream(token: string | null, onEvent: (event: DeviceStreamEvent) => void): void {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!token) return undefined;
    let source: EventSource | null = null;
    let reconnectTimer: number | null = null;

    const connect = () => {
      source = new EventSource(`/api/v1/agent/stream?token=${encodeURIComponent(token)}&device_code=all`);
      source.addEventListener("device.updated", (event) => {
        try {
          const data = JSON.parse((event as MessageEvent<string>).data) as DeviceStreamEvent;
          if (typeof data.device_code === "string" && typeof data.online === "boolean") handlerRef.current(data);
        } catch {
          /* 丢帧即可，不值得为坏数据重连 */
        }
      });
      source.onerror = () => {
        // readyState 非 CLOSED 说明浏览器正在原生重试，不要插手。
        if (source && source.readyState !== EventSource.CLOSED) return;
        source?.close();
        source = null;
        // 重置计时器：同一时刻只保留一个待触发的重连。
        if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
        reconnectTimer = window.setTimeout(connect, RECONNECT_DELAY_MS);
      };
    };

    connect();
    return () => {
      source?.close();
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    };
  }, [token]);
}
