import { lookup } from "node:dns";
import { request } from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

export class ModelProviderError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

function isPublicAddress(address: string): boolean {
  return ipaddr.isValid(address) && ipaddr.process(address).range() === "unicast";
}

function unsafeUrl() {
  return new ModelProviderError("invalid_provider_url", "请填写可从公网访问的 HTTPS 模型 API 地址");
}

export function modelBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw unsafeUrl(); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      (isIP(hostname) ? !isPublicAddress(hostname) : !hostname.includes("."))) throw unsafeUrl();
  return url.href.replace(/\/+$/, "");
}

export function providerRequest(
  baseUrl: string,
  key: string,
  endpoint: "models" | "chat/completions",
  timeout: number,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const url = new URL(modelBaseUrl(baseUrl) + "/" + endpoint);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: payload === undefined ? "GET" : "POST",
      agent: false,
      signal: AbortSignal.timeout(timeout),
      headers: {
        authorization: "Bearer " + key,
        accept: "application/json",
        ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
      },
      // Validate DNS answers on the lookup used by the socket itself.
      lookup(host, options, callback) {
        lookup(host, { all: true, family: options.family }, (error, addresses) => {
          if (error) return callback(error, "", 0);
          if (!addresses.length || addresses.some(row => !isPublicAddress(row.address))) {
            reject(unsafeUrl());
            return callback(new Error("Invalid model destination"), "", 0);
          }
          const selected = addresses[0];
          if (options.all) return callback(null, addresses);
          callback(null, selected.address, selected.family);
        });
      },
    }, response => {
      const status = response.statusCode ?? 502;
      if (status < 200 || status >= 300) {
        response.destroy();
        if (status === 402) return reject(new ModelProviderError("provider_balance", "模型供应商余额不足"));
        if (status === 401 || status === 403) return reject(new ModelProviderError("provider_credentials", "供应商拒绝访问，请检查 API Key 或模型权限"));
        if (status === 429) return reject(new ModelProviderError("provider_rate_limit", "供应商限流，请稍后重试"));
        if (status === 404 && endpoint === "models") return reject(new ModelProviderError("provider_no_catalog", "供应商未提供模型列表，可手动填写模型 ID 后测试"));
        return reject(new ModelProviderError("provider_http_error", `模型供应商返回 HTTP ${status}`));
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2_000_000) {
          reject(new ModelProviderError("provider_response", "模型服务响应过大"));
          response.destroy();
        } else chunks.push(chunk);
      });
      response.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(new ModelProviderError("provider_response", "模型服务未返回有效 JSON")); }
      });
      response.on("error", () => reject(new ModelProviderError("provider_unavailable", "模型服务响应中断")));
      response.on("aborted", () => reject(new ModelProviderError("provider_unavailable", "模型服务响应中断")));
    });
    req.on("error", error => reject(new ModelProviderError("provider_unavailable",
      error.name === "AbortError" ? "请求模型服务超时" : "无法连接模型服务，请检查地址或证书")));
    req.end(payload);
  });
}
