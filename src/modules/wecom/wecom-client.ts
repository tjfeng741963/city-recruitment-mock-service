export class WeComApiError extends Error {
  constructor(message: string, readonly code?: number, readonly uncertain = false) { super(message); }
}

export class WeComClient {
  private cached?: { value: string; expires: number };
  private loading?: Promise<string>;
  constructor(private readonly config: { corpId: string; secret: string }, private readonly fetcher: typeof fetch = fetch) {}

  async call(apiPath: string, body: Record<string, unknown>): Promise<Record<string, any>> {
    if (!/^kf\/[a-z_/]+$/.test(apiPath)) throw new Error('Unsupported WeCom API path');
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken();
      const url = new URL(`https://qyapi.weixin.qq.com/cgi-bin/${apiPath}`);
      url.searchParams.set('access_token', token);
      try { return await this.request(url, body, apiPath === 'kf/send_msg'); }
      catch (error) {
        if (attempt === 0 && apiPath !== 'kf/send_msg' && error instanceof WeComApiError && [40014, 42001].includes(error.code ?? 0)) {
          if (this.cached?.value === token) this.cached = undefined;
          continue;
        }
        throw error;
      }
    }
    throw new WeComApiError('WeCom credential refresh failed');
  }

  private async accessToken(): Promise<string> {
    if (this.cached && this.cached.expires > Date.now()) return this.cached.value;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const url = new URL('https://qyapi.weixin.qq.com/cgi-bin/gettoken');
      url.searchParams.set('corpid', this.config.corpId); url.searchParams.set('corpsecret', this.config.secret);
      const body = await this.request(url);
      if (typeof body.access_token !== 'string' || !body.access_token || !Number.isFinite(body.expires_in)) throw new WeComApiError('WeCom credential response is invalid');
      this.cached = { value: body.access_token, expires: Date.now() + Math.max(1, body.expires_in - 60) * 1000 };
      return body.access_token;
    })();
    try { return await this.loading; } finally { this.loading = undefined; }
  }

  private async request(url: URL, body?: Record<string, unknown>, uncertain = false): Promise<Record<string, any>> {
    let response: Response;
    try {
      response = await this.fetcher(url, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(12000),
        ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    } catch { throw new WeComApiError('WeCom request failed or timed out', undefined, uncertain); }
    if (!response.ok) throw new WeComApiError(`WeCom HTTP ${response.status}`, undefined, uncertain);
    let result: Record<string, any>;
    try { result = await response.json() as Record<string, any>; }
    catch { throw new WeComApiError('WeCom response is invalid', undefined, uncertain); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new WeComApiError('WeCom response is invalid', undefined, uncertain);
    if (typeof result.errcode === 'number' && result.errcode !== 0) throw new WeComApiError(`WeCom API error ${result.errcode}`, result.errcode);
    return result;
  }
}
