import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { MemoryStore } from '../server/store.js';
import { createPromptCipher, hashPassword, keyFingerprint } from '../server/security.js';

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
  const memberUser = await store.findUserByUsername('member');
  await store.updateUser(memberUser.id, { discountRate: 0.8 });
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
  assert.equal((await store.getTask(created.body.task.id)).pricingSnapshot.discountRate, 0.8);
  await settleWorker(app);
  await app.locals.worker.tick();
  await new Promise((resolve) => setTimeout(resolve, 3));
  await app.locals.worker.tick();

  const completed = await request(base, `/api/video/tasks/${created.body.task.id}`, { auth });
  assert.equal(completed.body.task.status, 'SUCCEEDED');
  assert.equal(completed.body.task.remoteTaskId, 'remote-1');
  assert.equal(completed.body.task.videoUrl, 'https://cdn.example/video.mp4');
  assert.equal(completed.body.task.cost.completionTokens, 108900);
  assert.equal(completed.body.task.cost.originalTotalCost, 2.5047);
  assert.equal(completed.body.task.cost.discountRate, 0.8);
  assert.equal(completed.body.task.cost.totalCost, 2.00376);
  assert.equal(completed.body.task.prompt, '云海中的城市');

  const admin = await login(base, 'admin', 'AdminPass123');
  const adminTasks = await request(base, '/api/admin/tasks', { auth: admin });
  assert.equal(adminTasks.body.tasks[0].username, 'member');
  assert.equal(JSON.stringify(adminTasks.body).includes('云海中的城市'), false);
  assert.equal(JSON.stringify(adminTasks.body).includes('https://cdn.example/video.mp4'), false);

  const post = calls.find((call) => call.options.method === 'POST');
  assert.deepEqual(JSON.parse(post.options.body), { model: 'doubao-seedance-2-0-mini-260615', content: [{ type: 'text', text: '云海中的城市' }], resolution: '720p', ratio: '16:9', duration: 5, generate_audio: false, watermark: false });
  assert.equal(JSON.stringify(diagnostics).includes('super-secret-key'), false);
  assert.equal(JSON.stringify(diagnostics).includes('云海中的城市'), false);
});

test('普通用户不能访问管理接口，管理员可创建用户、修改折扣率和价格', async (t) => {
  const store = await seededStore();
  const app = createApp({ store, fetchImpl: async () => json({}), promptCipher: createPromptCipher('tests'), logger: silentLogger });
  const { base, close } = await listen(app); t.after(close);
  const member = await login(base, 'member', 'MemberPass123');
  assert.equal((await request(base, '/api/admin/users', { auth: member })).status, 403);

  const admin = await login(base, 'admin', 'AdminPass123');
  const created = await request(base, '/api/admin/users', { method: 'POST', auth: admin, body: { username: 'new.user', password: 'Temporary123', role: 'USER', discountRate: 0.75 } });
  assert.equal(created.status, 201);
  assert.equal(created.body.user.mustChangePassword, true);
  assert.equal(created.body.user.discountRate, 0.75);
  assert.equal(JSON.stringify(created.body).includes('Temporary123'), false);
  const updatedUser = await request(base, `/api/admin/users/${created.body.user.id}`, { method: 'PATCH', auth: admin, body: { discountRate: 0.6 } });
  assert.equal(updatedUser.body.user.discountRate, 0.6);

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
  const invalid = await request(base, '/api/video/tasks', { method: 'POST', auth, body: { prompt: '测试', model: 'doubao-seedance-2-0-260128', resolution: '1440p', duration: 5, ratio: '16:9' } });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error.message, /480p 或 720p 或 1080p 或 4k/);
  assert.equal(calls, 1);
});

test('退出登录清除会话配置但本地与远端任务继续处理', async (t) => {
  const store = await seededStore();
  await store.updateSettings({ perUserActiveLimit: 1, pollIntervalMs: 1 });
  let nextRemoteId = 0;
  let completeRemoteTasks = false;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/models')) return json({ data: [{ id: 'doubao-seedance-2-0-mini-260615' }] });
    if (options.method === 'POST') {
      nextRemoteId += 1;
      return json({ output: { task_id: `remote-${nextRemoteId}`, task_status: 'PENDING' } });
    }
    const remoteId = url.split('/').at(-1);
    return json({ output: { task_id: remoteId, task_status: completeRemoteTasks ? 'SUCCEEDED' : 'PENDING', video_url: completeRemoteTasks ? `https://cdn.example/${remoteId}.mp4` : undefined } });
  };
  const app = createApp({ store, fetchImpl, promptCipher: createPromptCipher('tests'), logger: silentLogger, workerOptions: { pollJitterMs: 0 } });
  const { base, close } = await listen(app); t.after(close);
  const auth = await login(base, 'member', 'MemberPass123');
  await request(base, '/api/config/discover', { method: 'POST', auth, body: { url: 'https://gateway.example/v1', apiKey: 'logout-test-key' } });

  const first = await createVideoTask(base, auth, '远端任务');
  await settleWorker(app);
  const second = await createVideoTask(base, auth, '本地任务');
  await settleWorker(app);
  assert.ok((await store.getTask(first.body.task.id)).remoteTaskId);
  assert.equal((await store.getTask(second.body.task.id)).remoteTaskId, null);

  const logout = await request(base, '/api/auth/logout', { method: 'POST', auth });
  assert.equal(logout.status, 200);
  assert.equal(app.locals.sessionConfigs.size, 0);
  assert.equal(app.locals.taskCredentials.size, 1);

  completeRemoteTasks = true;
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3));
    await app.locals.worker.tick();
  }
  assert.equal((await store.getTask(first.body.task.id)).status, 'SUCCEEDED');
  assert.equal((await store.getTask(second.body.task.id)).status, 'SUCCEEDED');
  assert.equal(app.locals.taskCredentials.size, 0);

  const relogin = await login(base, 'member', 'MemberPass123');
  const config = await request(base, '/api/config', { auth: relogin });
  assert.equal(config.body.configured, false);
  const rejected = await createVideoTask(base, relogin, '需要重新配置');
  assert.equal(rejected.status, 401);
});

test('重新填写相同Key跨模型恢复全部匹配任务且不同Key任务保持等待', async (t) => {
  const store = await seededStore();
  const member = await store.findUserByUsername('member');
  const cipher = createPromptCipher('tests');
  const matchingFingerprint = keyFingerprint('matching-secret-key');
  const otherFingerprint = keyFingerprint('other-secret-key');
  const tasks = [
    authTask({ userId: member.id, fingerprint: matchingFingerprint, model: 'doubao-seedance-2-0-mini-260615', cipher }),
    authTask({ userId: member.id, fingerprint: matchingFingerprint, model: 'doubao-seedance-2-0-260128', cipher, remoteTaskId: 'existing-remote' }),
    authTask({ userId: member.id, fingerprint: otherFingerprint, model: 'doubao-seedance-2-0-fast-260128', cipher })
  ];
  for (const task of tasks) await store.createTask(task);
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/models')) return json({ data: [
      { id: 'doubao-seedance-2-0-mini-260615' },
      { id: 'doubao-seedance-2-0-260128' },
      { id: 'doubao-seedance-2-0-fast-260128' }
    ] });
    if (options.method === 'POST') return json({ output: { task_id: crypto.randomUUID(), task_status: 'PENDING' } });
    return json({ output: { task_id: 'existing-remote', task_status: 'PENDING' } });
  };
  const app = createApp({ store, fetchImpl, promptCipher: cipher, logger: silentLogger });
  const { base, close } = await listen(app); t.after(close);
  const auth = await login(base, 'member', 'MemberPass123');
  const discovered = await request(base, '/api/config/discover', { method: 'POST', auth, body: { url: 'https://gateway.example/v1', apiKey: 'matching-secret-key' } });

  assert.equal(discovered.status, 200);
  assert.equal(discovered.body.resumedTaskCount, 2);
  await settleWorker(app);
  assert.notEqual((await store.getTask(tasks[0].id)).status, 'AUTH_REQUIRED');
  assert.notEqual((await store.getTask(tasks[1].id)).status, 'AUTH_REQUIRED');
  assert.equal((await store.getTask(tasks[2].id)).status, 'AUTH_REQUIRED');
  assert.equal((await store.getTask(tasks[0].id)).keyFingerprint, matchingFingerprint);
  assert.equal((await store.getTask(tasks[2].id)).keyFingerprint, otherFingerprint);
});

test('重试查询只查询原远端ID且不会发起新的生成请求', async (t) => {
  const store = await seededStore();
  await store.updateSettings({ pollIntervalMs: 1 });
  const member = await store.findUserByUsername('member');
  const cipher = createPromptCipher('query-action-tests');
  const fingerprint = keyFingerprint('query-action-key');
  const original = abnormalTask({ userId: member.id, fingerprint, cipher, status: 'UNKNOWN', remoteTaskId: 'remote-original', errorKind: 'REMOTE_TASK_NOT_FOUND' });
  await store.createTask(original);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method });
    if (url.endsWith('/models')) return json({ data: [{ id: original.model }] });
    return json({ output: { task_id: 'remote-original', task_status: 'PENDING' }, request_id: 'retry-request' });
  };
  const app = createApp({ store, fetchImpl, promptCipher: cipher, logger: silentLogger, workerOptions: { pollJitterMs: 0 } });
  const { base, close } = await listen(app); t.after(close);
  const memberAuth = await login(base, 'member', 'MemberPass123');
  await request(base, '/api/config/discover', { method: 'POST', auth: memberAuth, body: { url: 'https://gateway.example/v1', apiKey: 'query-action-key' } });

  const retried = await request(base, `/api/video/tasks/${original.id}/retry-query`, { method: 'POST', auth: memberAuth });
  assert.equal(retried.status, 200);
  assert.equal(retried.body.task.remoteTaskId, 'remote-original');
  await settleWorker(app);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
  assert.ok(calls.some((call) => call.url.endsWith('/task/remote-original')));
  const updated = await store.getTask(original.id);
  assert.equal(updated.status, 'PENDING');
  assert.equal(updated.errorKind, null);
  assert.equal(updated.notFoundAttempts, 0);
});

test('重新生成使用当前价格折扣，软删除隐藏任务并保留审计', async (t) => {
  const store = await seededStore();
  const member = await store.findUserByUsername('member');
  const adminUser = await store.findUserByUsername('admin');
  await store.updateUser(member.id, { discountRate: 0.6 });
  const cipher = createPromptCipher('task-action-tests');
  const fingerprint = keyFingerprint('task-action-key');
  const failed = abnormalTask({ userId: member.id, fingerprint, cipher, status: 'FAILED' });
  const waiting = abnormalTask({ userId: member.id, fingerprint: 'waiting-other-key', cipher, status: 'AUTH_REQUIRED', remoteTaskId: 'remote-waiting' });
  const adminOwned = abnormalTask({ userId: adminUser.id, fingerprint: 'admin-key', cipher, status: 'FAILED' });
  await store.createTask(failed);
  await store.createTask(waiting);
  await store.createTask(adminOwned);
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/models')) return json({ data: [{ id: failed.model }] });
    if (options.method === 'POST') return json({ output: { task_id: 'regenerated-remote', task_status: 'PENDING' } });
    return json({ output: { task_id: url.split('/').at(-1), task_status: 'PENDING' } });
  };
  const app = createApp({ store, fetchImpl, promptCipher: cipher, logger: silentLogger });
  const { base, close } = await listen(app); t.after(close);
  const memberAuth = await login(base, 'member', 'MemberPass123');
  await request(base, '/api/config/discover', { method: 'POST', auth: memberAuth, body: { url: 'https://gateway.example/v1', apiKey: 'task-action-key' } });

  const regenerated = await request(base, `/api/video/tasks/${failed.id}/regenerate`, { method: 'POST', auth: memberAuth });
  assert.equal(regenerated.status, 201);
  assert.equal(regenerated.body.task.retryOfTaskId, failed.id);
  const regeneratedStored = await store.getTask(regenerated.body.task.id);
  assert.equal(regeneratedStored.pricingSnapshot.discountRate, 0.6);
  assert.equal(regeneratedStored.pricingSnapshot.outputRate, 23);
  assert.equal((await store.getTask(failed.id)).status, 'FAILED');

  const cannotTouchAdminTask = await request(base, `/api/video/tasks/${adminOwned.id}`, { method: 'DELETE', auth: memberAuth });
  assert.equal(cannotTouchAdminTask.status, 404);
  const removed = await request(base, `/api/video/tasks/${failed.id}`, { method: 'DELETE', auth: memberAuth });
  assert.equal(removed.status, 200);
  assert.ok((await store.getTask(failed.id)).deletedAt);
  assert.equal((await store.listTasksByUser(member.id)).some((task) => task.id === failed.id), false);

  const adminAuth = await login(base, 'admin', 'AdminPass123');
  const adminCannotRegenerate = await request(base, `/api/video/tasks/${waiting.id}/regenerate`, { method: 'POST', auth: adminAuth });
  assert.equal(adminCannotRegenerate.status, 404);
  const adminRemoved = await request(base, `/api/admin/tasks/${waiting.id}`, { method: 'DELETE', auth: adminAuth });
  assert.equal(adminRemoved.status, 200);
  assert.equal((await store.listProcessableTasks()).some((task) => task.id === waiting.id), false);
  assert.equal((await store.listTasksAdmin()).some((task) => task.id === waiting.id), false);
  const audits = await store.listAudits(20);
  assert.ok(audits.some((entry) => entry.action === 'TASK_REGENERATED' && entry.data.retryOfTaskId === failed.id));
  assert.ok(audits.some((entry) => entry.action === 'TASK_DELETED' && entry.data.taskId === failed.id));
  assert.ok(audits.some((entry) => entry.action === 'ADMIN_TASK_DELETED' && entry.data.taskId === waiting.id));
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
async function createVideoTask(base, auth, prompt) {
  return request(base, '/api/video/tasks', { method: 'POST', auth, body: { prompt, model: 'doubao-seedance-2-0-mini-260615', resolution: '720p', ratio: '16:9', duration: 5, generateAudio: false, watermark: false } });
}
function authTask({ userId, fingerprint, model, cipher, remoteTaskId = null }) {
  const timestamp = new Date().toISOString();
  return {
    id: crypto.randomUUID(), userId, sessionHash: 'expired-session', keyFingerprint: fingerprint,
    status: 'AUTH_REQUIRED', remoteTaskId, promptEncrypted: cipher.encrypt('恢复测试'),
    model, resolution: '720p', parameters: { resolution: '720p', ratio: '16:9', duration: 5, generateAudio: false, watermark: false },
    submitUrl: 'https://gateway.example/v1/videos/generations', queryBaseUrl: 'https://gateway.example/v1/videos/generations/task',
    pricingSnapshot: { inputRate: 0, outputRate: 23, discountRate: 1, currency: 'CNY' }, createdAt: timestamp, updatedAt: timestamp
  };
}
function abnormalTask({ userId, fingerprint, cipher, status, remoteTaskId = null, errorKind = null }) {
  const timestamp = new Date().toISOString();
  return {
    id: crypto.randomUUID(), userId, keyFingerprint: fingerprint, status, remoteTaskId,
    promptEncrypted: cipher.encrypt('异常任务测试'), model: 'doubao-seedance-2-0-mini-260615', resolution: '720p',
    parameters: { resolution: '720p', ratio: '16:9', duration: 5, generateAudio: false, watermark: false },
    submitUrl: 'https://gateway.example/v1/videos/generations', queryBaseUrl: 'https://gateway.example/v1/videos/generations/task',
    pricingSnapshot: { inputRate: 0, outputRate: 23, discountRate: 1, currency: 'CNY' },
    errorKind, message: errorKind ? '远端任务不存在或暂时无法查询' : '任务异常', createdAt: timestamp, updatedAt: timestamp
  };
}
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
function captureLogger(target) { return { info: (...values) => target.push(values), error: (...values) => target.push(values) }; }
const silentLogger = { info() {}, error() {} };
