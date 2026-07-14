import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createTaskWorker, taskCredentialKey } from '../server/worker.js';
import { createPromptCipher } from '../server/security.js';
import { MemoryStore } from '../server/store.js';

test('100个排队任务只提交20个且每个用户不超过2个', async () => {
  const store = new MemoryStore();
  const cipher = createPromptCipher('load-test');
  const taskCredentials = new Map();
  let submitted = 0;
  for (let userIndex = 0; userIndex < 20; userIndex += 1) {
    const userId = crypto.randomUUID();
    const sessionHash = `session-${userIndex}`;
    const fingerprint = `key-${userIndex}`;
    taskCredentials.set(taskCredentialKey(userId, fingerprint), { apiKey: `secret-${userIndex}` });
    for (let taskIndex = 0; taskIndex < 5; taskIndex += 1) {
      const timestamp = new Date(Date.now() + userIndex * 100 + taskIndex).toISOString();
      await store.createTask({
        id: crypto.randomUUID(), userId, sessionHash, keyFingerprint: fingerprint,
        status: 'LOCAL_QUEUED', remoteTaskId: null, promptEncrypted: cipher.encrypt('负载测试'),
        model: 'doubao-seedance-2-0-mini-260615', resolution: '720p',
        parameters: { resolution: '720p', ratio: '16:9', duration: 5 },
        submitUrl: 'https://gateway.example/v1/videos/generations', queryBaseUrl: 'https://gateway.example/v1/videos/generations/task',
        pricingSnapshot: { inputRate: 0, outputRate: 23, currency: 'CNY' }, createdAt: timestamp, updatedAt: timestamp
      });
    }
  }
  const worker = createTaskWorker({
    store, taskCredentials, promptCipher: cipher, logger: { info() {}, error() {} },
    fetchImpl: async (_url, options) => {
      if (options.method !== 'POST') return json({ output: { task_status: 'PENDING' } });
      submitted += 1;
      return json({ output: { task_id: `remote-${submitted}`, task_status: 'PENDING' } });
    }
  });
  await worker.tick();
  const tasks = await store.listProcessableTasks();
  const active = tasks.filter((task) => task.remoteTaskId);
  assert.equal(submitted, 20);
  assert.equal(active.length, 20);
  const byUser = Object.groupBy(active, (task) => task.userId);
  assert.ok(Object.values(byUser).every((items) => items.length <= 2));
  assert.equal(tasks.filter((task) => !task.remoteTaskId).length, 80);
});

test('远端查询返回401时清除后台凭证并等待重新填写Key', async () => {
  const store = new MemoryStore();
  const cipher = createPromptCipher('auth-test');
  const userId = crypto.randomUUID();
  const fingerprint = 'expired-key';
  const taskCredentials = new Map([[taskCredentialKey(userId, fingerprint), { apiKey: 'expired-secret' }]]);
  const timestamp = new Date().toISOString();
  const task = await store.createTask({
    id: crypto.randomUUID(), userId, sessionHash: 'old-session', keyFingerprint: fingerprint,
    status: 'PENDING', remoteTaskId: 'remote-auth', promptEncrypted: cipher.encrypt('鉴权恢复测试'),
    model: 'doubao-seedance-2-0-mini-260615', resolution: '720p',
    parameters: { resolution: '720p', ratio: '16:9', duration: 5 },
    submitUrl: 'https://gateway.example/v1/videos/generations', queryBaseUrl: 'https://gateway.example/v1/videos/generations/task',
    pricingSnapshot: { inputRate: 0, outputRate: 23, currency: 'CNY' }, createdAt: timestamp, updatedAt: timestamp
  });
  const worker = createTaskWorker({
    store, taskCredentials, promptCipher: cipher, pollJitterMs: 0, logger: { info() {}, error() {} },
    fetchImpl: async () => json({ message: 'Unauthorized' }, 401)
  });

  await worker.tick();
  const updated = await store.getTask(task.id);
  assert.equal(updated.status, 'AUTH_REQUIRED');
  assert.match(updated.message, /API Key 已失效/);
  assert.equal(taskCredentials.size, 0);
});

test('远端查询连续5次404后停止轮询并保留排查元数据', async () => {
  const store = new MemoryStore();
  await store.updateSettings({ pollIntervalMs: 1 });
  const cipher = createPromptCipher('not-found-test');
  const userId = crypto.randomUUID();
  const fingerprint = 'query-key';
  const taskCredentials = new Map([[taskCredentialKey(userId, fingerprint), { apiKey: 'query-secret' }]]);
  const timestamp = new Date().toISOString();
  const task = await store.createTask({
    id: crypto.randomUUID(), userId, keyFingerprint: fingerprint, status: 'PENDING', remoteTaskId: 'missing-remote',
    promptEncrypted: cipher.encrypt('查询测试'), model: 'doubao-seedance-2-0-mini-260615', resolution: '720p',
    parameters: { resolution: '720p', ratio: '16:9', duration: 5 },
    submitUrl: 'https://gateway.example/v1/videos/generations', queryBaseUrl: 'https://gateway.example/v1/videos/generations/task',
    pricingSnapshot: { inputRate: 0, outputRate: 23, currency: 'CNY' }, createdAt: timestamp, updatedAt: timestamp
  });
  const worker = createTaskWorker({
    store, taskCredentials, promptCipher: cipher, pollJitterMs: 0, logger: { info() {}, error() {} },
    fetchImpl: async () => new Response(JSON.stringify({ error: { code: '404', message: 'not found' }, request_id: 'query-request' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    await store.updateTask(task.id, { nextRetryAt: null, lastPolledAt: null });
    await worker.tick();
  }
  const updated = await store.getTask(task.id);
  assert.equal(updated.status, 'UNKNOWN');
  assert.equal(updated.notFoundAttempts, 5);
  assert.equal(updated.errorKind, 'REMOTE_TASK_NOT_FOUND');
  assert.equal(updated.upstreamStatus, 404);
  assert.equal(updated.upstreamCode, '404');
  assert.equal(updated.requestId, 'query-request');
  assert.match(updated.message, /停止自动轮询/);
  assert.equal((await store.listProcessableTasks()).some((item) => item.id === task.id), false);
});

test('远端查询恢复成功后清空旧错误和失败计数', async () => {
  const store = new MemoryStore();
  await store.updateSettings({ pollIntervalMs: 1 });
  const cipher = createPromptCipher('query-recovery-test');
  const userId = crypto.randomUUID();
  const fingerprint = 'recovery-key';
  const taskCredentials = new Map([[taskCredentialKey(userId, fingerprint), { apiKey: 'recovery-secret' }]]);
  const timestamp = new Date().toISOString();
  const task = await store.createTask({
    id: crypto.randomUUID(), userId, keyFingerprint: fingerprint, status: 'PENDING', remoteTaskId: 'remote-recovery',
    promptEncrypted: cipher.encrypt('恢复测试'), model: 'doubao-seedance-2-0-mini-260615', resolution: '720p',
    parameters: { resolution: '720p', ratio: '16:9', duration: 5 },
    submitUrl: 'https://gateway.example/v1/videos/generations', queryBaseUrl: 'https://gateway.example/v1/videos/generations/task',
    pricingSnapshot: { inputRate: 0, outputRate: 23, currency: 'CNY' }, createdAt: timestamp, updatedAt: timestamp
  });
  let failing = true;
  const worker = createTaskWorker({
    store, taskCredentials, promptCipher: cipher, pollJitterMs: 0, logger: { info() {}, error() {} },
    fetchImpl: async () => failing
      ? json({ error: { code: '404', message: 'not found' } }, 404)
      : json({ output: { task_id: 'remote-recovery', task_status: 'RUNNING' }, request_id: 'recovered-request' })
  });
  await worker.tick();
  failing = false;
  await new Promise((resolve) => setTimeout(resolve, 2));
  await store.updateTask(task.id, { nextRetryAt: null, lastPolledAt: null });
  await worker.tick();
  const updated = await store.getTask(task.id);
  assert.equal(updated.status, 'RUNNING');
  assert.equal(updated.pollAttempts, 0);
  assert.equal(updated.notFoundAttempts, 0);
  assert.equal(updated.errorKind, null);
  assert.equal(updated.upstreamStatus, null);
  assert.equal(updated.message, null);
  assert.equal(updated.requestId, 'recovered-request');
});

function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
