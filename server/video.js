const TERMINAL_STATES = new Set(['SUCCEEDED', 'FAILED', 'UNKNOWN']);
const SEEDANCE_RATIOS = new Set(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive']);
const MINI_RESOLUTIONS = new Set(['480p', '720p']);

export function normalizeGatewayUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('请填写文生视频 URL');

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('文生视频 URL 格式不正确');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('文生视频 URL 只支持 http 或 https');
  }

  url.search = '';
  url.hash = '';
  let path = url.pathname.replace(/\/+$/, '');
  if (!path) path = '/v1';

  if (!/\/videos\/generations$/i.test(path)) {
    if (/\/v1$/i.test(path)) path += '/videos/generations';
    else if (path === '/') path = '/v1/videos/generations';
    else path += '/v1/videos/generations';
  }

  url.pathname = path;
  const submitUrl = url.toString().replace(/\/$/, '');
  const modelsUrl = submitUrl.replace(/\/videos\/generations$/i, '/models');
  return {
    submitUrl,
    queryBaseUrl: `${submitUrl}/task`,
    modelsUrl
  };
}

export function buildVideoPayload(input) {
  const prompt = String(input.prompt || '').trim();
  const model = String(input.model || '').trim();
  if (!prompt) throw new Error('请输入视频提示词');
  if (!model) throw new Error('请填写或选择 Seedance 模型名称');

  const duration = optionalInteger(input.duration, '视频时长');

  if (/seedance/i.test(model)) {
    const legacySize = parseSeedanceSize(input.size);
    const resolution = normalizeResolution(input.resolution || legacySize.resolution);
    const ratio = String(input.ratio || legacySize.ratio || '').trim() || undefined;

    if (ratio && !SEEDANCE_RATIOS.has(ratio)) {
      throw new Error(`Seedance 不支持画面比例 ${ratio}`);
    }
    if (/doubao-seedance-2-0-mini-260615/i.test(model)) {
      if (resolution && !MINI_RESOLUTIONS.has(resolution)) {
        throw new Error('Seedance 2.0 Mini 只支持 480p 或 720p');
      }
      if (duration !== undefined && (duration < 4 || duration > 15)) {
        throw new Error('Seedance 2.0 Mini 视频时长必须在 4–15 秒之间');
      }
    } else if (duration !== undefined && duration <= 0) {
      throw new Error('视频时长必须大于 0');
    }

    return cleanObject({
      model,
      content: [{ type: 'text', text: prompt }],
      resolution,
      ratio,
      duration,
      generate_audio: optionalBoolean(input.generateAudio, '生成音频'),
      watermark: optionalBoolean(input.watermark, '水印')
    });
  }

  const seed = optionalInteger(input.seed, '随机种子');
  if (duration !== undefined && duration <= 0) throw new Error('视频时长必须大于 0');
  if (seed !== undefined && seed < 0) throw new Error('随机种子不能小于 0');

  return cleanObject({
    model,
    input: cleanObject({
      prompt,
      negative_prompt: String(input.negativePrompt || '').trim() || undefined
    }),
    parameters: cleanObject({
      size: String(input.size || '').trim() || undefined,
      duration,
      watermark: Boolean(input.watermark),
      seed
    })
  });
}

function parseSeedanceSize(value) {
  const size = String(value || '').trim();
  const match = size.match(/^(\d+)\s*[x*×]\s*(\d+)$/i);
  if (!match) return { resolution: size || undefined };

  const width = Number(match[1]);
  const height = Number(match[2]);
  const divisor = greatestCommonDivisor(width, height);
  const exactRatio = `${width / divisor}:${height / divisor}`;
  const supportedRatios = new Set(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);
  const ratio = supportedRatios.has(exactRatio) ? exactRatio : undefined;
  const shortEdge = Math.min(width, height);
  const resolution = shortEdge >= 1080 ? '1080p' : shortEdge >= 720 ? '720p' : shortEdge >= 480 ? '480p' : `${shortEdge}p`;
  return { ratio, resolution };
}

function normalizeResolution(value) {
  const resolution = String(value || '').trim();
  const match = resolution.match(/^(480|720|1080)p$/i);
  return match ? `${match[1]}p` : resolution || undefined;
}

function greatestCommonDivisor(left, right) {
  let a = left;
  let b = right;
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

export function normalizeTaskResponse(data) {
  const output = data?.output || data?.data || data?.result || {};
  const content = output?.content || data?.content || {};
  const rawStatus = output.task_status ?? output.status ?? data?.task_status ?? data?.status ?? 'UNKNOWN';
  const status = normalizeStatus(rawStatus);
  return cleanObject({
    remoteTaskId: output.task_id ?? data?.task_id ?? data?.id,
    status,
    videoUrl: output.video_url ?? output.url ?? data?.video_url ?? content?.video_url ?? content?.videoUrl,
    code: output.code ?? data?.code ?? data?.error?.code,
    message: output.message ?? data?.message ?? data?.error?.message,
    requestId: data?.request_id,
    model: data?.model,
    usage: data?.usage,
    submitTime: output.submit_time,
    scheduledTime: output.scheduled_time,
    endTime: output.end_time
  });
}

export function isTerminalStatus(status) {
  return TERMINAL_STATES.has(normalizeStatus(status));
}

export function normalizeStatus(value) {
  const status = String(value || '').toUpperCase();
  if (['PENDING', 'QUEUED', 'CREATED'].includes(status)) return 'PENDING';
  if (['RUNNING', 'PROCESSING', 'IN_PROGRESS'].includes(status)) return 'RUNNING';
  if (['SUCCEEDED', 'SUCCESS', 'COMPLETED', 'DONE'].includes(status)) return 'SUCCEEDED';
  if (['FAILED', 'FAILURE', 'ERROR', 'CANCELLED'].includes(status)) return 'FAILED';
  return 'UNKNOWN';
}

export function normalizeModelList(data) {
  const source = Array.isArray(data) ? data : data?.data || data?.models || data?.items || [];
  return [...new Set(source.map((item) => typeof item === 'string' ? item : item?.id || item?.name).filter(Boolean))];
}

function optionalInteger(value, label) {
  if (value === '' || value === null || value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`${label}必须是整数`);
  return number;
}

function optionalBoolean(value, label) {
  if (value === '' || value === null || value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${label}必须是布尔值`);
}

function cleanObject(value) {
  if (Array.isArray(value)) return value.map(cleanObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined && item !== '')
    .map(([key, item]) => [key, cleanObject(item)]));
}
