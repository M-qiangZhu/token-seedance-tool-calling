import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../server/app.js';

test('完整模拟创建、轮询和成功流程，响应不泄露 API Key', async (t) => {
  const upstreamCalls = [];
  const diagnostics = [];
  const logger = {
    info: (...values) => diagnostics.push(values),
    error: (...values) => diagnostics.push(values)
  };
  let pollCount = 0;
  const mockFetch = async (url, options) => {
    upstreamCalls.push({ url, options });
    if (url.endsWith('/models')) return json({ data: [{ id: 'seedance-1.0-pro' }] });
    if (options.method === 'POST') return json({ output: { task_id: 'remote-123', task_status: 'PENDING' }, request_id: 'req-1' });
    pollCount += 1;
    return pollCount === 1
      ? json({ output: { task_id: 'remote-123', task_status: 'RUNNING' } })
      : json({ output: { task_id: 'remote-123', task_status: 'SUCCEEDED', video_url: 'https://cdn.example/video.mp4' }, usage: { duration: 5 } });
  };

  const server = createApp({ fetchImpl: mockFetch, logger }).listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const configResponse = await fetch(`${base}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://gateway.example/v1', apiKey: 'super-secret-key', model: 'seedance-1.0-pro' })
  });
  const cookie = configResponse.headers.get('set-cookie').split(';')[0];
  const configText = await configResponse.text();
  assert.equal(configResponse.status, 200);
  assert.equal(configText.includes('super-secret-key'), false);
  assert.match(configText, /••••-key/);

  const models = await request(base, '/api/models/discover', { method: 'POST', cookie });
  assert.deepEqual(models.body.models, ['seedance-1.0-pro']);

  const created = await request(base, '/api/video/tasks', {
    method: 'POST', cookie,
    body: {
      prompt: '云海中的城市', resolution: '720p', ratio: '16:9', duration: 5,
      generateAudio: false, watermark: false
    }
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.task.status, 'PENDING');
  assert.equal(created.body.task.prompt, '云海中的城市');
  assert.equal(typeof upstreamCalls[1].options.body, 'string');
  assert.deepEqual(JSON.parse(upstreamCalls[1].options.body), {
    model: 'seedance-1.0-pro',
    content: [{ type: 'text', text: '云海中的城市' }],
    resolution: '720p',
    ratio: '16:9',
    duration: 5,
    generate_audio: false,
    watermark: false
  });
  assert.equal(upstreamCalls[1].options.headers['Content-Type'], 'application/json');
  assert.equal(upstreamCalls[1].options.headers['X-DashScope-Async'], 'enable');
  assert.equal(upstreamCalls[0].options.headers['X-DashScope-Async'], undefined);

  const running = await request(base, '/api/video/tasks/remote-123', { cookie });
  assert.equal(running.body.task.status, 'RUNNING');
  const completed = await request(base, '/api/video/tasks/remote-123', { cookie });
  assert.equal(completed.body.task.status, 'SUCCEEDED');
  assert.equal(completed.body.task.videoUrl, 'https://cdn.example/video.mp4');

  assert.ok(upstreamCalls.every((call) => call.options.headers.Authorization === 'Bearer super-secret-key'));
  assert.equal(upstreamCalls.slice(2).every((call) => call.options.headers['X-DashScope-Async'] === undefined), true);
  assert.equal(upstreamCalls[1].options.body.includes('super-secret-key'), false);
  const diagnosticText = JSON.stringify(diagnostics);
  assert.equal(diagnosticText.includes('super-secret-key'), false);
  assert.equal(diagnosticText.includes('云海中的城市'), false);
  assert.match(diagnosticText, /bodyFields/);
});

test('上游错误被转换为清晰且不含密钥的响应', async (t) => {
  const mockFetch = async () => json({ error: { message: '模型没有权限：never-return-this', code: 'Forbidden' }, request_id: 'req-error' }, 403);
  const server = createApp({ fetchImpl: mockFetch }).listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = await fetch(`${base}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://gateway.example/v1', apiKey: 'never-return-this', model: 'seedance' })
  });
  const cookie = config.headers.get('set-cookie').split(';')[0];
  const result = await request(base, '/api/models/discover', { method: 'POST', cookie });
  assert.equal(result.status, 403);
  assert.equal(JSON.stringify(result.body).includes('never-return-this'), false);
  assert.equal(result.body.error.message, '模型没有权限：[REDACTED]');
  assert.equal(result.body.error.requestId, 'req-error');
});

test('兼容方舟原生成功响应的视频地址', async (t) => {
  const mockFetch = async (_url, options) => options.method === 'POST'
    ? json({ id: 'ark-task', status: 'queued' })
    : json({ id: 'ark-task', status: 'succeeded', content: { video_url: 'https://cdn.example/native.mp4' } });
  const server = createApp({ fetchImpl: mockFetch, logger: silentLogger }).listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = await configure(base);
  const created = await request(base, '/api/video/tasks', {
    method: 'POST', cookie, body: { prompt: '南京长江大桥', resolution: '720p', ratio: '16:9', duration: 5 }
  });
  assert.equal(created.body.task.id, 'ark-task');
  const completed = await request(base, '/api/video/tasks/ark-task', { cookie });
  assert.equal(completed.body.task.status, 'SUCCEEDED');
  assert.equal(completed.body.task.videoUrl, 'https://cdn.example/native.mp4');
});

test('网络中断和 2xx 缺少任务 ID 时不重复提交', async (t) => {
  let calls = 0;
  const noIdServer = createApp({
    fetchImpl: async () => { calls += 1; return json({ status: 'queued' }); },
    logger: silentLogger
  }).listen(0);
  t.after(() => noIdServer.close());
  await new Promise((resolve) => noIdServer.once('listening', resolve));
  const noIdBase = `http://127.0.0.1:${noIdServer.address().port}`;
  const noIdCookie = await configure(noIdBase);
  const noId = await request(noIdBase, '/api/video/tasks', {
    method: 'POST', cookie: noIdCookie, body: { prompt: '测试', resolution: '720p', ratio: '16:9', duration: 5 }
  });
  assert.equal(noId.status, 502);
  assert.equal(calls, 1);

  let networkCalls = 0;
  const networkServer = createApp({
    fetchImpl: async () => { networkCalls += 1; throw new Error('offline'); },
    logger: silentLogger
  }).listen(0);
  t.after(() => networkServer.close());
  await new Promise((resolve) => networkServer.once('listening', resolve));
  const networkBase = `http://127.0.0.1:${networkServer.address().port}`;
  const networkCookie = await configure(networkBase);
  const network = await request(networkBase, '/api/video/tasks', {
    method: 'POST', cookie: networkCookie, body: { prompt: '测试', resolution: '720p', ratio: '16:9', duration: 5 }
  });
  assert.equal(network.status, 502);
  assert.equal(networkCalls, 1);
});

async function request(base, pathname, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, body: await response.json() };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function configure(base) {
  const response = await fetch(`${base}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: 'https://gateway.example/v1', apiKey: 'test-secret-key', model: 'doubao-seedance-2-0-mini-260615'
    })
  });
  return response.headers.get('set-cookie').split(';')[0];
}

const silentLogger = { info() {}, error() {} };
