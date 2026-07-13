import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import {
  buildVideoPayload,
  isTerminalStatus,
  normalizeGatewayUrl,
  normalizeModelList,
  normalizeTaskResponse
} from './video.js';

const SESSION_COOKIE = 'tokenhub_sid';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export function createApp({ fetchImpl = globalThis.fetch, staticDir, logger = console } = {}) {
  const app = express();
  const sessions = new Map();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, name: 'TokenHub Seedance 视频工作台 API' });
  });

  app.get('/api/config', (req, res) => {
    const session = getSession(req, sessions);
    if (!session?.config) return res.json({ configured: false });
    res.json({ configured: true, config: publicConfig(session.config) });
  });

  app.post('/api/config', (req, res) => safe(res, async () => {
    const session = ensureSession(req, res, sessions);
    const current = session.config || {};
    const apiKey = String(req.body.apiKey || '').trim() || current.apiKey;
    const model = String(req.body.model || '').trim();
    if (!apiKey) throw httpError(400, '请填写 API Key');
    if (!model) throw httpError(400, '请填写或选择 Seedance 模型名称');

    const endpoints = normalizeGatewayUrl(req.body.url);
    session.config = { ...endpoints, apiKey, model };
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    res.json({ ok: true, config: publicConfig(session.config) });
  }));

  app.post('/api/models/discover', (req, res) => safe(res, async () => {
    const session = requireConfiguredSession(req, sessions);
    const result = await upstreamJson(fetchImpl, session.config.modelsUrl, {
      method: 'GET',
      apiKey: session.config.apiKey,
      logger
    });
    const models = normalizeModelList(result.data);
    if (!models.length) throw httpError(502, '模型列表为空或平台返回格式无法识别');
    res.json({ ok: true, models, durationMs: result.durationMs });
  }));

  app.post('/api/video/tasks', (req, res) => safe(res, async () => {
    const session = requireConfiguredSession(req, sessions);
    const payload = buildVideoPayload({ ...req.body, model: req.body.model || session.config.model });
    const result = await upstreamJson(fetchImpl, session.config.submitUrl, {
      method: 'POST',
      apiKey: session.config.apiKey,
      body: payload,
      asyncVideo: true,
      logger
    });
    const normalized = normalizeTaskResponse(result.data);
    if (!normalized.remoteTaskId) throw httpError(502, '平台已响应，但没有返回 task_id');

    const task = {
      id: normalized.remoteTaskId,
      prompt: payload.content?.find((item) => item.type === 'text')?.text || payload.input?.prompt,
      model: payload.model,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      durationMs: result.durationMs,
      ...normalized
    };
    session.tasks.set(task.id, task);
    res.status(201).json({ task });
  }));

  app.get('/api/video/tasks/:taskId', (req, res) => safe(res, async () => {
    const session = requireConfiguredSession(req, sessions);
    const task = session.tasks.get(req.params.taskId);
    if (!task) throw httpError(404, '当前会话中没有这个任务，请重新提交');
    if (isTerminalStatus(task.status)) return res.json({ task });

    const url = `${session.config.queryBaseUrl}/${encodeURIComponent(task.id)}`;
    const result = await upstreamJson(fetchImpl, url, {
      method: 'GET',
      apiKey: session.config.apiKey,
      logger
    });
    const normalized = normalizeTaskResponse(result.data);
    const next = {
      ...task,
      ...normalized,
      id: task.id,
      remoteTaskId: normalized.remoteTaskId || task.remoteTaskId,
      updatedAt: new Date().toISOString(),
      pollDurationMs: result.durationMs
    };
    session.tasks.set(task.id, next);
    res.json({ task: next });
  }));

  if (staticDir) {
    app.use(express.static(staticDir));
    app.use((req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      return res.sendFile(path.join(staticDir, 'index.html'));
    });
  }

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { message: '接口不存在' } });
  });

  app.use((error, _req, res, _next) => {
    const status = error.status || 500;
    res.status(status).json({
      error: {
        message: error.publicMessage || (status < 500 ? error.message : '服务暂时不可用，请稍后重试'),
        code: error.code,
        upstreamStatus: error.upstreamStatus,
        requestId: error.requestId
      }
    });
  });

  return app;
}

async function upstreamJson(fetchImpl, url, { method, apiKey, body, asyncVideo = false, logger = console }) {
  const started = Date.now();
  let response;
  logger.info?.('[tokenhub] request', {
    method,
    url: diagnosticUrl(url),
    contentType: body ? 'application/json' : undefined,
    bodyFields: body ? Object.keys(body) : []
  });
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(asyncVideo ? { 'X-DashScope-Async': 'enable' } : {}),
        Authorization: `Bearer ${apiKey}`
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000)
    });
  } catch (error) {
    logger.error?.('[tokenhub] network failure', {
      method,
      url: diagnosticUrl(url),
      error: error?.name || 'Error',
      durationMs: Date.now() - started
    });
    const message = error?.name === 'TimeoutError' ? 'TokenHub 请求超时' : '无法连接 TokenHub，请检查 URL 和网络';
    throw httpError(502, message);
  }

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text.slice(0, 500) };
  }
  const requestId = data?.request_id || data?.requestId || response.headers.get('x-request-id') || undefined;
  logger.info?.('[tokenhub] response', {
    method,
    url: diagnosticUrl(url),
    status: response.status,
    code: data?.error?.code || data?.code,
    requestId,
    durationMs: Date.now() - started
  });
  if (!response.ok) {
    const message = redactSecret(data?.error?.message || data?.message || `TokenHub 返回 ${response.status}`, apiKey);
    const publicMessage = /Model not found or invalid request path/i.test(String(message))
      ? '当前生成 URL 未开放这个模型。请从 TokenHub 模型详情复制 Seedance 专用调用地址，或联系平台管理员绑定视频生成路由。'
      : String(message);
    const error = httpError(response.status >= 500 ? 502 : response.status, publicMessage);
    error.upstreamStatus = response.status;
    error.code = data?.error?.code || data?.code;
    error.requestId = requestId;
    throw error;
  }
  return { data, durationMs: Date.now() - started };
}

function diagnosticUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return 'invalid-url';
  }
}

function redactSecret(value, secret) {
  const text = String(value || '');
  return secret ? text.split(secret).join('[REDACTED]') : text;
}

function ensureSession(req, res, sessions) {
  let session = getSession(req, sessions);
  if (session) return session;
  const id = crypto.randomUUID();
  session = { id, config: null, tasks: new Map(), expiresAt: Date.now() + SESSION_TTL_MS };
  sessions.set(id, session);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
  return session;
}

function getSession(req, sessions) {
  const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';')
    .map((item) => item.trim().split('='))
    .filter(([key, value]) => key && value));
  const session = sessions.get(cookies[SESSION_COOKIE]);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(session.id);
    return null;
  }
  return session;
}

function requireConfiguredSession(req, sessions) {
  const session = getSession(req, sessions);
  if (!session?.config) throw httpError(401, '配置已失效，请重新填写 URL、API Key 和模型名称');
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function publicConfig(config) {
  return {
    submitUrl: config.submitUrl,
    modelsUrl: config.modelsUrl,
    model: config.model,
    apiKeyMasked: `••••${config.apiKey.slice(-4)}`
  };
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.publicMessage = message;
  return error;
}

async function safe(res, fn) {
  try {
    await fn();
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({
      error: {
        message: error.publicMessage || (status < 500 ? error.message : '服务暂时不可用，请稍后重试'),
        code: error.code,
        upstreamStatus: error.upstreamStatus,
        requestId: error.requestId
      }
    });
  }
}
