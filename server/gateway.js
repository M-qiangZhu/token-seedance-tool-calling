import { publicError } from './security.js';

export async function upstreamJson(fetchImpl, url, { method, apiKey, body, asyncVideo = false, logger = console }) {
  const started = Date.now();
  let response;
  logger.info?.('[tokenhub] request', {
    method, url: diagnosticUrl(url), contentType: body ? 'application/json' : undefined,
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
    logger.error?.('[tokenhub] network failure', { method, url: diagnosticUrl(url), error: error?.name || 'Error', durationMs: Date.now() - started });
    const message = error?.name === 'TimeoutError' ? 'TokenHub 请求超时' : '无法连接 TokenHub，请检查 URL 和网络';
    const wrapped = publicError(502, message, 'UPSTREAM_NETWORK');
    wrapped.ambiguousSubmission = method === 'POST';
    throw wrapped;
  }

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text.slice(0, 500) }; }
  const requestId = data?.request_id || data?.requestId || response.headers.get('x-request-id') || undefined;
  logger.info?.('[tokenhub] response', {
    method, url: diagnosticUrl(url), status: response.status,
    code: data?.error?.code || data?.code, requestId, durationMs: Date.now() - started
  });
  if (!response.ok) {
    const message = redactSecret(data?.error?.message || data?.message || `TokenHub 返回 ${response.status}`, apiKey);
    const publicMessage = /Model not found or invalid request path/i.test(String(message))
      ? '当前生成 URL 未开放这个模型，请检查模型权限和生成地址。' : String(message);
    const error = publicError(response.status >= 500 ? 502 : response.status, publicMessage, data?.error?.code || data?.code);
    error.upstreamStatus = response.status;
    error.requestId = requestId;
    error.retryAfter = Number(response.headers.get('retry-after')) || undefined;
    throw error;
  }
  return { data, durationMs: Date.now() - started, requestId };
}

function diagnosticUrl(value) {
  try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return 'invalid-url'; }
}

function redactSecret(value, secret) {
  const text = String(value || '');
  return secret ? text.split(secret).join('[REDACTED]') : text;
}
