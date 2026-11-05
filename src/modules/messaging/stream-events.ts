import type { DatabaseSync } from "node:sqlite";

export type StreamEventType = "ready" | "message.created" | "command.updated" | "device.updated";

export interface StreamEvent {
  type: StreamEventType;
  data: Record<string, unknown>;
}

/** SSE frame: `event: <type>\ndata: <json>\n\n`. */
export function serializeEvent(event: StreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

interface StreamClient {
  id: string;
  deviceCode: string;
  write: (chunk: string) => void;
  end: () => void;
}

/**
 * In-process fan-out for the SSE endpoint. Events are routed by device_code so
 * a browser tab watching one device never sees another device's traffic.
 * Writes are synchronous socket writes; a dead client throws and is dropped
 * instead of blocking the caller.
 */
export class EventBus {
  private readonly clients = new Map<string, StreamClient>();
  private seq = 0;

  get size(): number { return this.clients.size; }

  subscribe(deviceCode: string, write: (chunk: string) => void, end: () => void): string {
    const id = `sse-${++this.seq}`;
    this.clients.set(id, { id, deviceCode, write, end });
    return id;
  }

  unsubscribe(id: string): void { this.clients.delete(id); }

  /** Returns how many streams accepted the frame. */
  publish(deviceCode: string, event: StreamEvent): number {
    const frame = serializeEvent(event);
    let delivered = 0;
    for (const client of [...this.clients.values()]) {
      if (client.deviceCode !== deviceCode) continue;
      try {
        client.write(frame);
        delivered += 1;
      } catch {
        this.clients.delete(client.id);
      }
    }
    return delivered;
  }

  /** Graceful shutdown: tell every browser to reconnect, then end the response. */
  closeAll(): void {
    for (const client of [...this.clients.values()]) {
      this.clients.delete(client.id);
      try {
        client.write(": server shutting down\n\n");
        client.end();
      } catch { /* socket already gone */ }
    }
  }
}

interface MessageRow {
  id: number;
  customer_id: number;
  direction: string;
  content: string;
  status: string;
  created_at: string;
}
interface ConversationRow {
  customer_id: number;
  nickname: string;
  last_msg: string;
  last_msg_at: string | null;
  unread: number;
}

export interface CommandSnapshot {
  id: string;
  customer_id: number;
  status: string;
  error?: string | null;
}

/**
 * The only place that turns a business write into a stream event. Every method
 * swallows its own failure (bad payload, closed socket) — pushing an event must
 * never fail the inbound/manual-send/receipt path that triggered it.
 */
export interface StreamNotifier {
  messageCreated(deviceCode: string, customerId: number, sourceEventId: string): void;
  commandUpdated(deviceCode: string, command: CommandSnapshot): void;
  deviceUpdated(deviceCode: string, state: string): void;
}

const noop = () => {};

function source(sourceEventId: string): string {
  if (sourceEventId.startsWith("bridge-inbound:")) return "bridge";
  if (sourceEventId.startsWith("manual-reply:")) return "manual";
  return "server";
}

export function messageCreatedEvent(db: DatabaseSync, deviceCode: string, customerId: number, sourceEventId: string): { event: StreamEvent } | null {
  const message = db.prepare(
    "SELECT id,customer_id,direction,content,status,created_at FROM agent_messages WHERE source_event_id=? ORDER BY id LIMIT 1",
  ).get(sourceEventId) as MessageRow | undefined;
  if (!message) return null;
  const conversation = db.prepare(
    "SELECT customer_id,nickname,last_msg,last_msg_at,unread FROM agent_conversations WHERE device_code=? AND customer_id=?",
  ).get(deviceCode, customerId) as ConversationRow | undefined;
  return {
    event: {
      type: "message.created",
      data: {
        message: {
          id: message.id,
          customer_id: message.customer_id,
          direction: message.direction,
          content: message.content,
          status: message.status,
          created_at: message.created_at,
          role: message.direction === "inbound" ? "customer" : "agent",
          source: source(sourceEventId),
        },
        conversation: {
          customer_id: conversation?.customer_id ?? customerId,
          nickname: conversation?.nickname ?? "",
          last_msg: conversation?.last_msg ?? message.content,
          last_msg_at: conversation?.last_msg_at ?? message.created_at,
          unread: conversation?.unread ?? 0,
        },
      },
    },
  };
}

export function createStreamNotifier(db: DatabaseSync, bus: EventBus, log: (error: unknown) => void = (error) => console.warn("[sse] event dropped", error)): StreamNotifier {
  return {
    messageCreated(deviceCode, customerId, sourceEventId) {
      try {
        const built = messageCreatedEvent(db, deviceCode, customerId, sourceEventId);
        if (built) bus.publish(deviceCode, built.event);
      } catch (error) { log(error); }
    },
    commandUpdated(deviceCode, command) {
      try {
        bus.publish(deviceCode, {
          type: "command.updated",
          data: { command_id: command.id, customer_id: Number(command.customer_id), status: command.status, error: command.error ?? null },
        });
      } catch (error) { log(error); }
    },
    deviceUpdated(deviceCode, state) {
      try {
        bus.publish(deviceCode, {
          type: "device.updated",
          data: { device_code: deviceCode, online: state === "online", wecom_state: state },
        });
      } catch (error) { log(error); }
    },
  };
}

export const NOOP_NOTIFIER: StreamNotifier = { messageCreated: noop, commandUpdated: noop, deviceUpdated: noop };
