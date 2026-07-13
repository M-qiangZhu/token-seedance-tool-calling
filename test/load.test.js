import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createTaskWorker } from '../server/worker.js';
import { createPromptCipher } from '../server/security.js';
import { MemoryStore } from '../server/store.js';

test('100个排队任务只提交20个且每个用户不超过2个', async () => {
  const store = new MemoryStore();
  const cipher = createPromptCipher('load-test');
  const secrets = new Map();
  let submitted = 0;
  for (let userIndex = 0; userIndex < 20; userIndex += 1) {
    const userId = crypto.randomUUID();
    const sessionHash = `session-${userIndex}`;
    const fingerprint = `key-${userIndex}`;
    secrets.set(sessionHash, { apiKey: `secret-${userIndex}` });
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
    store, secrets, promptCipher: cipher, logger: { info() {}, error() {} },
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

function json(data) { return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
