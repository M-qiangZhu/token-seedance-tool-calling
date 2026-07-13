import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { MemoryStore } from '../server/store.js';
import { createPromptCipher, hashPassword } from '../server/security.js';

test('登录、自动发现模型、排队、后台提交和成功计费完整流程', async (t) => {
  const calls = [];
  const diagnostics = [];
  const mockFetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/models')) return json({ data: [
      { id: 'doubao-seedance-2-0-mini-260615' },
      { id: 'doubao-seedance-2-0-260128' },
      { id: 'unrelated-model' }
    ] });
    if (options.method === 'POST') return json({ output: { task_id: 'remote-1', task_status: 'PENDING' }, request_id: 'request-1' });
    return json({ output: { task_id: 'remote-1', task_status: 'SUCCEEDED', video_url: 'https://cdn.example/video.mp4' }, usage: { completion_tokens: 108900, total_tokens: 108900 } });
  };
  const store = await seededStore();
  await store.updateSettings({ pollIntervalMs: 1 });
  const app = createApp({ store, fetchImpl: mockFetch, promptCipher: createPromptCipher('tests'), logger: captureLogger(diagnostics) });
  const { base, close } = await listen(app); t.after(close);

  const auth = await login(base, 'member', 'MemberPass123');
  const discovered = await request(base, '/api/config/discover', { method: 'POST', auth, body: { url: 'https://gateway.example/v1', apiKey: 'super-secret-key' } });
  assert.equal(discovered.status, 200);
  assert.deepEqual(discovered.body.models.map((item) => item.id), ['doubao-seedance-2-0-mini-260615', 'doubao-seedance-2-0-260128']);
  assert.equal(JSON.stringify(discovered.body).includes('super-secret-key'), false);

  const selected = await request(base, '/api/config/model', { method: 'PUT', auth, body: { model: 'doubao-seedance-2-0-mini-260615' } });
  assert.equal(selected.status, 200);
  const created = await request(base, '/api/video/tasks', { method: 'POST', auth, body: { prompt: '云海中的城市', model: 'doubao-seedance-2-0-mini-260615', resolution: '720p', ratio: '16:9', duration: 5, generateAudio: false, watermark: false } });
  assert.equal(created.status, 201);
  assert.equal(created.body.task.status, 'LOCAL_QUEUED');
  await settleWorker(app);
  await app.locals.worker.tick();
  await new Promise((resolve) => setTimeout(resolve, 3));
  await app.locals.worker.tick();

  const completed = await request(base, `/api/video/tasks/${created.body.task.id}`, { auth });
  assert.equal(completed.body.task.status, 'SUCCEEDED');
  assert.equal(completed.body.task.remoteTaskId, 'remote-1');
  assert.equal(completed.body.task.videoUrl, 'https://cdn.example/video.mp4');
  assert.equal(completed.body.task.cost.completionTokens, 108900);
  assert.equal(completed.body.task.cost.totalCost, 2.5047);
  assert.equal(completed.body.task.prompt, '云海中的城市');

  const post = calls.find((call) => call.options.method === 'POST');
  assert.deepEqual(JSON.parse(post.options.body), { model: 'doubao-seedance-2-0-mini-260615', content: [{ type: 'text', text: '云海中的城市' }], resolution: '720p', ratio: '16:9', duration: 5, generate_audio: false, watermark: false });
  assert.equal(JSON.stringify(diagnostics).includes('super-secret-key'), false);
  assert.equal(JSON.stringify(diagnostics).includes('云海中的城市'), false);
});

test('普通用户不能访问管理接口，管理员可创建用户和修改价格', async (t) => {
  const store = await seededStore();
  const app = createApp({ store, fetchImpl: async () => json({}), promptCipher: createPromptCipher('tests'), logger: silentLogger });
  const { base, close } = await listen(app); t.after(close);
  const member = await login(base, 'member', 'MemberPass123');
  assert.equal((await request(base, '/api/admin/users', { auth: member })).status, 403);

  const admin = await login(base, 'admin', 'AdminPass123');
  const created = await request(base, '/api/admin/users', { method: 'POST', auth: admin, body: { username: 'new.user', password: 'Temporary123', role: 'USER' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.user.mustChangePassword, true);
  assert.equal(JSON.stringify(created.body).includes('Temporary123'), false);

  const pricing = await request(base, '/api/admin/pricing', { method: 'PUT', auth: admin, body: { model: 'doubao-seedance-2-0-260128', resolution: '4k', inputRate: 1.5, outputRate: 30 } });
  assert.equal(pricing.body.pricing.version, 2);
  assert.equal(pricing.body.pricing.outputRate, 30);
});

test('CSRF、防重复用户名和登录限流生效', async (t) => {
  const store = await seededStore();
  const app = createApp({ store, promptCipher: createPromptCipher('tests'), logger: silentLogger });
  const { base, close } = await listen(app); t.after(close);
  const admin = await login(base, 'admin', 'AdminPass123');
  const noCsrf = await request(base, '/api/admin/users', { method: 'POST', cookie: admin.cookie, body: { username: 'x-user', password: 'Temporary123' } });
  assert.equal(noCsrf.status, 403);
  const duplicate = await request(base, '/api/admin/users', { method: 'POST', auth: admin, body: { username: 'member', password: 'Temporary123' } });
  assert.equal(duplicate.status, 409);

  for (let index = 0; index < 5; index += 1) await request(base, '/api/auth/login', { method: 'POST', body: { username: 'none', password: 'bad' } });
  const limited = await request(base, '/api/auth/login', { method: 'POST', body: { username: 'none', password: 'bad' } });
  assert.equal(limited.status, 429);
});

test('不兼容分辨率在调用上游前被拒绝', async (t) => {
  let calls = 0;
  const store = await seededStore();
  const app = createApp({ store, fetchImpl: async (url) => { calls += 1; return url.endsWith('/models') ? json({ data: [{ id: 'doubao-seedance-2-0-260128' }] }) : json({}); }, promptCipher: createPromptCipher('tests'), logger: silentLogger });
  const { base, close } = await listen(app); t.after(close);
  const auth = await login(base, 'member', 'MemberPass123');
  await request(base, '/api/config/discover', { method: 'POST', auth, body: { url: 'https://gateway.example/v1', apiKey: 'test-secret-key' } });
  const invalid = await request(base, '/api/video/tasks', { method: 'POST', auth, body: { prompt: '测试', model: 'doubao-seedance-2-0-260128', resolution: '720p', duration: 5, ratio: '16:9' } });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error.message, /1080p 或 4k/);
  assert.equal(calls, 1);
});

async function seededStore() {
  const store = new MemoryStore();
  await store.createUser({ id: crypto.randomUUID(), username: 'admin', passwordHash: await hashPassword('AdminPass123'), role: 'ADMIN', mustChangePassword: false });
  await store.createUser({ id: crypto.randomUUID(), username: 'member', passwordHash: await hashPassword('MemberPass123'), role: 'USER', mustChangePassword: false });
  return store;
}
async function login(base, username, password) {
  const result = await request(base, '/api/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(result.status, 200);
  return { cookie: result.cookie, csrf: result.body.csrfToken };
}
async function request(base, pathname, { method = 'GET', auth, cookie, body } = {}) {
  const response = await fetch(`${base}${pathname}`, { method, headers: { ...((auth?.cookie || cookie) ? { Cookie: auth?.cookie || cookie } : {}), ...(auth?.csrf ? { 'X-CSRF-Token': auth.csrf } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function listen(app) {
  const server = app.listen(0); await new Promise((resolve) => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
async function settleWorker(app) { await new Promise((resolve) => setTimeout(resolve, 15)); await app.locals.worker.tick(); }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
function captureLogger(target) { return { info: (...values) => target.push(values), error: (...values) => target.push(values) }; }
const silentLogger = { info() {}, error() {} };
