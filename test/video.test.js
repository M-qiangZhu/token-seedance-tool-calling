import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildVideoPayload,
  normalizeGatewayUrl,
  normalizeModelList,
  normalizeTaskResponse
} from '../server/video.js';
import { calculateCost, supportedModels } from '../server/models.js';

test('规范化 Base URL 和完整生成 URL', () => {
  assert.deepEqual(normalizeGatewayUrl('https://example.com/v1'), {
    submitUrl: 'https://example.com/v1/videos/generations',
    queryBaseUrl: 'https://example.com/v1/videos/generations/task',
    modelsUrl: 'https://example.com/v1/models'
  });
  assert.equal(normalizeGatewayUrl('https://example.com/v1/videos/generations/').submitUrl, 'https://example.com/v1/videos/generations');
});

test('为 Seedance Mini 构造 JSON content[] 原生请求', () => {
  const payload = buildVideoPayload({
    model: 'doubao-seedance-2-0-mini-260615',
    prompt: '  一只猫  ',
    resolution: '720P',
    ratio: '16:9',
    duration: '5',
    generateAudio: false,
    watermark: false,
    negativePrompt: '不应发送',
    seed: 42
  });
  assert.deepEqual(payload, {
    model: 'doubao-seedance-2-0-mini-260615',
    content: [{ type: 'text', text: '一只猫' }],
    resolution: '720p',
    ratio: '16:9',
    duration: 5,
    generate_audio: false,
    watermark: false
  });
  for (const field of ['prompt', 'input', 'parameters', 'negative_prompt', 'seed']) {
    assert.equal(Object.hasOwn(payload, field), false);
  }
});

test('Seedance 兼容旧 size 字段，显式参数优先', () => {
  assert.deepEqual(buildVideoPayload({
    model: 'doubao-seedance-2-0-mini-260615', prompt: '一只猫', size: '720*1280', duration: 4
  }), {
    model: 'doubao-seedance-2-0-mini-260615',
    content: [{ type: 'text', text: '一只猫' }],
    resolution: '720p',
    ratio: '9:16',
    duration: 4
  });
  assert.equal(buildVideoPayload({
    model: 'doubao-seedance-2-0-mini-260615', prompt: '一只猫', size: '720*1280', resolution: '480p', ratio: '1:1', duration: 15
  }).resolution, '480p');
});

test('Seedance Mini 严格校验分辨率、时长和比例', () => {
  const base = { model: 'doubao-seedance-2-0-mini-260615', prompt: '测试' };
  assert.doesNotThrow(() => buildVideoPayload({ ...base, resolution: '480p', duration: 4, ratio: '16:9' }));
  assert.doesNotThrow(() => buildVideoPayload({ ...base, resolution: '720p', duration: 15, ratio: 'adaptive' }));
  assert.throws(() => buildVideoPayload({ ...base, resolution: '1080p', duration: 5 }), /480p 或 720p/);
  assert.throws(() => buildVideoPayload({ ...base, resolution: '720p', duration: 3 }), /4–15/);
  assert.throws(() => buildVideoPayload({ ...base, resolution: '720p', duration: 16 }), /4–15/);
  assert.throws(() => buildVideoPayload({ ...base, resolution: '720p', duration: 5, ratio: '2:1' }), /不支持画面比例/);
});

test('Standard仅接受1080p与4K，Fast仅接受480p与720p', () => {
  const standard = { model: 'doubao-seedance-2-0-260128', prompt: '测试', duration: 5, ratio: '16:9' };
  assert.equal(buildVideoPayload({ ...standard, resolution: '4K' }).resolution, '4k');
  assert.equal(buildVideoPayload({ ...standard, resolution: '1080P' }).resolution, '1080p');
  assert.throws(() => buildVideoPayload({ ...standard, resolution: '720p' }), /1080p 或 4k/);
  const fast = { ...standard, model: 'doubao-seedance-2-0-fast-260128' };
  assert.doesNotThrow(() => buildVideoPayload({ ...fast, resolution: '480p' }));
  assert.throws(() => buildVideoPayload({ ...fast, resolution: '4k' }), /480p 或 720p/);
});

test('只返回completion_tokens或total_tokens时都能精确计算费用', () => {
  assert.deepEqual(calculateCost({ completion_tokens: 108900, total_tokens: 108900 }, { inputRate: 0, outputRate: 23, currency: 'CNY' }), {
    promptTokens: 0, completionTokens: 108900, totalTokens: 108900, inputCost: 0, outputCost: 2.5047, totalCost: 2.5047, currency: 'CNY'
  });
  assert.equal(calculateCost({ total_tokens: 1000 }, { inputRate: 0, outputRate: 51 }).totalCost, 0.051);
  assert.equal(calculateCost({}, { inputRate: 1, outputRate: 51 }), null);
});

test('模型发现只保留三个受支持的精确模型ID', () => {
  assert.deepEqual(supportedModels(['wan', 'doubao-seedance-2-0-fast-260128', 'seedance-other', 'doubao-seedance-2-0-mini-260615']), [
    'doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-mini-260615'
  ]);
});

test('为 Wan 等文档模型保留 input.prompt 统一结构', () => {
  assert.deepEqual(buildVideoPayload({
    model: 'wan2.6-t2v', prompt: '一只猫', size: '1280*720', duration: '5', watermark: false
  }), {
    model: 'wan2.6-t2v',
    input: { prompt: '一只猫' },
    parameters: { size: '1280*720', duration: 5, watermark: false }
  });
});

test('规范化任务状态和模型列表', () => {
  assert.deepEqual(normalizeTaskResponse({ output: { task_id: 'task-1', task_status: 'processing' } }), {
    remoteTaskId: 'task-1', status: 'RUNNING'
  });
  assert.deepEqual(normalizeTaskResponse({
    id: 'ark-1', status: 'succeeded', content: { video_url: 'https://cdn.example/ark.mp4' }
  }), {
    remoteTaskId: 'ark-1', status: 'SUCCEEDED', videoUrl: 'https://cdn.example/ark.mp4'
  });
  assert.deepEqual(normalizeModelList({ data: [{ id: 'seedance-a' }, { id: 'seedance-a' }, { id: 'wan-t2v' }] }), ['seedance-a', 'wan-t2v']);
});

test('拒绝缺失提示词和非整数参数', () => {
  assert.throws(() => buildVideoPayload({ model: 'seedance', prompt: '' }), /提示词/);
  assert.throws(() => buildVideoPayload({ model: 'seedance', prompt: '测试', duration: '1.5' }), /整数/);
  assert.throws(() => buildVideoPayload({ model: 'seedance', prompt: '测试', generateAudio: 'yes' }), /布尔值/);
});
