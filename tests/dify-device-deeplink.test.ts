import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { receptionTestHref } from '../frontend-vue/src/components/agent/device-workflow-entry.js';

let app: ReturnType<typeof buildServer> | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

describe('Dify canvas links', () => {
  it('keeps the selected knowledge position when opening a simulation', () => {
    expect(receptionTestHref('dify', {positionId: 25})).toBe('/recruitment-flow?test_engine=dify&position_id=25');
  });

  it('redirects the old page to the same canvas and preserves the exact account', async () => {
    const previous = process.env.REA_DATABASE_PATH;
    process.env.REA_DATABASE_PATH = ':memory:';
    try { app = buildServer(); }
    finally {
      if (previous === undefined) delete process.env.REA_DATABASE_PATH;
      else process.env.REA_DATABASE_PATH = previous;
    }
    const response = await app.inject({url: '/dify-connection?device_code=pc-win-01&position_id=25'});
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/recruitment-flow?test_engine=dify&device_code=pc-win-01&position_id=25');
  });
});
