import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { normalizePositionFacts, applyCityDefaultsToPosition, normalizeInterviewPoints } from '../src/shared/position-facts.js';
import { serializeServicePosition } from '../src/shared/response-serializers.js';

describe('recruitment position addresses', () => {
  it('retains the legacy address contract and allows two independent explicit addresses', () => {
    expect(normalizePositionFacts({ address: '旧集合点' })).toMatchObject({ place: '旧集合点', interview_address: '旧集合点' });
    const split = normalizePositionFacts({ address: '旧集合点', work_address: '上班西门', interview_address: '报名东门' });
    expect(split).toMatchObject({ place: '上班西门', interview_address: '报名东门' });
    expect(serializeServicePosition({ id: 1, data_json: JSON.stringify(split) })).toMatchObject({ work_address: '上班西门', interview_address: '报名东门' });
    expect(normalizePositionFacts({ address: '旧集合点', work_address: '', interview_address: '' })).toMatchObject({ place: '', interview_address: '' });
  });
  it('uses city defaults for a new interview address without filling the explicit work address', () => {
    const result = normalizePositionFacts(applyCityDefaultsToPosition({ interview: { location: '城市面试点' } }, {work_address:'', interview_address:''}));
    expect(result).toMatchObject({ place: '', interview_address: '城市面试点' });
  });
  it('converts legacy point names and retains detailed addresses', () => {
    expect(normalizeInterviewPoints(['西门', {name:' 东门 ',address:' 兴业路8号 '}, {}, null])).toEqual([
      {name:'西门',address:''}, {name:'东门',address:'兴业路8号'},
    ]);
  });
});

let app: ReturnType<typeof buildServer> | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

it('round trips two points and sends the same locations into Agent and Dify previews', async () => {
  const previous = process.env.REA_DATABASE_PATH;
  process.env.REA_DATABASE_PATH = ':memory:';
  try { app = buildServer(); }
  finally {
    if (previous === undefined) delete process.env.REA_DATABASE_PATH;
    else process.env.REA_DATABASE_PATH = previous;
  }
  const server = app;
  const login = await server.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'local-admin', password: 'local-demo-only' } });
  expect(login.statusCode).toBe(200);
  const headers = { authorization: 'Bearer ' + login.json().access_token };
  const city = await server.inject({ method: 'POST', url: '/api/v1/cities', headers, payload: { city_name: '验收城市' } });
  expect(city.statusCode).toBe(200);
  const create = await server.inject({ method: 'POST', url: '/api/v1/service-positions', headers,
    payload: { position_name: '验收岗位', city_id: city.json().id, address: '旧地址' } });
  expect(create.statusCode).toBe(200);
  const id = create.json().id;
  const locations = { work_address: '上班西门', interview_address: '默认面试东门',
    interview_points: [{ name: '南门', address: '南路6号' }, { name: '北门', address: '北路8号' }] };
  const update = await server.inject({ method: 'PUT', url: '/api/v1/service-positions/' + id, headers, payload: locations });
  expect(update.statusCode).toBe(200);
  const read = await server.inject({ url: '/api/v1/service-positions/' + id, headers });
  expect(read.json()).toMatchObject({city_id: city.json().id, ...locations});
  const question = { position_id: id, text: '在哪里上班和面试？', dry: true };
  const agent = await server.inject({ method: 'POST', url: '/api/v1/agent/chat', headers, payload: question });
  expect(agent.statusCode).toBe(200);
  expect(agent.json().facts).toMatchObject({ place: '上班西门', interview_address: '默认面试东门',
    interview_points: '南门（南路6号）；北门（北路8号）' });
  expect(agent.json().messages[0].content).toContain('北门（北路8号）');
  const dify = await server.inject({ method: 'POST', url: '/api/v1/dify/preview', headers, payload: question });
  expect(dify.statusCode).toBe(200);
  expect(JSON.parse(dify.json().inputs.position_data)).toMatchObject({ place: '上班西门', interview_address: '默认面试东门',
    interview_points: locations.interview_points });
});
