import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { upstreamJson } from './gateway.js';
import { MODEL_CAPABILITIES, modelDescriptor, supportedModels, validateModelParameters } from './models.js';
import { buildVideoPayload, normalizeGatewayUrl, normalizeModelList } from './video.js';
import { MemoryStore, publicUser } from './store.js';
import {
  AUTH_TTL_MS, clearCookieHeader, cookieHeader, createPromptCipher, hashPassword, keyFingerprint,
  newToken, parseCookie, publicError, tokenHash, validatePassword, verifyPassword
} from './security.js';
import { createTaskWorker, taskCredentialKey } from './worker.js';

export function createApp({
  fetchImpl = globalThis.fetch,
  staticDir,
  logger = console,
  store = new MemoryStore(),
  secureCookies = process.env.NODE_ENV === 'production',
  promptCipher = createPromptCipher(process.env.PROMPT_ENCRYPTION_KEY || 'local-development-only'),
  startWorker = false,
  workerOptions = {}
} = {}) {
  const app = express();
  const sessionConfigs = new Map();
  const taskCredentials = new Map();
  const loginAttempts = new Map();
  const requestWindows = new Map();
  const worker = createTaskWorker({ store, taskCredentials, fetchImpl, logger, promptCipher, ...workerOptions });

  app.locals.store = store;
  app.locals.worker = worker;
  app.locals.sessionConfigs = sessionConfigs;
  app.locals.taskCredentials = taskCredentials;
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '256kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
  app.use('/api', fixedWindow(requestWindows, { limit: 120, windowMs: 60_000, key: (req) => req.ip }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, name: '南通电信智云中心 seedance API Tools' }));
  app.get('/api/health/live', (_req, res) => res.json({ ok: true }));
  app.get('/api/health/ready', async (_req, res) => {
    try { await store.getSettings(); res.json({ ok: true, database: 'ready' }); }
    catch { res.status(503).json({ ok: false, database: 'unavailable' }); }
  });
  app.get('/api/health/upstream', requireAuth, (req, res) => {
    res.json({ ok: true, configured: sessionConfigs.has(req.auth.session.hash) });
  });

  app.post('/api/auth/login', fixedWindow(loginAttempts, { limit: 5, windowMs: 60_000, key: (req) => req.ip }), route(async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const user = await store.findUserByUsername(username);
    if (!user || user.disabled || !(await verifyPassword(user.passwordHash, password))) {
      await store.createAudit({ actorId: user?.id, action: 'LOGIN_FAILED', data: { username, ip: req.ip } });
      throw publicError(401, '用户名或密码错误');
    }
    const rawToken = newToken();
    const session = { hash: tokenHash(rawToken), userId: user.id, csrfToken: newToken(), expiresAt: new Date(Date.now() + AUTH_TTL_MS).toISOString() };
    await store.createSession(session);
    await store.createAudit({ actorId: user.id, action: 'LOGIN_SUCCEEDED', data: { ip: req.ip } });
    res.setHeader('Set-Cookie', cookieHeader(rawToken, secureCookies));
    res.json({ user: publicUser(user), csrfToken: session.csrfToken });
  }));

  app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: publicUser(req.auth.user), csrfToken: req.auth.session.csrfToken }));
  app.post('/api/auth/logout', requireAuth, requireCsrf, route(async (req, res) => {
    sessionConfigs.delete(req.auth.session.hash);
    await store.deleteSession(req.auth.session.hash);
    res.setHeader('Set-Cookie', clearCookieHeader(secureCookies));
    res.json({ ok: true });
  }));
  app.post('/api/auth/change-password', requireAuth, requireCsrf, route(async (req, res) => {
    const passwordHash = await hashPassword(validatePassword(req.body.password));
    const user = await store.updateUser(req.auth.user.id, { passwordHash, mustChangePassword: false });
    await store.createAudit({ actorId: user.id, action: 'PASSWORD_CHANGED', data: {} });
    res.json({ user: publicUser(user) });
  }));

  app.get('/api/config', requireAuth, (req, res) => {
    const config = sessionConfigs.get(req.auth.session.hash);
    res.json(config ? { configured: true, config: publicConfig(config) } : { configured: false });
  });

  app.post('/api/config/discover', requireAuth, requireChangedPassword, requireCsrf,
    fixedWindow(requestWindows, { limit: 10, windowMs: 60_000, key: (req) => `discover:${req.auth.user.id}` }),
    route(async (req, res) => {
      const previous = sessionConfigs.get(req.auth.session.hash);
      const apiKey = String(req.body.apiKey || '').trim() || previous?.apiKey;
      if (!apiKey) throw publicError(400, '请填写 API Key');
      const endpoints = validation(() => normalizeGatewayUrl(req.body.url || previous?.submitUrl));
      const result = await upstreamJson(fetchImpl, endpoints.modelsUrl, { method: 'GET', apiKey, operation: 'list-models', logger });
      const allModels = normalizeModelList(result.data);
      const models = supportedModels(allModels);
      if (!models.length) throw publicError(403, '当前 Key 未发现受支持的 Seedance 模型');
      const model = models.includes(previous?.model) ? previous.model : models[0];
      const config = { ...endpoints, apiKey, model, models, keyFingerprint: keyFingerprint(apiKey), expiresAt: Date.now() + AUTH_TTL_MS };
      sessionConfigs.set(req.auth.session.hash, config);
      taskCredentials.set(taskCredentialKey(req.auth.user.id, config.keyFingerprint), { apiKey });
      const resumedTaskCount = await store.resumeAuthTasks(req.auth.user.id, config.keyFingerprint);
      worker.tick();
      res.json({ ok: true, config: publicConfig(config), models: models.map(modelDescriptor), resumedTaskCount, durationMs: result.durationMs });
    }));

  app.put('/api/config/model', requireAuth, requireChangedPassword, requireCsrf, route(async (req, res) => {
    const config = requireSecret(req, sessionConfigs);
    const model = String(req.body.model || '');
    if (!config.models.includes(model)) throw publicError(400, '请选择当前 Key 实际可用的 Seedance 模型');
    config.model = model;
    config.expiresAt = Date.now() + AUTH_TTL_MS;
    res.json({ ok: true, config: publicConfig(config) });
  }));

  app.post('/api/video/tasks', requireAuth, requireChangedPassword, requireCsrf,
    fixedWindow(requestWindows, { limit: 6, windowMs: 60_000, key: (req) => `submit:${req.auth.user.id}` }),
    route(async (req, res) => {
      const config = requireSecret(req, sessionConfigs);
      const { task, queuePosition } = await createQueuedTask(req, config, req.body);
      worker.tick();
      res.status(201).json({ task: publicTask(task, promptCipher), queuePosition });
    }));

  app.get('/api/video/tasks', requireAuth, requireChangedPassword, route(async (req, res) => {
    const tasks = await store.listTasksByUser(req.auth.user.id, Math.min(Number(req.query.limit) || 100, 200));
    res.json({ tasks: tasks.map((task) => publicTask(task, promptCipher)) });
  }));
  app.get('/api/video/tasks/:taskId', requireAuth, requireChangedPassword, route(async (req, res) => {
    const task = await store.getTask(req.params.taskId);
    if (!task || task.deletedAt || task.userId !== req.auth.user.id) throw publicError(404, '没有找到这个任务');
    worker.tick();
    res.json({ task: publicTask(task, promptCipher) });
  }));
  app.post('/api/video/tasks/:taskId/retry-query', requireAuth, requireChangedPassword, requireCsrf, route(async (req, res) => {
    const task = await requireOwnedTask(req.params.taskId, req.auth.user.id);
    validateQueryRetry(task);
    requireTaskCredential(req, task);
    const updated = await resetTaskForQuery(task);
    await store.createAudit({ actorId: req.auth.user.id, action: 'TASK_QUERY_RETRIED', data: { taskId: task.id, remoteTaskId: task.remoteTaskId } });
    worker.tick();
    res.json({ task: publicTask(updated, promptCipher) });
  }));
  app.post('/api/video/tasks/:taskId/regenerate', requireAuth, requireChangedPassword, requireCsrf,
    fixedWindow(requestWindows, { limit: 6, windowMs: 60_000, key: (req) => `submit:${req.auth.user.id}` }),
    route(async (req, res) => {
      const original = await requireOwnedTask(req.params.taskId, req.auth.user.id);
      if (!['FAILED', 'UNKNOWN'].includes(original.status)) throw publicError(409, '只有失败或状态待核对的任务可以重新生成', 'TASK_NOT_REGENERATABLE');
      const config = requireSecret(req, sessionConfigs);
      let prompt;
      try { prompt = promptCipher.decrypt(original.promptEncrypted); }
      catch { throw publicError(409, '原任务提示词无法解密，不能重新生成', 'TASK_PROMPT_UNAVAILABLE'); }
      const input = { ...original.parameters, prompt, model: original.model, resolution: original.resolution };
      const { task, queuePosition } = await createQueuedTask(req, config, input, original.id);
      await store.createAudit({ actorId: req.auth.user.id, action: 'TASK_REGENERATED', data: { taskId: task.id, retryOfTaskId: original.id } });
      worker.tick();
      res.status(201).json({ task: publicTask(task, promptCipher), queuePosition });
    }));
  app.delete('/api/video/tasks/:taskId', requireAuth, requireChangedPassword, requireCsrf, route(async (req, res) => {
    const task = await requireOwnedTask(req.params.taskId, req.auth.user.id);
    const deleted = await softDeleteTask(task, req.auth.user.id);
    res.json({ ok: true, taskId: deleted.id });
  }));

  app.get('/api/admin/users', requireAuth, requireChangedPassword, requireAdmin, route(async (_req, res) => {
    res.json({ users: (await store.listUsers()).map(publicUser) });
  }));
  app.post('/api/admin/users', requireAuth, requireChangedPassword, requireAdmin, requireCsrf, route(async (req, res) => {
    const username = validateUsername(req.body.username);
    const passwordHash = await hashPassword(req.body.password);
    let user;
    try { user = await store.createUser({ id: crypto.randomUUID(), username, passwordHash, role: req.body.role === 'ADMIN' ? 'ADMIN' : 'USER', discountRate: req.body.discountRate === undefined ? 1 : discountRate(req.body.discountRate), mustChangePassword: true }); }
    catch (error) { if (error.code === 'DUPLICATE') throw publicError(409, '用户名已存在'); throw error; }
    await store.createAudit({ actorId: req.auth.user.id, action: 'USER_CREATED', data: { userId: user.id, username: user.username, role: user.role } });
    res.status(201).json({ user: publicUser(user) });
  }));
  app.patch('/api/admin/users/:id', requireAuth, requireChangedPassword, requireAdmin, requireCsrf, route(async (req, res) => {
    if (req.params.id === req.auth.user.id && (req.body.disabled === true || req.body.role === 'USER')) throw publicError(400, '不能禁用或降级当前管理员账号');
    const patch = {};
    if (req.body.role) patch.role = req.body.role === 'ADMIN' ? 'ADMIN' : 'USER';
    if (typeof req.body.disabled === 'boolean') patch.disabled = req.body.disabled;
    if (req.body.password) { patch.passwordHash = await hashPassword(req.body.password); patch.mustChangePassword = true; }
    if (req.body.discountRate !== undefined) patch.discountRate = discountRate(req.body.discountRate);
    const user = await store.updateUser(req.params.id, patch);
    if (!user) throw publicError(404, '用户不存在');
    await store.createAudit({ actorId: req.auth.user.id, action: 'USER_UPDATED', data: { userId: user.id, fields: Object.keys(patch).filter((key) => key !== 'passwordHash') } });
    res.json({ user: publicUser(user) });
  }));

  app.get('/api/admin/pricing', requireAuth, requireChangedPassword, requireAdmin, route(async (_req, res) => res.json({ pricing: await store.listPricing() })));
  app.put('/api/admin/pricing', requireAuth, requireChangedPassword, requireAdmin, requireCsrf, route(async (req, res) => {
    const descriptor = modelDescriptor(String(req.body.model));
    const resolution = String(req.body.resolution || '').toLowerCase();
    if (!descriptor?.resolutions.includes(resolution)) throw publicError(400, '模型或分辨率不受支持');
    const inputRate = priceNumber(req.body.inputRate);
    const outputRate = priceNumber(req.body.outputRate);
    const before = await store.getPricing(req.body.model, resolution);
    const pricing = await store.upsertPricing({ model: req.body.model, resolution, inputRate, outputRate, currency: 'CNY', updatedBy: req.auth.user.id });
    await store.createAudit({ actorId: req.auth.user.id, action: 'PRICING_UPDATED', data: { model: pricing.model, resolution, before: before && { inputRate: before.inputRate, outputRate: before.outputRate }, after: { inputRate, outputRate } } });
    res.json({ pricing });
  }));

  app.get('/api/admin/settings', requireAuth, requireChangedPassword, requireAdmin, route(async (_req, res) => res.json({ settings: await store.getSettings() })));
  app.put('/api/admin/settings', requireAuth, requireChangedPassword, requireAdmin, requireCsrf, route(async (req, res) => {
    const allowed = ['globalActiveLimit','perUserActiveLimit','perUserQueueLimit','perKeyActiveLimit','globalQueueLimit','pollIntervalMs','taskTimeoutMs'];
    const patch = {};
    for (const key of allowed) if (req.body[key] !== undefined) patch[key] = positiveInteger(req.body[key], key);
    const settings = await store.updateSettings(patch);
    await store.createAudit({ actorId: req.auth.user.id, action: 'SETTINGS_UPDATED', data: patch });
    res.json({ settings });
  }));
  app.get('/api/admin/tasks', requireAuth, requireChangedPassword, requireAdmin, route(async (req, res) => {
    const tasks = await store.listTasksAdmin(Math.min(Number(req.query.limit) || 200, 500));
    res.json({ tasks: tasks.map(adminTask) });
  }));
  app.post('/api/admin/tasks/:taskId/retry-query', requireAuth, requireChangedPassword, requireAdmin, requireCsrf, route(async (req, res) => {
    const task = await requireVisibleTask(req.params.taskId);
    validateQueryRetry(task);
    requireTaskCredential(req, task, false);
    const updated = await resetTaskForQuery(task);
    await store.createAudit({ actorId: req.auth.user.id, action: 'ADMIN_TASK_QUERY_RETRIED', data: { taskId: task.id, userId: task.userId, remoteTaskId: task.remoteTaskId } });
    worker.tick();
    res.json({ task: adminTask({ ...updated, username: (await store.findUserById(task.userId))?.username }) });
  }));
  app.delete('/api/admin/tasks/:taskId', requireAuth, requireChangedPassword, requireAdmin, requireCsrf, route(async (req, res) => {
    const task = await requireVisibleTask(req.params.taskId);
    const deleted = await softDeleteTask(task, req.auth.user.id, true);
    res.json({ ok: true, taskId: deleted.id });
  }));
  app.get('/api/admin/dashboard', requireAuth, requireChangedPassword, requireAdmin, route(async (_req, res) => res.json({ dashboard: await store.dashboard() })));
  app.get('/api/admin/audits', requireAuth, requireChangedPassword, requireAdmin, route(async (_req, res) => res.json({ audits: await store.listAudits(100) })));

  if (staticDir) {
    app.use(express.static(staticDir));
    app.use((req, res, next) => req.path.startsWith('/api/') ? next() : res.sendFile(path.join(staticDir, 'index.html')));
  }
  app.use('/api', (_req, res) => res.status(404).json({ error: { message: '接口不存在' } }));
  app.use((error, _req, res, _next) => sendError(res, error, logger));
  if (startWorker) worker.start();
  return app;

  async function requireAuth(req, _res, next) {
    try {
      const rawToken = parseCookie(req);
      if (!rawToken) throw publicError(401, '请先登录');
      const session = await store.findSession(tokenHash(rawToken));
      if (!session || session.user.disabled) throw publicError(401, '登录已失效，请重新登录');
      req.auth = { session, user: session.user };
      await store.touchSession(session.hash, new Date(Date.now() + AUTH_TTL_MS).toISOString());
      next();
    } catch (error) { next(error); }
  }

  async function createQueuedTask(req, config, input, retryOfTaskId = null) {
    const model = String(input.model || config.model);
    if (!config.models.includes(model)) throw publicError(400, '所选模型不在当前 Key 的可用列表中');
    const validated = validation(() => validateModelParameters(model, input.resolution, input.duration));
    const payload = validation(() => buildVideoPayload({ ...input, model, resolution: validated.resolution, duration: validated.duration }));
    const processable = await store.listProcessableTasks();
    const queuedForUser = processable.filter((task) => task.userId === req.auth.user.id && !task.remoteTaskId).length;
    const globalQueued = processable.filter((task) => !task.remoteTaskId).length;
    const settings = await store.getSettings();
    if (queuedForUser >= settings.perUserQueueLimit) throw publicError(429, '你的排队任务已达上限，请等待已有任务开始处理', 'USER_QUEUE_FULL');
    if (globalQueued >= settings.globalQueueLimit) throw publicError(429, '系统排队任务已满，请稍后再试', 'GLOBAL_QUEUE_FULL');
    const prompt = payload.content.find((item) => item.type === 'text').text;
    const pricing = await store.getPricing(model, validated.resolution);
    const pricingSnapshot = pricing && { ...pricing, discountRate: req.auth.user.discountRate ?? 1 };
    const now = new Date().toISOString();
    const task = {
      id: crypto.randomUUID(), userId: req.auth.user.id, sessionHash: req.auth.session.hash,
      keyFingerprint: config.keyFingerprint, status: 'LOCAL_QUEUED', remoteTaskId: null,
      promptEncrypted: promptCipher.encrypt(prompt), model, resolution: validated.resolution,
      parameters: { resolution: validated.resolution, ratio: payload.ratio, duration: validated.duration, generateAudio: payload.generate_audio, watermark: payload.watermark },
      submitUrl: config.submitUrl, queryBaseUrl: config.queryBaseUrl,
      pricingSnapshot, usage: null, cost: null, videoUrl: null,
      retryOfTaskId: retryOfTaskId || null, createdAt: now, updatedAt: now
    };
    await store.createTask(task);
    taskCredentials.set(taskCredentialKey(task.userId, task.keyFingerprint), { apiKey: config.apiKey });
    return { task, queuePosition: globalQueued + 1 };
  }

  async function requireVisibleTask(taskId) {
    const task = await store.getTask(taskId);
    if (!task || task.deletedAt) throw publicError(404, '没有找到这个任务');
    return task;
  }

  async function requireOwnedTask(taskId, userId) {
    const task = await requireVisibleTask(taskId);
    if (task.userId !== userId) throw publicError(404, '没有找到这个任务');
    return task;
  }

  function requireTaskCredential(req, task, allowSessionConfig = true) {
    const credentialId = taskCredentialKey(task.userId, task.keyFingerprint);
    if (taskCredentials.has(credentialId)) return taskCredentials.get(credentialId);
    const config = allowSessionConfig ? sessionConfigs.get(req.auth.session.hash) : null;
    if (config?.keyFingerprint === task.keyFingerprint) {
      const credential = { apiKey: config.apiKey };
      taskCredentials.set(credentialId, credential);
      return credential;
    }
    throw publicError(409, '请先重新填写创建该任务时使用的 API Key', 'TASK_API_KEY_REQUIRED');
  }

  function validateQueryRetry(task) {
    if (!task.remoteTaskId) throw publicError(409, '这个任务没有远端任务 ID，无法重试查询', 'REMOTE_TASK_ID_MISSING');
    if (!(task.status === 'UNKNOWN' || task.errorKind || task.upstreamStatus)) {
      throw publicError(409, '当前任务没有需要重试的查询异常', 'TASK_QUERY_NOT_RETRYABLE');
    }
  }

  async function resetTaskForQuery(task) {
    return store.updateTask(task.id, {
      status: 'PENDING', completedAt: null, pollAttempts: 0, notFoundAttempts: 0,
      lastPolledAt: null, nextRetryAt: null, message: null, code: null,
      upstreamStatus: null, upstreamCode: null, errorKind: null, requestId: null
    });
  }

  async function softDeleteTask(task, actorId, admin = false) {
    if (!['FAILED', 'UNKNOWN', 'AUTH_REQUIRED'].includes(task.status)) {
      throw publicError(409, '只有失败、状态待核对或等待 API Key 的任务可以移除', 'TASK_NOT_REMOVABLE');
    }
    const deletedAt = new Date().toISOString();
    const deleted = await store.updateTask(task.id, { deletedAt, deletedBy: actorId });
    await store.createAudit({ actorId, action: admin ? 'ADMIN_TASK_DELETED' : 'TASK_DELETED', data: { taskId: task.id, userId: task.userId, remoteTaskId: task.remoteTaskId || null } });
    worker.tick();
    return deleted;
  }
}

function requireCsrf(req, _res, next) {
  if (req.headers['x-csrf-token'] !== req.auth.session.csrfToken) return next(publicError(403, '安全校验失败，请刷新页面后重试'));
  next();
}
function requireChangedPassword(req, _res, next) { return req.auth.user.mustChangePassword ? next(publicError(403, '请先修改初始密码', 'PASSWORD_CHANGE_REQUIRED')) : next(); }
function requireAdmin(req, _res, next) { return req.auth.user.role !== 'ADMIN' ? next(publicError(403, '需要管理员权限')) : next(); }
function requireSecret(req, sessionConfigs) {
  const config = sessionConfigs.get(req.auth.session.hash);
  if (!config || config.expiresAt < Date.now()) throw publicError(401, 'API Key配置已失效，请重新填写');
  return config;
}

function publicConfig(config) {
  return {
    submitUrl: config.submitUrl, modelsUrl: config.modelsUrl, model: config.model,
    models: config.models.map(modelDescriptor), apiKeyMasked: `••••${config.apiKey.slice(-4)}`
  };
}
function publicTask(task, cipher) {
  const internal = new Set(['userId','sessionHash','keyFingerprint','promptEncrypted','submitUrl','queryBaseUrl','pricingSnapshot']);
  const result = Object.fromEntries(Object.entries(task).filter(([key]) => !internal.has(key)));
  try { result.prompt = cipher.decrypt(task.promptEncrypted); } catch { result.prompt = '提示词解密失败'; }
  result.pricing = task.pricingSnapshot && { inputRate: task.pricingSnapshot.inputRate, outputRate: task.pricingSnapshot.outputRate, discountRate: task.pricingSnapshot.discountRate, currency: task.pricingSnapshot.currency, version: task.pricingSnapshot.version };
  return result;
}
function adminTask(task) {
  return {
    id: task.id, userId: task.userId, username: task.username, remoteTaskId: task.remoteTaskId, status: task.status,
    model: task.model, resolution: task.resolution, usage: task.usage, cost: task.cost,
    code: task.code, message: task.message, upstreamStatus: task.upstreamStatus,
    upstreamCode: task.upstreamCode, errorKind: task.errorKind, requestId: task.requestId,
    pollAttempts: task.pollAttempts, notFoundAttempts: task.notFoundAttempts,
    retryOfTaskId: task.retryOfTaskId, createdAt: task.createdAt, completedAt: task.completedAt
  };
}

function fixedWindow(windows, { limit, windowMs, key }) {
  return (req, _res, next) => {
    const id = key(req);
    const current = windows.get(id);
    const timestamp = Date.now();
    if (!current || current.resetAt <= timestamp) windows.set(id, { count: 1, resetAt: timestamp + windowMs });
    else if (++current.count > limit) return next(publicError(429, '请求过于频繁，请稍后再试'));
    next();
  };
}
function route(handler) { return (req, res, next) => Promise.resolve(handler(req, res)).catch(next); }
function sendError(res, error, logger) {
  const status = error.status || 500;
  if (status >= 500) logger.error?.('[api] request failed', { code: error.code, status, error: error?.message });
  res.status(status).json({ error: { message: error.publicMessage || (status < 500 ? error.message : '服务暂时不可用，请稍后重试'), code: error.code, upstreamStatus: error.upstreamStatus, upstreamCode: error.upstreamCode, errorKind: error.errorKind, requestId: error.requestId } });
}
function validateUsername(value) {
  const username = String(value || '').trim();
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw publicError(400, '用户名需为3–32位字母、数字、点、横线或下划线');
  return username;
}
function priceNumber(value) { const number = Number(value); if (!Number.isFinite(number) || number < 0 || number > 1_000_000) throw publicError(400, '单价必须是有效的非负数字'); return number; }
function discountRate(value) { const number = Number(value); if (!Number.isFinite(number) || number < 0 || number > 1) throw publicError(400, '折扣率必须是0到1之间的数字'); return number; }
function positiveInteger(value, label) { const number = Number(value); if (!Number.isInteger(number) || number <= 0 || number > 3_600_000) throw publicError(400, `${label}必须是有效正整数`); return number; }
function validation(fn) { try { return fn(); } catch (error) { throw publicError(400, error.message); } }

export { MODEL_CAPABILITIES };
