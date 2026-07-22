export const MODEL_CAPABILITIES = Object.freeze({
  'doubao-seedance-2-0-260128': {
    label: 'Seedance 2.0 Standard', resolutions: ['480p', '720p', '1080p', '4k'], defaultResolution: '1080p'
  },
  'doubao-seedance-2-0-fast-260128': {
    label: 'Seedance 2.0 Fast', resolutions: ['480p', '720p'], defaultResolution: '720p'
  },
  'doubao-seedance-2-0-mini-260615': {
    label: 'Seedance 2.0 Mini', resolutions: ['480p', '720p'], defaultResolution: '720p'
  }
});

export const DEFAULT_PRICES = Object.freeze([
  price('doubao-seedance-2-0-260128', '480p', 0, 51),
  price('doubao-seedance-2-0-260128', '720p', 0, 51),
  price('doubao-seedance-2-0-260128', '1080p', 0, 51),
  price('doubao-seedance-2-0-260128', '4k', 0, 26),
  price('doubao-seedance-2-0-fast-260128', '480p', 0, 37),
  price('doubao-seedance-2-0-fast-260128', '720p', 0, 37),
  price('doubao-seedance-2-0-mini-260615', '480p', 0, 23),
  price('doubao-seedance-2-0-mini-260615', '720p', 0, 23)
]);

export function supportedModels(models) {
  return [...new Set(models)].filter((model) => Object.hasOwn(MODEL_CAPABILITIES, model));
}

export function modelDescriptor(id) {
  const capabilities = MODEL_CAPABILITIES[id];
  return capabilities ? { id, ...capabilities, duration: { min: 4, max: 15 } } : null;
}

export function validateModelParameters(model, resolution, duration) {
  const descriptor = modelDescriptor(model);
  if (!descriptor) throw new Error('当前版本不支持这个 Seedance 模型');
  const normalizedResolution = String(resolution || '').toLowerCase();
  if (!descriptor.resolutions.includes(normalizedResolution)) {
    throw new Error(`${descriptor.label} 仅支持 ${descriptor.resolutions.join(' 或 ')}`);
  }
  const seconds = Number(duration);
  if (!Number.isInteger(seconds) || seconds < 4 || seconds > 15) {
    throw new Error('Seedance 视频时长必须是 4–15 秒的整数');
  }
  return { descriptor, resolution: normalizedResolution, duration: seconds };
}

export function calculateCost(usage, pricing) {
  if (!usage || !pricing) return null;
  const promptTokens = nonNegativeNumber(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  let completionTokens = nonNegativeNumber(usage.completion_tokens ?? usage.output_tokens);
  const totalTokens = nonNegativeNumber(usage.total_tokens);
  const inputRate = nonNegativeNumber(pricing.inputRate ?? pricing.input_rate);
  const outputRate = nonNegativeNumber(pricing.outputRate ?? pricing.output_rate);
  const discountRate = discountNumber(pricing.discountRate ?? pricing.discount_rate ?? 1);

  if (completionTokens === null && totalTokens !== null && inputRate === 0) completionTokens = totalTokens;
  if (completionTokens === null) return null;

  const safePrompt = promptTokens ?? 0;
  const inputCost = safePrompt * inputRate / 1_000_000;
  const outputCost = completionTokens * outputRate / 1_000_000;
  const originalTotalCost = inputCost + outputCost;
  return {
    promptTokens: safePrompt,
    completionTokens,
    totalTokens: totalTokens ?? safePrompt + completionTokens,
    inputCost: money(inputCost),
    outputCost: money(outputCost),
    originalTotalCost: money(originalTotalCost),
    discountRate,
    totalCost: money(originalTotalCost * discountRate),
    currency: pricing.currency || 'CNY'
  };
}

function price(model, resolution, inputRate, outputRate) {
  return { model, resolution, inputRate, outputRate, currency: 'CNY', version: 1 };
}

function nonNegativeNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function discountNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : 1;
}

function money(value) {
  return Number(value.toFixed(6));
}
