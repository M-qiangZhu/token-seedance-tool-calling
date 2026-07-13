import { buildVideoPayload, isTerminalStatus, normalizeTaskResponse } from './video.js';
import { calculateCost } from './models.js';
import { upstreamJson } from './gateway.js';

export function createTaskWorker({ store, secrets, fetchImpl = globalThis.fetch, logger = console, promptCipher, tickMs = 2_000 }) {
  let running = false;
  let timer;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const settings = await store.getSettings();
      const tasks = await store.listProcessableTasks();
      await pollRemote(tasks, settings);
      const refreshed = await store.listProcessableTasks();
      await submitQueued(refreshed, settings);
      await store.deleteTasksOlderThan(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString());
    } catch (error) {
      logger.error?.('[worker] tick failed', { error: error?.message || 'unknown' });
    } finally { running = false; }
  }

  async function pollRemote(tasks, settings) {
    const due = tasks.filter((task) => task.remoteTaskId && ['PENDING', 'RUNNING', 'AUTH_REQUIRED'].includes(task.status));
    for (const task of due) {
      const secret = secrets.get(task.sessionHash);
      if (!secret) { if (task.status !== 'AUTH_REQUIRED') await store.updateTask(task.id, { status: 'AUTH_REQUIRED' }); continue; }
      const lastPoll = new Date(task.lastPolledAt || 0).getTime();
      const jitter = Number.parseInt(task.id.replaceAll('-', '').slice(0, 4), 16) % 3000;
      if (task.nextRetryAt && new Date(task.nextRetryAt).getTime() > Date.now()) continue;
      if (Date.now() - lastPoll < settings.pollIntervalMs + jitter) continue;
      if (Date.now() - new Date(task.createdAt).getTime() > settings.taskTimeoutMs) {
        await store.updateTask(task.id, { status: 'UNKNOWN', message: '任务查询超过60分钟，请使用远端任务ID人工核对' });
        continue;
      }
      try {
        const result = await upstreamJson(fetchImpl, `${task.queryBaseUrl}/${encodeURIComponent(task.remoteTaskId)}`, { method: 'GET', apiKey: secret.apiKey, logger });
        const normalized = normalizeTaskResponse(result.data);
        const patch = {
          ...normalized, status: normalized.status, lastPolledAt: new Date().toISOString(),
          pollDurationMs: result.durationMs, nextRetryAt: null
        };
        if (isTerminalStatus(normalized.status)) {
          patch.completedAt = new Date().toISOString();
          patch.cost = calculateCost(normalized.usage, task.pricingSnapshot);
        }
        await store.updateTask(task.id, patch);
      } catch (error) {
        const attempts = Number(task.pollAttempts || 0) + 1;
        const retryMs = Math.min((error.retryAfter || 2 ** Math.min(attempts, 6)) * 1000, 60_000);
        await store.updateTask(task.id, { pollAttempts: attempts, lastPolledAt: new Date().toISOString(), nextRetryAt: new Date(Date.now() + retryMs).toISOString(), message: error.publicMessage });
      }
    }
  }

  async function submitQueued(tasks, settings) {
    const active = tasks.filter((task) => task.remoteTaskId && !isTerminalStatus(task.status));
    const queued = tasks.filter((task) => !task.remoteTaskId && ['LOCAL_QUEUED', 'AUTH_REQUIRED'].includes(task.status));
    let globalActive = active.length;
    for (const task of queued) {
      if (globalActive >= settings.globalActiveLimit) break;
      const secret = secrets.get(task.sessionHash);
      if (!secret) { if (task.status !== 'AUTH_REQUIRED') await store.updateTask(task.id, { status: 'AUTH_REQUIRED' }); continue; }
      const userActive = active.filter((item) => item.userId === task.userId).length;
      const keyActive = active.filter((item) => item.keyFingerprint === task.keyFingerprint).length;
      if (userActive >= settings.perUserActiveLimit || keyActive >= settings.perKeyActiveLimit) continue;
      await store.updateTask(task.id, { status: 'SUBMITTING', startedAt: new Date().toISOString() });
      try {
        const prompt = promptCipher.decrypt(task.promptEncrypted);
        const payload = buildVideoPayload({ ...task.parameters, model: task.model, prompt });
        const result = await upstreamJson(fetchImpl, task.submitUrl, { method: 'POST', apiKey: secret.apiKey, body: payload, asyncVideo: true, logger });
        const normalized = normalizeTaskResponse(result.data);
        if (!normalized.remoteTaskId) throw Object.assign(new Error('平台已响应，但没有返回 task_id'), { publicMessage: '平台已响应，但没有返回 task_id', ambiguousSubmission: true });
        const next = await store.updateTask(task.id, { ...normalized, status: normalized.status, submitDurationMs: result.durationMs, submittedAt: new Date().toISOString() });
        active.push(next);
        globalActive += 1;
      } catch (error) {
        await store.updateTask(task.id, {
          status: error.ambiguousSubmission ? 'UNKNOWN' : 'FAILED',
          message: error.publicMessage || '任务提交失败', code: error.code,
          completedAt: new Date().toISOString()
        });
      }
    }
  }

  function start() { timer = setInterval(tick, tickMs); timer.unref?.(); tick(); }
  function stop() { if (timer) clearInterval(timer); }
  return { start, stop, tick };
}
