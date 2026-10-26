import type { DatabaseSync } from "node:sqlite";
import { DeviceBridgeChannelProvider, DeviceBridgeStore } from "./device-bridge.js";
import { readWeComConfig } from "../wecom/wecom-config.js";
import { getWeComChannel } from "../wecom/wecom-channel.js";

export interface OutboundMessageInput {
  deviceCode: string;
  customerId: number;
  content: string;
  idempotencyKey: string;
}

export interface OutboundMessageResult {
  success: boolean;
  message_id?: string;
  simulated?: boolean;
  accepted?: boolean;
  error?: string;
}

export interface MessageChannelProvider {
  sendMessage(input: OutboundMessageInput): Promise<OutboundMessageResult>;
}

export class MockMessageChannelProvider implements MessageChannelProvider {
  async sendMessage(input: OutboundMessageInput): Promise<OutboundMessageResult> {
    return {
      success: true,
      message_id: `mock-${input.deviceCode}-${input.customerId}`,
      simulated: true,
    };
  }
}

interface HttpMessageChannelProviderOptions {
  sendUrl: string;
  token?: string;
  timeoutMs?: number;
}

function isPrivateOrLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "::1") return true;
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  return octets[0] === 10 || octets[0] === 127 || (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 169 && octets[1] === 254) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
}

export class HttpMessageChannelProvider implements MessageChannelProvider {
  private readonly sendUrl: string;

  constructor(private readonly options: HttpMessageChannelProviderOptions) {
    let parsed: URL;
    try { parsed = new URL(options.sendUrl); }
    catch { throw new Error("REA_MESSAGE_CHANNEL_SEND_URL must be an absolute HTTP URL"); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("REA_MESSAGE_CHANNEL_SEND_URL must use HTTP or HTTPS");
    }
    if (parsed.protocol === "http:" && !isPrivateOrLoopback(parsed.hostname)) {
      throw new Error("Message gateway must use HTTPS unless it is on a private or loopback network");
    }
    this.sendUrl = parsed.toString();
  }

  async sendMessage(input: OutboundMessageInput): Promise<OutboundMessageResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000);
    try {
      const response = await fetch(this.sendUrl, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "idempotency-key": input.idempotencyKey,
          ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
        },
        body: JSON.stringify({
          device_code: input.deviceCode,
          customer_id: input.customerId,
          content: input.content,
        }),
        signal: controller.signal,
      });
      if (!response.ok) return { success: false, error: `Message gateway HTTP ${response.status}` };
      let body: { success?: unknown; message_id?: unknown; id?: unknown; status?: unknown };
      try { body = await response.json() as typeof body; }
      catch { return { success: false, error: "Message gateway returned invalid JSON" }; }
      if (body.success !== undefined && body.success !== true) return { success: false, error: "Message gateway did not confirm delivery" };
      if (body.status !== undefined && !["sent", "succeeded"].includes(String(body.status).toLowerCase())) {
        return { success: false, error: "Message gateway did not confirm delivery" };
      }
      const messageId = body.message_id ?? body.id;
      if ((typeof messageId !== "string" && typeof messageId !== "number") || !String(messageId).trim()) {
        return { success: false, error: "Message gateway omitted message_id" };
      }
      return { success: true, message_id: String(messageId) };
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      return { success: false, error: timedOut ? "Message gateway request timeout" : "Message gateway request failed" };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createMessageChannelProvider(mode = process.env.REA_MESSAGE_CHANNEL_PROVIDER ?? "mock", db?: DatabaseSync): MessageChannelProvider {
  const wecom = readWeComConfig();
  if (wecom && db) {
    const channel = getWeComChannel(db,wecom);
    const fallback = createFallbackProvider(mode,db);
    return { sendMessage: input => input.deviceCode === wecom.deviceCode ? channel.sendMessage(input) : fallback.sendMessage(input) };
  }
  return createFallbackProvider(mode,db);
}
function createFallbackProvider(mode: string, db?: DatabaseSync): MessageChannelProvider {
  if (mode === "mock") return new MockMessageChannelProvider();
  if (mode === "bridge") {
    if (!db) throw new Error("bridge provider requires a database");
    return new DeviceBridgeChannelProvider(new DeviceBridgeStore(db));
  }
  if (mode === "http") {
    const sendUrl = process.env.REA_MESSAGE_CHANNEL_SEND_URL;
    if (!sendUrl) throw new Error("REA_MESSAGE_CHANNEL_SEND_URL is required when REA_MESSAGE_CHANNEL_PROVIDER=http");
    return new HttpMessageChannelProvider({ sendUrl, token: process.env.REA_MESSAGE_CHANNEL_TOKEN });
  }
  throw new Error(`Unsupported message channel provider: ${mode}`);
}
